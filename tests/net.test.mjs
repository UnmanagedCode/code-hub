import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { allocatePort, enumerateUrls, routeUrls, waitForPort } from '../src/net.js';

test('allocatePort returns a bindable, currently-unused port', async () => {
  const port = await allocatePort();
  assert.ok(port > 0 && port < 65536);
  // We should be able to bind it right after (it was released).
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => s.close(resolve));
  });
});

test('enumerateUrls emits a single localhost loopback (no 127.0.0.1 dup)', () => {
  const urls = enumerateUrls(1234);
  assert.ok(urls.includes('http://localhost:1234'));
  assert.ok(!urls.includes('http://127.0.0.1:1234'));
  assert.ok(urls.every((u) => /^http:\/\/[^/]+:1234$/.test(u)));
});

test('routeUrls for "/" equals the clean base URLs', () => {
  assert.deepEqual(routeUrls(1234, '/'), enumerateUrls(1234));
});

test('routeUrls appends a non-root path to every base', () => {
  const urls = routeUrls(1234, '/terrain-editor.html');
  assert.ok(urls.includes('http://localhost:1234/terrain-editor.html'));
  assert.ok(urls.every((u) => u.endsWith('/terrain-editor.html')));
  assert.equal(urls.length, enumerateUrls(1234).length);
});

test('waitForPort resolves once something is listening, rejects otherwise', async () => {
  const port = await allocatePort();
  await assert.rejects(waitForPort(port, { timeoutMs: 300, intervalMs: 50 }));

  const srv = net.createServer();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  await waitForPort(port, { timeoutMs: 1000 });
  await new Promise((r) => srv.close(r));
});
