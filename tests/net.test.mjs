import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import cp from 'node:child_process';
import { allocatePort, isPortFree, probeWildcardHold, enumerateUrls, routeUrls, waitForPort, parseLanIPv4s, localIPv4s } from '../src/net.js';
import { ALT_LOOPBACK, altLoopbackBindable } from './helpers.mjs';

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

// Hold `port` on `host` for the rest of the test, closing it via t.after so a
// failed assertion can't leave a listening socket keeping the process alive.
async function hold(t, port, host) {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, host, r));
  let open = true;
  const release = () => (open ? new Promise((r) => { open = false; blocker.close(r); }) : Promise.resolve());
  t.after(release);
  return release;
}

test('isPortFree is true for a released port and false while anything holds it', async (t) => {
  const port = await allocatePort();
  assert.equal(await isPortFree(port), true);

  const release = await hold(t, port, '127.0.0.1');
  assert.equal(await isPortFree(port), false);

  await release();
  assert.equal(await isPortFree(port), true); // free again once released
});

test('isPortFree is false for a port held on the wildcard address too', async (t) => {
  const port = await allocatePort();
  await hold(t, port, '0.0.0.0');
  assert.equal(await isPortFree(port), false);
});

test('isPortFree is a MACHINE-WIDE probe, not a loopback or connect check', async (t) => {
  // The discriminating case, and the only one here that pins HOW isPortFree
  // probes. A holder on 127.0.0.1 or on 0.0.0.0 (the two tests above) is
  // reported busy by every plausible implementation alike — measured: a
  // 0.0.0.0 bind, a 127.0.0.1 bind and a connect-based check all say "busy",
  // so neither of those tests can tell them apart.
  //
  // A holder on an address that is neither loopback-proper nor the wildcard
  // separates them: only the 0.0.0.0 bind sees it. A 127.0.0.1-bind probe
  // binds fine, and a connect to 127.0.0.1 is refused — both would call this
  // port FREE and let a fixed-port app start straight into an EADDRINUSE
  // crash, or hand a fixed port to a second app.
  //
  // ALT_LOOPBACK keeps this host-independent: no LAN interface required, so it
  // still guards the probe on a LAN-less box where the end-to-end LAN tests skip.
  if (!(await altLoopbackBindable())) return t.skip(`${ALT_LOOPBACK} is not bindable on this host`);
  const port = await allocatePort();
  await hold(t, port, ALT_LOOPBACK);
  assert.equal(await isPortFree(port), false);
});

test('probeWildcardHold separates a wildcard holder from an address-specific one', async (t) => {
  // This is what lets a fixed-port LAN share name the cause of its fallback
  // instead of guessing: only a bind covering every address can be the app's
  // own (see appManager.share), and only then is the app really LAN-exposed.
  if (!(await altLoopbackBindable())) return t.skip(`${ALT_LOOPBACK} is not bindable on this host`);

  const wildcard = await allocatePort();
  await hold(t, wildcard, '0.0.0.0');
  assert.equal(await probeWildcardHold(wildcard), 'held');

  const loopbackOnly = await allocatePort();
  await hold(t, loopbackOnly, '127.0.0.1');
  assert.equal(await probeWildcardHold(loopbackOnly), 'free', 'an address-specific holder is not a wildcard hold');

  const untouched = await allocatePort();
  assert.equal(await probeWildcardHold(untouched), 'free');
});

test('probeWildcardHold: a non-IPv4 alias override can never yield the quiet verdict', async (t) => {
  // The probe's 'free' answer is the only one downstream may stay quiet on, so
  // it must only come from an address a 0.0.0.0 holder would necessarily cover.
  // Measured: `::1` and `localhost` (which resolves to ::1) both BIND happily
  // alongside a holder on 0.0.0.0 — different address family — so an unvalidated
  // override returns 'free' → 'other' → a neutral note, for an app that really
  // is answering ungated on the LAN. That is the under-report this whole signal
  // exists to prevent, reopened by the seam added to test it.
  const port = await allocatePort();
  await hold(t, port, '0.0.0.0');

  const prev = process.env.CODEHUB_WILDCARD_PROBE_ADDR;
  t.after(() => {
    if (prev === undefined) delete process.env.CODEHUB_WILDCARD_PROBE_ADDR;
    else process.env.CODEHUB_WILDCARD_PROBE_ADDR = prev;
  });

  for (const bad of ['::1', 'localhost', '::']) {
    process.env.CODEHUB_WILDCARD_PROBE_ADDR = bad;
    const verdict = await probeWildcardHold(port);
    assert.notEqual(verdict, 'free', `alias '${bad}' must not produce the quiet verdict`);
    // Rejected values fall back to the IPv4 default, which correctly sees the
    // wildcard holder — so the warning fires rather than the probe going dark.
    assert.equal(verdict, 'held', `alias '${bad}' must fall back to the IPv4 default`);
  }
});

test('probeWildcardHold: a valid IPv4 override is still honoured', async (t) => {
  // Validation must reject the wrong address family, not every override — the
  // probe-unavailable host class is simulated with an unconfigured IPv4 address
  // (see tests/routes.test.mjs), and that must keep reaching 'inconclusive'.
  const port = await allocatePort();
  const prev = process.env.CODEHUB_WILDCARD_PROBE_ADDR;
  process.env.CODEHUB_WILDCARD_PROBE_ADDR = '192.0.2.1'; // RFC 5737, never configured
  t.after(() => {
    if (prev === undefined) delete process.env.CODEHUB_WILDCARD_PROBE_ADDR;
    else process.env.CODEHUB_WILDCARD_PROBE_ADDR = prev;
  });
  assert.equal(await probeWildcardHold(port), 'inconclusive');
});

test('probeWildcardHold: an alias that is not a SPECIFIC address cannot yield the loud verdict', async (t) => {
  // Mirror image of the non-IPv4 case above. 'held' is read downstream as
  // "almost certainly the app, which is therefore LAN-exposed", so an alias
  // that reports 'held' without a wildcard holder reopens the over-report.
  // Measured against a port held ONLY on 127.0.0.1 (no wildcard holder):
  //   0.0.0.0   IS the wildcard, so it collides with any single-address holder
  //   127.0.0.1 is what a loopback-only app binds, so it collides with the app
  // Both pass a bare net.isIPv4() gate, which is why the class — a *specific*
  // address nothing else is expected to bind — is what gets validated.
  const port = await allocatePort();
  await hold(t, port, '127.0.0.1');

  const prev = process.env.CODEHUB_WILDCARD_PROBE_ADDR;
  t.after(() => {
    if (prev === undefined) delete process.env.CODEHUB_WILDCARD_PROBE_ADDR;
    else process.env.CODEHUB_WILDCARD_PROBE_ADDR = prev;
  });

  for (const bad of ['0.0.0.0', '127.0.0.1']) {
    process.env.CODEHUB_WILDCARD_PROBE_ADDR = bad;
    const verdict = await probeWildcardHold(port);
    assert.notEqual(verdict, 'held', `alias '${bad}' must not produce the loud verdict without a wildcard holder`);
    // Falls back to the default alias, which correctly sees no wildcard hold.
    assert.equal(verdict, 'free', `alias '${bad}' must fall back to the specific-address default`);
  }
});

test('probeWildcardHold: the default alias is unaffected by the specific-address rule', async (t) => {
  // Guards the fallback target itself: 127.0.0.2 must keep reporting a genuine
  // wildcard hold as 'held', or the validation above would have traded the
  // over-report for an under-report.
  const port = await allocatePort();
  await hold(t, port, '0.0.0.0');
  assert.equal(await probeWildcardHold(port), 'held');
});
