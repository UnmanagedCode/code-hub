import { spawn, execFile } from 'node:child_process';
import { pidAlive } from './state.js';

// Binary is overridable so tests can inject a fake that prints canned status
// JSON and a canned funnel banner.
function bin() {
  return process.env.CODEHUB_TAILSCALE_BIN || 'tailscale';
}

const START_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 5000;

// `tailscale status --json`, parsed — or null if the binary is missing, the
// daemon isn't answering, or the output isn't JSON. `--peers=false` keeps the
// payload bounded on a large tailnet: available() runs on every list() poll.
function status() {
  return new Promise((resolve) => {
    execFile(bin(), ['status', '--json', '--peers=false'], (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

// The node's MagicDNS name with the trailing dot stripped (tailscale reports
// it fully-qualified, e.g. `host.tailnet.ts.net.`), or null when tailscale
// isn't up or the node has no name yet.
export async function magicDnsName() {
  const s = await status();
  const name = s?.Self?.DNSName;
  if (typeof name !== 'string' || name === '') return null;
  return name.replace(/\.$/, '');
}

// Whether a funnel can plausibly be started: the daemon is running AND the
// node has a MagicDNS name (which is the URL). Deliberately does NOT check
// Self.CapMap for the funnel capability — that key is version-unstable, and a
// tailnet that refuses Funnel already fails loudly at share time carrying
// tailscale's own message (see startFunnel's exit path).
export async function available() {
  const s = await status();
  if (s?.BackendState !== 'Running') return false;
  return typeof s?.Self?.DNSName === 'string' && s.Self.DNSName !== '';
}

// Publish localhost:<port> on the node's Tailscale Funnel and resolve once the
// funnel is live. Returns { url, pid } — the caller persists the pid and tears
// it down via stopFunnel.
//
// The URL is DERIVED from `tailscale status --json`, never scraped from the
// CLI's output: a wording change in tailscale's banner can then only cost us a
// readiness timeout with a clear message, never a wrong URL.
//
// The process runs in the FOREGROUND (`--bg=false`, tailscale's own default).
// That is what makes teardown "kill the process": the CLI owns the funnel
// config for its own lifetime and removes it on exit, so there is no
// off-command to run. `tailscale funnel reset` would clear the user's
// unrelated `serve` config too, and a targeted `off` isn't in 1.102.3's help.
// The flag is passed explicitly so a future default flip can't silently
// background us. `--yes` keeps a non-TTY spawn from blocking on a prompt.
export function startFunnel(port) {
  return new Promise((resolve, reject) => {
    magicDnsName().then((name) => {
      if (!name) {
        return reject(new Error("tailscale is not ready — 'tailscale status' reports no MagicDNS name for this node"));
      }
      const url = `https://${name}`;
      let proc;
      try {
        proc = spawn(bin(), ['funnel', '--bg=false', '--yes', `http://localhost:${port}`], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        return reject(new Error(`tailscale not available: ${e.message}`));
      }
      let done = false;
      const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); fn(arg); } };

      // Readiness = the host we already derived appearing in the child's
      // output. Self-validating (it confirms tailscaled agrees with our
      // derivation) and carries no format fragility, unlike matching an
      // English phrase or a vendor URL shape. Resolving straight after spawn
      // would instead hand back a URL that never answers when the tailnet
      // refuses the funnel.
      let out = '';
      const onData = (d) => {
        out += d.toString();
        if (out.includes(name)) finish(resolve, { url, pid: proc.pid });
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      // Catch-all for a failed spawn. A MISSING binary does not reach here in
      // practice — magicDnsName() above runs the same binary first and has
      // already rejected — so this is the guard for the rest (EACCES, a binary
      // that vanished between the two calls, resource exhaustion).
      proc.on('error', (e) => finish(reject, new Error(
        e.code === 'ENOENT' ? 'tailscale binary not found in PATH' : e.message)));
      // The funnel being refused (ACL/nodeAttr missing, HTTPS off, 443 already
      // funnelled outside code-hub) surfaces only as a nonzero exit, so carry
      // tailscale's own words rather than inventing a cause.
      proc.on('exit', (code) => finish(reject, new Error(
        `tailscale funnel exited (code=${code}) before the funnel came up: ${out.trim().split('\n')[0] || '(no output)'}`)));

      const timer = setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
        finish(reject, new Error(`tailscale funnel did not come up at ${url} within ${START_TIMEOUT_MS}ms`));
      }, START_TIMEOUT_MS);
      timer.unref();
    }, reject);
  });
}

// SIGTERM to the process group. A twin of tunnel.stopTunnel by design rather
// than oversight: keeping each integration's teardown self-contained is what
// leaves a seam here for a fallback off-command, should tailscale ever stop
// removing a foreground funnel's config on exit.
export function stopFunnel(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
}

// Wait for a SIGTERMed funnel child to actually be GONE, SIGKILLing the group
// if it overstays. Callers need this because the CLI reverts the node's whole
// serve config when it exits: spawning a replacement while the old one is
// still shutting down means the old one's exit can revoke the new one's URL.
// Polls rather than awaiting an exit event — after a code-hub restart the
// child is ours only by pid, there is no ChildProcess to listen to.
export async function waitForExit(pid, { timeoutMs = EXIT_TIMEOUT_MS, intervalMs = 25 } = {}) {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
