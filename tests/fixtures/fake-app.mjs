// A stand-in for a servable app. Binds $PORT, prints a readiness marker, and
// stays up until signalled (SIGTERM/SIGKILL) — exactly the "single blocking
// start command" contract code-hub expects.
//
// FAKE_APP_MODE:
//   (default)   → bind $PORT, print "listening on <port>", serve 200 OK, block.
//   crash       → exit(1) immediately without binding (simulates a broken app).
//   addrinuse   → exit(1) immediately as if $PORT were already bound (simulates
//                 a port race that never clears, regardless of the real port state).
//   flaky       → fails ONCE with EADDRINUSE, then binds normally on every later
//                 run (first-vs-later decided by creating $FAKE_APP_MARKER, so it
//                 is deterministic rather than timing-dependent). Models the
//                 transient port race the dynamic-port retry exists for.
//   wildcard    → same as default but binds 0.0.0.0 instead of 127.0.0.1. This is
//                 what the typical `app.listen(PORT)` app does, and it is the case
//                 where a fixed-port LAN share CANNOT take the app's port (a
//                 wildcard bind conflicts with a specific-address bind on the same
//                 port), so the gated share falls back to a free one.
import http from 'node:http';

if (process.env.FAKE_APP_MODE === 'crash') {
  console.error('boom: could not start');
  process.exit(1);
}

if (process.env.FAKE_APP_MODE === 'addrinuse') {
  console.error(`Error: listen EADDRINUSE: address already in use :::${process.env.PORT}`);
  process.exit(1);
}

if (process.env.FAKE_APP_MODE === 'flaky') {
  const { existsSync, writeFileSync } = await import('node:fs');
  const marker = process.env.FAKE_APP_MARKER;
  if (!existsSync(marker)) {
    writeFileSync(marker, 'tried');
    console.error(`Error: listen EADDRINUSE: address already in use :::${process.env.PORT}`);
    process.exit(1);
  }
}

const port = Number(process.env.PORT);
const host = process.env.FAKE_APP_MODE === 'wildcard' ? '0.0.0.0' : '127.0.0.1';
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
server.listen(port, host, () => {
  console.log(`listening on ${port}`);
});

// Keep the process alive and exit cleanly on SIGTERM so process-group kill is
// observable in tests.
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
