#!/usr/bin/env node
// Stand-in for the cloudflared binary. `--version` exits 0 (so availability
// detection passes); `tunnel --url ...` prints a canned trycloudflare URL to
// stderr (where the real binary emits it) then blocks until killed.
//
// FAKE_CLOUDFLARED_PID_LOG: append this tunnel child's pid (one per line) as it
//   starts, so a test can count the children a share started and check each
//   one is alive or dead.
// FAKE_CLOUDFLARED_GATE: hold the URL back until this file exists (polled), so
//   a test can act while a share is deterministically still in flight.
import { appendFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log('cloudflared version 0.0.0-fake');
  process.exit(0);
}

if (args[0] === 'tunnel') {
  process.on('SIGTERM', () => process.exit(0));
  if (process.env.FAKE_CLOUDFLARED_PID_LOG) appendFileSync(process.env.FAKE_CLOUDFLARED_PID_LOG, `${process.pid}\n`);
  const gate = process.env.FAKE_CLOUDFLARED_GATE;
  while (gate && !existsSync(gate)) await new Promise((r) => setTimeout(r, 20));
  process.stderr.write('Requesting new quick Tunnel on trycloudflare.com...\n');
  process.stderr.write('+--------------------------------------------------------+\n');
  process.stderr.write('|  https://fake-tunnel-code-hub.trycloudflare.com        |\n');
  process.stderr.write('+--------------------------------------------------------+\n');
  setInterval(() => {}, 1 << 30); // block
} else {
  process.exit(2);
}
