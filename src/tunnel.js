import { spawn, execFile } from 'node:child_process';

// Binary is overridable so tests can inject a fake that prints a canned URL.
function bin() {
  return process.env.CODEHUB_CLOUDFLARED_BIN || 'cloudflared';
}

const URL_RE = /https:\/\/(?!api\.)[\w-]+\.trycloudflare\.com/;
const START_TIMEOUT_MS = 30000;

// Whether the cloudflared binary is runnable. Cached per call — cheap enough.
export function available() {
  return new Promise((resolve) => {
    execFile(bin(), ['--version'], (err) => resolve(!err));
  });
}

// Launch a cloudflared quick tunnel for localhost:<port> and resolve once the
// generated *.trycloudflare.com URL appears on its output. Rejects (with a
// clear message) if the binary is missing or no URL is seen in time. Returns
// { url, pid } — the caller persists the pid and tears it down via stopTunnel.
export function startTunnel(port) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin(), ['tunnel', '--url', `http://localhost:${port}`], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new Error(`cloudflared not available: ${e.message}`));
    }
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); fn(arg); } };

    const onData = (d) => {
      const m = URL_RE.exec(d.toString());
      if (m) finish(resolve, { url: m[0], pid: proc.pid });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => finish(reject, new Error(
      e.code === 'ENOENT' ? 'cloudflared binary not found in PATH' : e.message)));
    proc.on('exit', (code) => finish(reject, new Error(`cloudflared exited (code=${code}) before a tunnel URL appeared`)));

    const timer = setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
      finish(reject, new Error(`cloudflared tunnel URL not detected within ${START_TIMEOUT_MS}ms`));
    }, START_TIMEOUT_MS);
    timer.unref();
  });
}

export function stopTunnel(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
}
