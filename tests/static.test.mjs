import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { mkRoot, rmRoot } from './helpers.mjs';

test('serves the static frontend', async (t) => {
  const root = await mkRoot();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await rmRoot(root); });

  for (const [path, type] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'javascript']]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, `${path} status`);
    assert.match(r.headers.get('content-type') || '', new RegExp(type), `${path} content-type`);
    assert.match(r.headers.get('cache-control') || '', /no-store/, `${path} cache-control`);
  }

  // index.html carries cache-busting version queries on its local asset refs.
  // Refs are relative (no leading slash) so the page works both standalone
  // and mounted under a code-conductor plugin prefix.
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /href="styles\.css\?v=\d+"/, 'styles.css cache-bust');
  assert.match(html, /src="app\.js\?v=\d+"/, 'app.js cache-bust');

  // pluginBridge.js stays absolute (served by the conductor, not code-hub)
  // and isn't cache-busted since it isn't a local file.
  assert.match(html, /src="\/pluginBridge\.js" defer/, 'pluginBridge.js tag stays absolute');
});
