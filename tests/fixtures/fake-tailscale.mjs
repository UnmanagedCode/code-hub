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
//   slow-start  funnel takes ~400ms to announce itself, so a test can act on
//               the app while a share is still in flight
//   hang        `status` never answers (a wedged daemon/CLI)
//
// FAKE_TAILSCALE_GATE: a funnel holds its announcement back until this file
//   exists (polled), so a test can act while a tailscale share is
//   deterministically still coming up — with no timing involved.
//
// FAKE_TAILSCALE_ARGV_LOG: append one timestamped JSON line per invocation, and
//   another when a funnel exits — so a test can assert WHICH port was funnelled
//   and that a replacement funnel did not start before the old one was gone.
// FAKE_TAILSCALE_CHILD_PID_FILE: the funnel spawns a child of its own (in the
//   same process group) and writes its pid here — that child only dies if the
//   whole GROUP is signalled, which is what pins stopFunnel's `kill(-pid)`.
// FAKE_TAILSCALE_PORT_DIR: simulate tailscaled's one-funnel-per-port rule. A
//   funnel claims `<dir>/<port>` (holding its pid) before announcing, and gives
//   it up on a clean exit; a claim whose pid is dead (a SIGKILLed funnel) is
//   taken over. A live claim refuses the funnel with tailscaled's own words,
//   `listener already exists for port N`, and exit 1. A test simulates a port
//   held OUTSIDE code-hub by writing a live pid of its own into `<dir>/<port>`.
//
// `funnel` requires exactly one `--https=<port>`, and refuses a port Funnel
// does not allow with the real CLI's message and exit 1.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

const FUNNEL_PORTS = [443, 8443, 10000];

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Claim `<dir>/<port>` for this process, or return false when a live process
// already holds it. A dead holder's claim is taken over, once.
function claimPort(dir, port) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(port));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = Number(readFileSync(file, 'utf8').trim());
      if (alive(holder)) return false;
      try { unlinkSync(file); } catch { /* raced another taker */ }
    }
  }
  return false;
}

if (args[0] === 'status') {
  // The real binary prints human-readable text without --json; parsing that as
  // JSON throws, which would 501 every share on every host.
  if (!args.includes('--json')) die('status without --json would print human text, not JSON');
  if (mode === 'hang') { setInterval(() => {}, 1 << 30); await new Promise(() => {}); }
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
  // code-hub always names its Funnel port, even the CLI's default 443.
  const httpsFlags = args.filter((a) => a.startsWith('--https'));
  if (httpsFlags.length === 0) die('funnel without --https=<port> — code-hub always names its Funnel port');
  if (httpsFlags.length > 1) die(`funnel with a repeated --https flag: ${JSON.stringify(httpsFlags)}`);
  if (!/^--https=\d+$/.test(httpsFlags[0])) die(`malformed funnel port flag ${JSON.stringify(httpsFlags[0])}`);
  const funnelPort = Number(httpsFlags[0].slice('--https='.length));
  if (!FUNNEL_PORTS.includes(funnelPort)) {
    process.stderr.write(`port ${funnelPort} is not allowed for funnel; allowed ports are: [${FUNNEL_PORTS.join(' ')}]\n`);
    process.exit(1);
  }

  if (mode === 'denied') {
    process.stderr.write('Funnel is not enabled on your tailnet.\n');
    process.exit(1);
  }

  let claim = null;
  if (process.env.FAKE_TAILSCALE_PORT_DIR) {
    claim = claimPort(process.env.FAKE_TAILSCALE_PORT_DIR, funnelPort);
    if (!claim) {
      process.stderr.write(`listener already exists for port ${funnelPort}\n`);
      process.exit(1);
    }
  }

  // A child in this process group. It is deliberately orphan-tolerant (its own
  // stdio, no reliance on the parent) so it survives the parent's death — the
  // only thing that reaps it is a signal to the whole group.
  if (process.env.FAKE_TAILSCALE_CHILD_PID_FILE) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    writeFileSync(process.env.FAKE_TAILSCALE_CHILD_PID_FILE, String(child.pid));
  }

  // Handlers first: a funnel killed during a slow-start delay must still exit
  // (and log that it did), which is exactly what the in-flight tests check.
  const quit = () => {
    if (claim) { try { unlinkSync(claim); } catch { /* the test removed the dir */ } }
    logEvent({ event: 'exit', argv: args });
    process.exit(0);
  };
  // 'sigterm' is logged on RECEIPT, separately from 'exit', so a test can see
  // the moment teardown fired as distinct from the moment the child went away.
  process.on('SIGTERM', () => {
    logEvent({ event: 'sigterm', argv: args });
    if (mode === 'ignore-sigterm') return;                 // only SIGKILL reaps it
    if (mode === 'slow-exit') setTimeout(quit, 300); else quit();
  });

  const announce = () => {
    process.stdout.write('Available on the internet:\n\n');
    process.stdout.write(`https://${DNS_NAME.replace(/\.$/, '')}${funnelPort === 443 ? '' : `:${funnelPort}`}/\n`);
    process.stdout.write(`|-- proxy ${target}\n\n`);
    process.stdout.write('Press Ctrl+C to exit.\n');
  };
  const gate = process.env.FAKE_TAILSCALE_GATE;
  if (gate) {
    const poll = setInterval(() => { if (existsSync(gate)) { clearInterval(poll); announce(); } }, 20);
  } else if (mode === 'slow-start') setTimeout(announce, 400);
  else announce();
  setInterval(() => {}, 1 << 30); // block
} else {
  die(`unexpected subcommand ${JSON.stringify(args[0])}`);
}
