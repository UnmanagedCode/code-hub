#!/usr/bin/env node
// Stand-in for the tailscale binary. `status --json` prints a canned status
// payload (so availability detection and MagicDNS-name derivation pass);
// `funnel ... <target>` prints the real banner shape then blocks until killed,
// mirroring the foreground funnel code-hub actually spawns.
//
// It VALIDATES ARGV the way the real binary would, because output that doesn't
// depend on the arguments requesting it hides exactly the mutations a fake is
// supposed to catch: without `--json` the real CLI prints human text and
// JSON.parse throws, and a funnel spawned without `--bg=false`/`--yes` either
// detaches or blocks on a confirmation prompt. Each of those would be invisible
// against a fixture that just dispatched on argv[0].
//
// FAKE_TAILSCALE_MODE:
//   (unset)     running node with a MagicDNS name; funnel comes up
//   logged-out  BackendState NeedsLogin, name still cached → available() false
//   no-magicdns BackendState Running but NO MagicDNS name → available() false
//   denied      funnel refused by the tailnet: stderr + exit 1, NO URL
//   slow-exit   funnel takes ~300ms to exit after SIGTERM — long enough for a
//               re-share to visibly race it if it does not wait
//   ignore-sigterm  funnel never exits on SIGTERM, so only a SIGKILL reaps it
//
// FAKE_TAILSCALE_ARGV_LOG: append one timestamped JSON line per invocation, and
//   another when a funnel exits — so a test can assert WHICH port was funnelled
//   and that a replacement funnel did not start before the old one was gone.
// FAKE_TAILSCALE_CHILD_PID_FILE: the funnel spawns a child of its own (in the
//   same process group) and writes its pid here — that child only dies if the
//   whole GROUP is signalled, which is what pins stopFunnel's `kill(-pid)`.
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const mode = process.env.FAKE_TAILSCALE_MODE || '';

const logEvent = (ev) => {
  if (!process.env.FAKE_TAILSCALE_ARGV_LOG) return;
  appendFileSync(process.env.FAKE_TAILSCALE_ARGV_LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ...ev }) + '\n');
};
logEvent({ event: 'invoke', argv: args });

// Trailing dot included on purpose — the real CLI reports the name
// fully-qualified, and stripping it is what code-hub's derivation must do.
const DNS_NAME = 'fake-node.example-tailnet.ts.net.';

const die = (msg) => { process.stderr.write(`fake-tailscale: ${msg}\n`); process.exit(2); };

if (args[0] === 'status') {
  // The real binary prints human-readable text without --json; parsing that as
  // JSON throws, which would 501 every share on every host.
  if (!args.includes('--json')) die('status without --json would print human text, not JSON');
  const payload = mode === 'logged-out'
    ? { BackendState: 'NeedsLogin', Self: { DNSName: DNS_NAME } }
    : mode === 'no-magicdns'
      ? { BackendState: 'Running', Self: { DNSName: '' } }
      : { BackendState: 'Running', Self: { DNSName: DNS_NAME } };
  console.log(JSON.stringify(payload));
  process.exit(0);
}

if (args[0] === 'funnel') {
  // Without --bg=false the CLI may background itself (no pid to hold, so
  // teardown-by-kill stops working); without --yes it blocks on a confirmation
  // prompt that a non-TTY spawn can never answer.
  if (!args.includes('--bg=false')) die('funnel without --bg=false may background itself');
  if (!args.includes('--yes')) die('funnel without --yes would block on a confirmation prompt');
  const target = args[args.length - 1];
  if (!/^http:\/\/localhost:\d+$/.test(target)) die(`funnel target ${JSON.stringify(target)} is not http://localhost:<port>`);

  if (mode === 'denied') {
    process.stderr.write('Funnel is not enabled on your tailnet.\n');
    process.exit(1);
  }

  // A child in this process group. It is deliberately orphan-tolerant (its own
  // stdio, no reliance on the parent) so it survives the parent's death — the
  // only thing that reaps it is a signal to the whole group.
  if (process.env.FAKE_TAILSCALE_CHILD_PID_FILE) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    writeFileSync(process.env.FAKE_TAILSCALE_CHILD_PID_FILE, String(child.pid));
  }

  process.stdout.write('Available on the internet:\n\n');
  process.stdout.write(`https://${DNS_NAME.replace(/\.$/, '')}/\n`);
  process.stdout.write(`|-- proxy ${target}\n\n`);
  process.stdout.write('Press Ctrl+C to exit.\n');
  const quit = () => { logEvent({ event: 'exit', argv: args }); process.exit(0); };
  if (mode === 'ignore-sigterm') process.on('SIGTERM', () => {});      // only SIGKILL reaps it
  else if (mode === 'slow-exit') process.on('SIGTERM', () => setTimeout(quit, 300));
  else process.on('SIGTERM', quit);
  setInterval(() => {}, 1 << 30); // block
} else {
  die(`unexpected subcommand ${JSON.stringify(args[0])}`);
}
