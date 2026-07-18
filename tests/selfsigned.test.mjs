import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import crypto from 'node:crypto';
import { generateSelfSigned } from '../src/selfsigned.js';

test('produces a parseable self-signed cert with the requested SAN entries', () => {
  const { key, cert } = generateSelfSigned({ ipAddresses: ['192.168.1.50', '127.0.0.1'], dnsNames: ['localhost'] });
  assert.match(cert, /^-----BEGIN CERTIFICATE-----/);
  assert.match(key, /^-----BEGIN PRIVATE KEY-----/);

  const x = new crypto.X509Certificate(cert);
  assert.match(x.subject, /code-hub LAN/);
  assert.equal(x.subject, x.issuer); // self-signed
  assert.match(x.subjectAltName, /DNS:localhost/);
  assert.match(x.subjectAltName, /IP Address:192\.168\.1\.50/);
  assert.match(x.subjectAltName, /IP Address:127\.0\.0\.1/);

  // Currently within its validity window (notBefore is skewed 1h into the past).
  assert.ok(new Date(x.validFrom) <= new Date());
  assert.ok(new Date(x.validTo) > new Date());
});

test('key and cert actually work in an https server', async (t) => {
  const { key, cert } = generateSelfSigned({ ipAddresses: ['127.0.0.1'], dnsNames: ['localhost'] });
  const server = https.createServer({ key, cert }, (req, res) => { res.writeHead(200); res.end('secure ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const body = await new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port: server.address().port, path: '/', rejectUnauthorized: false },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b)); },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(body, 'secure ok');
});

test('generates a fresh keypair per call', () => {
  const a = generateSelfSigned({ ipAddresses: ['127.0.0.1'] });
  const b = generateSelfSigned({ ipAddresses: ['127.0.0.1'] });
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.cert, b.cert);
});
