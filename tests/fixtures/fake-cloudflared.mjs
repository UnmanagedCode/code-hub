#!/usr/bin/env node
// Stand-in for the cloudflared binary. `--version` exits 0 (so availability
// detection passes); `tunnel --url ...` prints a canned trycloudflare URL to
// stderr (where the real binary emits it) then blocks until killed.
const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log('cloudflared version 0.0.0-fake');
  process.exit(0);
}

if (args[0] === 'tunnel') {
  process.stderr.write('Requesting new quick Tunnel on trycloudflare.com...\n');
  process.stderr.write('+--------------------------------------------------------+\n');
  process.stderr.write('|  https://fake-tunnel-code-hub.trycloudflare.com        |\n');
  process.stderr.write('+--------------------------------------------------------+\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1 << 30); // block
} else {
  process.exit(2);
}
