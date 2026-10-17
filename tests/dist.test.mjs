// Checks the real build (`npm install` runs `prepare`, which writes
// frontend/dist): it is what the CSP actually meets, and what the backend serves.
// Fails rather than skips when the UI is unbuilt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createServer } from '../server.js';
import { CSP, DEFAULT_DIST } from '../src/webui.js';
import { headTags } from './_frontendFiles.mjs';
import { fakeCloudflaredBin, fakeTailscaleBin, mkRoot, rmRoot } from './helpers.mjs';

process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;

const indexPath = path.join(DEFAULT_DIST, 'index.html');
const built = existsSync(indexPath);
const files = [];
const walk = (rel) => {
  for (const e of readdirSync(path.join(DEFAULT_DIST, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(r); else files.push(r);
  }
};
if (built) walk('');
const html = built ? readFileSync(indexPath, 'utf8') : '';
const read = (rel) => readFileSync(path.join(DEFAULT_DIST, rel), 'utf8');
const HOST = ['/pluginBridge.js', '/pluginTheme.css'];
const refs = () => [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
const TYPES = { js: /^(?:text|application)\/javascript/, css: /^text\/css/, webmanifest: /^application\/manifest\+json/, svg: /^image\/svg\+xml/ };

// Invariant: the UI is built (by `npm install`).
test('frontend/dist/index.html exists', () => {
  assert.ok(built, `${indexPath} is missing — run npm install`);
});

// Invariant: the build holds the bundles, theme-init.js and the PWA files at its root, and no source maps.
test('dist holds the bundles, theme-init.js, the manifest and the icon, and no .map files', () => {
  assert.ok(files.some((f) => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(f)), 'a JS bundle');
  assert.ok(files.some((f) => /^assets\/index-[A-Za-z0-9_-]+\.css$/.test(f)), 'a CSS bundle');
  for (const f of ['theme-init.js', 'manifest.webmanifest', 'icon.svg']) assert.ok(files.includes(f), f);
  assert.deepEqual(files.filter((f) => f.endsWith('.map')), []);
});

// Invariant: the built page has no inline script or style, only relative URLs besides the two host URLs,
// relative PWA links, and the head order kept.
test('built index.html: no inline script/style, relative URLs, head order kept', () => {
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'inline <script>');
  assert.equal(/<style[\s>]/.test(html), false, '<style>');
  assert.equal(/\sstyle\s*=/.test(html), false, 'style=');
  for (const u of refs()) {
    if (HOST.includes(u)) continue;
    assert.ok(!/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(u), `not relative: ${u}`);
  }
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /<link rel="icon" href="icon\.svg"/);
  const order = headTags(html)
    .filter((t) => t.tag === 'script' || (t.tag === 'link' && /rel="stylesheet"/.test(t.attrs)))
    .map((t) => t.attrs.match(/(?:src|href)="([^"]+)"/)[1]);
  assert.deepEqual(order.slice(0, 3), ['/pluginBridge.js', '/pluginTheme.css', 'theme-init.js']);
  assert.match(order[3], /^\.\/assets\/index-[A-Za-z0-9_-]+\.js$/);
});

// Invariant: the CSS loads nothing off-origin and no data: URL; the JS calls no root-relative API.
test('built CSS and JS reference nothing off-limits', () => {
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/url\(\s*['"]?data:/i.test(css), false, `${f}: url(data:`);
    assert.equal(/https?:\/\//i.test(css), false, `${f}: absolute URL`);
  }
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    assert.equal(/["'`]\/api\//.test(read(f)), false, `${f}: root-relative /api/`);
  }
});

// Invariant: Tailwind compiled the width cap and the card grid, so a bracket-syntax slip can't silently drop them.
test('built CSS holds the session-width cap and the card grid columns', () => {
  const css = files.filter((f) => /^assets\/index-.*\.css$/.test(f))
    .map((f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
  assert.match(css, /max-width:\s*var\(--cc-session-width,\s*42rem\)/);
  assert.match(css, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(36rem,\s*100%\),\s*1fr\)\)/);
});

// Invariant: the backend serves the real build: / and every local file it references, with type and CSP.
test('the server serves the built page and its assets', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const server = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => server.close(res)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), CSP);
  assert.equal(await r.text(), html);
  const local = refs().filter((u) => !HOST.includes(u));
  assert.ok(local.length >= 5, local.join(', '));
  for (const u of local) {
    const a = await fetch(new URL(u, `${base}/`));
    assert.equal(a.status, 200, u);
    assert.match(a.headers.get('content-type'), TYPES[u.split('.').pop()], u);
    assert.equal(a.headers.get('content-security-policy'), CSP, u);
  }
});
