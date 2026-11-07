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
//   gated       → binds only once $FAKE_APP_MARKER exists (polled), so the app
//                 stays `starting` for exactly as long as a test wants — no
//                 timing involved.
//   wildcard    → same as default but binds 0.0.0.0 instead of 127.0.0.1. This is
//                 what the typical `app.listen(PORT)` app does, and it is the case
//                 where a fixed-port LAN share CANNOT take the app's port (a
//                 wildcard bind conflicts with a specific-address bind on the same
//                 port), so the gated share falls back to a free one.
//   split       → same as default, but the ready line arrives in two writes
//                 ("listen" now, "ing on <port>" 600ms later) so a readiness
//                 check sees the first half alone on at least one poll tick.
//   flood       → same as default, but prints 2×READY_OVERLAP_CHARS of filler in the
//                 same tick as the ready line, so the ready line is gone from the
//                 overlap tail by the first poll tick.
//   envdump     → writes its environment as JSON to $FAKE_APP_MARKER, then
//                 behaves as default.
//   backtrack   → prints 32 'a's and a '!' before binding, then behaves as
//                 default. Output that makes a pattern like (a|a)+$ take
//                 tens of seconds per unprotected check.
//   chatty      → same as default, then every 20ms writes "tick <n>" alternating
//                 stdout/stderr. An 'error' on stdout/stderr or an uncaught
//                 exception is appended to $FAKE_APP_MARKER and the app keeps
//                 running, as Next's dev server does.
//   slowexit    → same as default, but on SIGTERM it keeps holding $PORT for
//                 FAKE_APP_EXIT_DELAY_MS (default 400) before exiting, as an app
//                 with a slow shutdown does.
//   groupchild  → the leader spawns a `slowexit` copy of this fixture into its own
//                 process group and exits at once on SIGTERM, leaving only the
//                 child holding $PORT (the `npm` → `node` wrapper shape).
//   groupstubborn → like groupchild, but the same-group child ignores SIGTERM (only
//                 SIGKILL ends it) while the leader exits at once.
//   crashloud   → prints a HEAD-MARK line, FAKE_APP_CRASH_BYTES (default 5000) filler
//                 chars and a TAIL-MARK line, then exits 1 without binding.
//   ignoreterm  → same as default, but SIGTERM is ignored; the child of groupstubborn.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { READY_OVERLAP_CHARS } from '../../src/readyWhen.js';

if (process.env.FAKE_APP_MODE === 'groupchild' || process.env.FAKE_APP_MODE === 'groupstubborn') {
  const { spawn } = await import('node:child_process');
  const childMode = process.env.FAKE_APP_MODE === 'groupchild' ? 'slowexit' : 'ignoreterm';
  spawn(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, FAKE_APP_MODE: childMode } });
  process.on('SIGTERM', () => process.exit(0));
  await new Promise(() => {});
}

if (process.env.FAKE_APP_MODE === 'crash') {
  console.error('boom: could not start');
  process.exit(1);
}

if (process.env.FAKE_APP_MODE === 'crashloud') {
  console.error('HEAD-MARK');
  console.error('x'.repeat(Number(process.env.FAKE_APP_CRASH_BYTES ?? 5000)));
  console.error('TAIL-MARK');
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

if (process.env.FAKE_APP_MODE === 'envdump') {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.FAKE_APP_MARKER, JSON.stringify(process.env));
}

if (process.env.FAKE_APP_MODE === 'gated') {
  const { existsSync } = await import('node:fs');
  while (!existsSync(process.env.FAKE_APP_MARKER)) await new Promise((r) => setTimeout(r, 20));
}

const port = Number(process.env.PORT);
const host = process.env.FAKE_APP_MODE === 'wildcard' ? '0.0.0.0' : '127.0.0.1';
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
if (process.env.FAKE_APP_MODE === 'backtrack') console.log('a'.repeat(32) + '!');
server.listen(port, host, () => {
  if (process.env.FAKE_APP_MODE === 'split') {
    process.stdout.write('listen');
    setTimeout(() => console.log(`ing on ${port}`), 600);
  } else {
    console.log(`listening on ${port}`);
    if (process.env.FAKE_APP_MODE === 'flood') console.log('x'.repeat(2 * READY_OVERLAP_CHARS));
  }
});

if (process.env.FAKE_APP_MODE === 'chatty') {
  const { appendFileSync } = await import('node:fs');
  const record = (what) => (e) => appendFileSync(process.env.FAKE_APP_MARKER, `${what}:${e.code ?? e.message}\n`);
  process.stdout.on('error', record('stdout'));
  process.stderr.on('error', record('stderr'));
  process.on('uncaughtException', record('uncaught'));
  let n = 0;
  setInterval(() => {
    n += 1;
    (n % 2 ? process.stdout : process.stderr).write(`tick ${n}\n`);
  }, 20);
}

// Keep the process alive and exit cleanly on SIGTERM so process-group kill is
// observable in tests.
if (process.env.FAKE_APP_MODE === 'ignoreterm') {
  process.on('SIGTERM', () => {});
} else if (process.env.FAKE_APP_MODE === 'slowexit') {
  process.on('SIGTERM', () => setTimeout(() => server.close(() => process.exit(0)), Number(process.env.FAKE_APP_EXIT_DELAY_MS ?? 400)));
} else {
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
}
