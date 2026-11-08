import { CRASH_TAIL_CHARS } from './runner.js';

// Prose renderers for the MCP text format. Each takes the same complete object
// the json format carries for that tool and renders every field of it. The only
// cuts are a crashed app's output tail and the share QR, and the text says so.

const list = (xs) => (xs && xs.length ? xs.join(', ') : 'none');
const orNone = (v) => (v === null || v === undefined || v === '' ? 'none' : v);

function tunnelLine(t) {
  const parts = [`${t.kind} ${t.url}`, `auth ${t.auth ? 'on' : 'off'}`, `tls ${t.tls ? 'on' : 'off'}`];
  if (t.username != null) parts.push(`username ${t.username}`);
  if (t.password != null) parts.push(`password ${t.password}`);
  if (t.passwordIsDefault) parts.push('passwordIsDefault');
  if (t.authUrl) parts.push(`authUrl ${t.authUrl}`);
  if (t.funnelPort != null) parts.push(`funnelPort ${t.funnelPort}`);
  if (t.proxyPort != null) parts.push(`proxyPort ${t.proxyPort}`);
  if (t.urls?.length) parts.push(`urls ${t.urls.join(', ')}`);
  if (t.fixedPortFallback) parts.push('fixedPortFallback');
  if (t.fixedPortHolder) parts.push(`fixedPortHolder ${t.fixedPortHolder}`);
  if (t.containerInternal) parts.push('containerInternal');
  if (t.relay) parts.push(`relay ${JSON.stringify(t.relay)}`);
  if (t.qrSvg) parts.push('qrSvg omitted in text — it is tunnel.qrSvg in list_apps\' json format');
  return parts.join(' · ');
}

function settingsLine(s) {
  const share = s.autoShare ? (typeof s.autoShare === 'object' ? JSON.stringify(s.autoShare) : String(s.autoShare)) : 'off';
  return `autoStart ${s.autoStart ? 'on' : 'off'}, autoShare ${share}, port ${orNone(s.port)}, username ${orNone(s.username)}, hasPassword ${s.hasPassword ? 'yes' : 'no'}`;
}

function appBlock(a) {
  const flags = [];
  if (a.isWorktree) flags.push(`isWorktree, branch ${a.branch ?? 'none'}`);
  if (a.alwaysOn) flags.push('alwaysOn');
  if (a.sourceMissing) flags.push('sourceMissing');
  if (a.outOfDate) flags.push('outOfDate');
  const head = `${a.id} ("${a.name}") — ${a.status}${a.port != null ? ` on port ${a.port}` : ''}${flags.length ? ` [${flags.join('] [')}]` : ''}`;
  const lines = [head];
  const meta = [`project ${a.project}`, `path ${a.path}`];
  if (a.source) meta.push(`source ${a.source}`);
  if (a.manifestPort != null) meta.push(`manifestPort ${a.manifestPort}`);
  if (a.startedSha) meta.push(`startedSha ${a.startedSha}`);
  if (a.currentSha) meta.push(`currentSha ${a.currentSha}`);
  if (a.lastCommitAt) meta.push(`lastCommitAt ${a.lastCommitAt}`);
  meta.push(`logFile ${a.logFile}`);
  lines.push(`  ${meta.join(' · ')}`);
  if (a.urls?.length) lines.push(`  urls: ${a.urls.join(', ')}`);
  if (a.routes?.length) {
    lines.push(`  routes: ${a.routes.map((r) => `${r.name} ${r.path}${r.urls.length ? ` → ${r.urls.join(', ')}` : ''}`).join('; ')}`);
  }
  if (a.tunnel) lines.push(`  tunnel: ${tunnelLine(a.tunnel)}`);
  lines.push(`  settings: ${settingsLine(a.settings)}`);
  if (a.autoShareStatus) lines.push(`  autoShareStatus ${a.autoShareStatus}`);
  if (a.autoShareError) lines.push(`  autoShareError: ${a.autoShareError}`);
  if (a.autoStartError) lines.push(`  autoStartError: ${a.autoStartError}`);
  if (a.manifestError) lines.push(`  manifestError: ${a.manifestError}`);
  if (a.error && a.error !== a.manifestError) lines.push(`  error: ${a.error}`);
  if (a.output) {
    const tail = a.output.slice(-CRASH_TAIL_CHARS);
    const cut = tail.length < a.output.length;
    const dropped = a.outputTruncated ? ' older output was also dropped from the in-memory ring (outputTruncated);' : '';
    lines.push(`  output (${cut ? `tail: the last ${CRASH_TAIL_CHARS} chars of the retained output; ` : ''}${dropped}the full log is ${a.logFile}, and list_apps' json format carries the whole retained output as \`output\`):`);
    for (const l of tail.split('\n')) lines.push(`    ${l}`);
  }
  return lines.join('\n');
}

export function listApps(d) {
  const header = [
    `${d.apps.length} app${d.apps.length === 1 ? '' : 's'}`,
    `cloudflared ${d.cloudflaredAvailable ? 'available' : 'not available'}`,
    `tailscale ${d.tailscaleAvailable ? 'available' : 'not available'}`,
    `Funnel ports: ${d.funnelPorts.map((f) => (f.holder ? `${f.port} held by '${f.holder}'` : `${f.port} free`)).join(', ')}`,
    `hubSettings bridgeFallback ${d.hubSettings.bridgeFallback ? 'on' : 'off'}`,
  ].join(' · ');
  if (d.apps.length === 0) return `${header}\nNo apps found.`;
  return `${header}\n\n${d.apps.map(appBlock).join('\n\n')}`;
}

export function startApp(r) {
  const parts = [
    `Started '${r.id}' (project ${r.project}, pid ${r.pid}, pgid ${r.pgid}) on port ${r.port} (${r.fixedPort != null ? `fixed port ${r.fixedPort}` : 'allocated port'}) at ${r.startedAt}.`,
    'Readiness is not confirmed yet: list_apps reports the settled status (ready, or crashed).',
    `urls: ${list(r.urls)} · path ${r.path} · isWorktree ${r.isWorktree}`,
  ];
  if (r.branch) parts.push(`· branch ${r.branch}`);
  if (r.startedSha) parts.push(`· startedSha ${r.startedSha}`);
  return parts.join(' ');
}

export function stopApp(r) {
  return `Stopped '${r.id}' (status: ${r.status}); any share it had is torn down.`;
}

export function registerApp(r) {
  const m = r.manifest;
  const routes = m?.routes?.length ? m.routes.map((x) => `${x.name} ${x.path}`).join('; ') : 'none';
  const detail = m
    ? `start "${m.start}", name ${orNone(m.name)}, port ${orNone(m.port)}, healthPath ${orNone(m.healthPath)}, readyWhen ${orNone(m.readyWhen)}, routes ${routes}`
    : `manifestError ${r.manifestError}`;
  return `Registered '${r.id}' (project ${r.project}, source: ${r.source}, isWorktree ${r.isWorktree}) at ${r.path}: ${detail}. It now appears in list_apps; start it with start_app.`;
}

export function unregisterApp(r) {
  return `Unregistered '${r.id}': its registrations.json entry is removed (registered: ${r.registered}).`;
}
