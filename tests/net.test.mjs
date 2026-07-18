import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import cp from 'node:child_process';
import { allocatePort, enumerateUrls, routeUrls, waitForPort, parseLanIPv4s, localIPv4s } from '../src/net.js';

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

test('enumerateUrls with scheme:"https" emits https:// URLs (LAN TLS)', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ONE_NON_INTERNAL_IFACE);
  const urls = enumerateUrls(1234, { scheme: 'https' });
  assert.deepEqual(urls, ['https://localhost:1234', 'https://10.0.0.5:1234']);
});

test('localIPv4s returns an array of non-internal IPv4s (empty when none visible)', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ONE_NON_INTERNAL_IFACE);
  assert.deepEqual(localIPv4s(), ['10.0.0.5']);
  t.mock.method(os, 'networkInterfaces', () => NO_NON_INTERNAL_IFACES);
  t.mock.method(cp, 'execFileSync', () => { throw new Error('must not shell out without lanFallback'); });
  assert.deepEqual(localIPv4s(), []);
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

const NO_NON_INTERNAL_IFACES = { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] };
const ONE_NON_INTERNAL_IFACE = { eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }] };
const FAKE_IFCONFIG_OUTPUT = 'wlan0: flags=UP\n        inet 192.168.9.9  netmask 255.255.255.0\n';

test('enumerateUrls without lanFallback stays localhost-only when no interface is visible, and never shells out', (t) => {
  t.mock.method(os, 'networkInterfaces', () => NO_NON_INTERNAL_IFACES);
  t.mock.method(cp, 'execFileSync', () => { throw new Error('must not shell out without lanFallback'); });
  assert.deepEqual(enumerateUrls(1234), ['http://localhost:1234']);
});

test('enumerateUrls with lanFallback:true shells out when no interface is visible', (t) => {
  t.mock.method(os, 'networkInterfaces', () => NO_NON_INTERNAL_IFACES);
  t.mock.method(cp, 'execFileSync', () => FAKE_IFCONFIG_OUTPUT);
  const urls = enumerateUrls(1234, { lanFallback: true });
  assert.ok(urls.includes('http://192.168.9.9:1234'));
});

test('enumerateUrls with lanFallback:true skips the shell-out when os.networkInterfaces already finds an address', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ONE_NON_INTERNAL_IFACE);
  t.mock.method(cp, 'execFileSync', () => { throw new Error('must not shell out when an interface is already visible'); });
  const urls = enumerateUrls(1234, { lanFallback: true });
  assert.deepEqual(urls, ['http://localhost:1234', 'http://10.0.0.5:1234']);
});

test('routeUrls never passes lanFallback, so it stays localhost-only when no interface is visible', (t) => {
  t.mock.method(os, 'networkInterfaces', () => NO_NON_INTERNAL_IFACES);
  t.mock.method(cp, 'execFileSync', () => { throw new Error('must not shell out'); });
  assert.deepEqual(routeUrls(1234, '/'), ['http://localhost:1234']);
});

// Captured from a real Termux/Android host where os.networkInterfaces()
// reports only `lo` (the app sandbox blocks netlink-based enumeration) even
// though ioctl-based `ifconfig` still sees the real Wi-Fi LAN address and a
// VPN tunnel interface. This is the exact case enumerateUrls()'s fallback
// exists for.
const TERMUX_IFCONFIG = `
lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536
        inet 127.0.0.1  netmask 255.0.0.0
        unspec 00-00-00-00-00-00-00-00-00-00-00-00-00-00-00-00  txqueuelen 1000  (UNSPEC)

tun0: flags=81<UP,POINTOPOINT,RUNNING>  mtu 10000
        inet 10.1.10.1  netmask 255.255.255.255  destination 10.1.10.1
        unspec 00-00-00-00-00-00-00-00-00-00-00-00-00-00-00-00  txqueuelen 500  (UNSPEC)

wlan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 192.168.2.8  netmask 255.255.255.0  broadcast 192.168.2.255
        unspec 00-00-00-00-00-00-00-00-00-00-00-00-00-00-00-00  txqueuelen 3000  (UNSPEC)
`;

const IP_ADDR_SAMPLE = `
1: lo    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
3: tun0    inet 10.1.10.1/32 scope global tun0
       valid_lft forever preferred_lft forever
5: wlan0    inet 192.168.2.8/24 brd 192.168.2.255 scope global wlan0
       valid_lft forever preferred_lft forever
`;

const LEGACY_IFCONFIG_SAMPLE = `
eth0      Link encap:Ethernet  HWaddr 00:11:22:33:44:55
          inet addr:192.168.1.50  Bcast:192.168.1.255  Mask:255.255.255.0
          UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1

lo        Link encap:Local Loopback
          inet addr:127.0.0.1  Mask:255.0.0.0
          UP LOOPBACK RUNNING  MTU:65536  Metric:1
`;

test('parseLanIPv4s: busybox/toybox ifconfig — keeps the LAN IP, drops loopback + VPN point-to-point', () => {
  const ips = parseLanIPv4s(TERMUX_IFCONFIG);
  assert.deepEqual(ips, ['192.168.2.8']);
});

test('parseLanIPv4s: "ip -4 addr" prefix form — keeps /24, drops loopback + /32', () => {
  const ips = parseLanIPv4s(IP_ADDR_SAMPLE);
  assert.deepEqual(ips, ['192.168.2.8']);
});

test('parseLanIPv4s: legacy net-tools "inet addr:.../Mask:" form', () => {
  const ips = parseLanIPv4s(LEGACY_IFCONFIG_SAMPLE);
  assert.deepEqual(ips, ['192.168.1.50']);
});

test('parseLanIPv4s: no matches for unrelated text', () => {
  assert.deepEqual(parseLanIPv4s('not interface output at all'), []);
});

test('waitForPort resolves once something is listening, rejects otherwise', async () => {
  const port = await allocatePort();
  await assert.rejects(waitForPort(port, { timeoutMs: 300, intervalMs: 50 }));

  const srv = net.createServer();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  await waitForPort(port, { timeoutMs: 1000 });
  await new Promise((r) => srv.close(r));
});
