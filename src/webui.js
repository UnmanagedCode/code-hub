import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The built UI: `npm install` runs `prepare`, which builds frontend/ into here.
export const DEFAULT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'dist');

// Each directive beyond the minimum is explained in docs/protocol.md ("UI serving & headers").
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

const NOT_BUILT = 'UI not built — run npm install';

// First middleware, so every response carries them: the API's, the 404, the 503 and errors.
export function securityHeaders(_req, res, next) {
  res.set({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
  next();
}

// The built files, or a plain-text 503 on every UI path while index.html is
// missing. The check runs per request, so a build finished while the backend
// runs is served without a restart. No SPA fallback: an unknown path falls
// through to the terminal 404.
export function mountUi(app, distDir) {
  const index = path.join(distDir, 'index.html');
  if (!fs.existsSync(index)) console.error(`UI not built: ${index} is missing — run npm install`);
  app.use((_req, res, next) => {
    if (fs.existsSync(index)) return next();
    res.status(503).type('text/plain').send(NOT_BUILT);
  });
  // Vite hashes the bundle names, so revalidating every load is enough to pick up a rebuild.
  app.use(express.static(distDir, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
}

// Plain-text terminal handlers: Express's own pages would replace the CSP. An
// error's message is never echoed — it can carry a filesystem path.
export function terminalHandlers(app) {
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const raw = err?.status ?? err?.statusCode;
    const status = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
    if (status === 500) console.error(err);
    res.status(status).type('text/plain').send(status === 500 ? 'Internal error' : (http.STATUS_CODES[status] ?? 'Error'));
  });
}
