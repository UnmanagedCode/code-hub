import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoutes } from './src/routes.js';
import * as appManager from './src/appManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Render index.html at request time, appending `?v=<mtime-ms>` to every local
// asset ref so a changed public/ file always yields a new URL — no manual
// cache clear needed on the client. Combined with no-store below, this
// guarantees the freshest CSS/JS reaches the phone.
function renderIndex() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  return html.replace(/\b(href|src)="(\/[^"?]+)"/g, (m, attr, ref) => {
    try {
      const v = Math.floor(fs.statSync(path.join(PUBLIC_DIR, ref)).mtimeMs);
      return `${attr}="${ref}?v=${v}"`;
    } catch {
      return m; // not a local file we can stat — leave untouched
    }
  });
}

export function createServer() {
  const app = express();
  app.use('/api', buildRoutes());

  const sendIndex = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderIndex());
  };
  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);

  // Static assets: never cache — the client always revalidates.
  app.use(express.static(PUBLIC_DIR, {
    index: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  }));
  return http.createServer(app);
}

// listen with retry-on-EADDRINUSE — mirrors code-conductor: a just-restarted
// instance may find the old listening socket lingering for a moment.
function listenWithRetry(server, port, host, { tries = 40, delayMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const onErr = (e) => {
        server.off('listening', onOk);
        if (e.code === 'EADDRINUSE' && left > 0) setTimeout(() => attempt(left - 1), delayMs);
        else reject(e);
      };
      const onOk = () => { server.off('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    };
    attempt(tries);
  });
}

export async function start({ port = Number(process.env.PORT) || 7000, host = process.env.HOST || '127.0.0.1' } = {}) {
  await appManager.init(); // reconcile persisted running-apps against live pids
  const server = createServer();
  await listenWithRetry(server, port, host);
  const addr = server.address();
  // eslint-disable-next-line no-console
  console.log(`code-hub listening on http://${host}:${addr.port}`);
  return server;
}

// Direct-run guard: only auto-start when invoked as `node server.js`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
