import assert from 'node:assert/strict';

// Label-based completeness of a text view. Every non-null, non-boolean leaf of a tool's json
// object needs a rule (or a SKIP entry) naming the line prefix and the label+value the renderer
// prints for it, so a dropped label fails even when the value shows up
// elsewhere in the text (an id inside a project name, a url echoed by routes).
// The rule: a non-boolean leaf that carries a value must have a rule (a leaf
// with none fails, so a new schema field must be given one). Null leaves are
// skipped. A true boolean without a rule falls back to its key; a false one
// without a rule is skipped. SKIP exempts the declared cuts (`qrSvg`, `output`)
// and `outputTruncated`, which renders as the dropped-bytes sentence rather than
// a label, plus a leaf another rule already covers (tunnel.kind, rendered with
// tunnel.url). Rules pin the renderer's delimiter after a value, so an id that
// contains the project name cannot satisfy a project rule.

const E = (prefix, substr) => [prefix, substr];
const hasLine = (text, [prefix, substr]) => text.split('\n').some((l) => l.trim().startsWith(prefix) && l.includes(substr));
const SKIP = () => [];
const kv = (prefix, key) => (v) => [E(prefix, `${key} ${v}`)];
const onOff = (prefix, key, on = 'on', off = 'off') => (v) => [E(prefix, `${key} ${v ? on : off}`)];
const urlsOf = (prefix, label) => (arr) => [E(prefix, label), ...arr.map((u) => E(prefix, u))];
const flag = (prefix) => (v, p, key) => (v ? [E(prefix, key)] : []);
const line = (prefix, text) => (v) => [E(prefix, text(v))];

const LIST_APP = {
  id: line('', (v) => `${v} (`), name: line('', (v) => `("${v}")`), status: line('', (v) => `— ${v}`),
  port: line('', (v) => `on port ${v}`), branch: line('', (v) => `branch ${v}`),
  project: line('project', (v) => `project ${v} ·`), path: kv('project', 'path'), source: kv('project', 'source'),
  manifestPort: kv('project', 'manifestPort'), startedSha: kv('project', 'startedSha'),
  currentSha: kv('project', 'currentSha'), lastCommitAt: kv('project', 'lastCommitAt'), logFile: kv('project', 'logFile'),
  urls: urlsOf('urls:', 'urls: '),
  routes: (rs) => rs.flatMap((r) => [E('routes:', `${r.name} ${r.path}`), ...r.urls.map((u) => E('routes:', u))]),
  'settings.username': kv('settings:', 'username'),
  'settings.hasPassword': onOff('settings:', 'hasPassword', 'yes', 'no'),
  'settings.autoStart': onOff('settings:', 'autoStart'),
  'settings.autoShare': (v) => [E('settings:', `autoShare ${typeof v === 'object' ? JSON.stringify(v) : v}`)],
  'settings.port': kv('settings:', 'port'),
  'tunnel.url': (v, p) => [E('tunnel:', `${p.kind} ${v}`)], 'tunnel.kind': SKIP,
  'tunnel.auth': onOff('tunnel:', 'auth'), 'tunnel.tls': onOff('tunnel:', 'tls'),
  'tunnel.username': kv('tunnel:', 'username'), 'tunnel.password': kv('tunnel:', 'password'),
  'tunnel.authUrl': kv('tunnel:', 'authUrl'), 'tunnel.funnelPort': kv('tunnel:', 'funnelPort'),
  'tunnel.proxyPort': kv('tunnel:', 'proxyPort'), 'tunnel.fixedPortHolder': kv('tunnel:', 'fixedPortHolder'),
  'tunnel.urls': urlsOf('tunnel:', 'urls '),
  'tunnel.relay': line('tunnel:', (v) => `relay ${JSON.stringify(v)}`),
  'tunnel.passwordIsDefault': flag('tunnel:'), 'tunnel.fixedPortFallback': flag('tunnel:'), 'tunnel.containerInternal': flag('tunnel:'),
  'tunnel.qrSvg': SKIP, output: SKIP, outputTruncated: SKIP,
  autoShareStatus: kv('autoShareStatus', 'autoShareStatus'),
  autoShareError: line('autoShareError:', (v) => v), autoStartError: line('autoStartError:', (v) => v),
  manifestError: line('manifestError:', (v) => v),
  error: (v, p) => (v === p.manifestError ? [] : [E('error:', v)]), // equal to manifestError: rendered once, as that
};

const START = {
  id: line('', (v) => `Started '${v}'`), project: line('', (v) => `project ${v},`), pid: kv('', 'pid'), pgid: kv('', 'pgid'),
  port: line('', (v) => `on port ${v}`), fixedPort: line('', (v) => `fixed port ${v}`), startedAt: line('', (v) => `at ${v}`),
  path: kv('', 'path'), isWorktree: line('', (v) => `isWorktree ${v}`), branch: kv('', 'branch'), startedSha: kv('', 'startedSha'),
  urls: urlsOf('', 'urls: '),
};

const REGISTER = {
  id: line('', (v) => `Registered '${v}'`), project: line('', (v) => `project ${v},`), path: line('', (v) => ` at ${v}`),
  source: line('', (v) => `source: ${v}`), isWorktree: line('', (v) => `isWorktree ${v}`),
  'manifest.start': line('', (v) => `start "${v}"`), 'manifest.name': kv('', 'name'), 'manifest.port': kv('', 'port'),
  'manifest.healthPath': kv('', 'healthPath'), 'manifest.readyWhen': kv('', 'readyWhen'),
  'manifest.routes': (rs) => rs.map((r) => E('', `${r.name} ${r.path}`)),
  manifestError: kv('', 'manifestError'),
};

const UNREGISTER = { id: line('', (v) => `Unregistered '${v}'`), registered: line('', (v) => `registered: ${v}`) };
const STOP = { id: line('', (v) => `Stopped '${v}'`), status: line('', (v) => `status: ${v}`) };

export const SPECS = { list: LIST_APP, start: START, register: REGISTER, unregister: UNREGISTER, stop: STOP };

export function assertTextCovers(kind, value, text, label = kind) {
  const spec = SPECS[kind];
  const walk = (v, p, parent) => {
    if (v === null || v === undefined) return;
    const rule = spec[p];
    const key = p.split('.').pop();
    if (typeof v === 'boolean' && !rule) return v ? assert.ok(hasLine(text, E('', key)), `${label}: text drops ${p}`) : undefined;
    if (rule) {
      for (const e of rule(v, parent, key)) assert.ok(hasLine(text, e), `${label}: text drops ${p} — expected a "${e[0]}…" line containing ${JSON.stringify(e[1]).slice(0, 80)}`);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, p, parent));
    if (typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, p ? `${p}.${k}` : k, v));
    assert.fail(`${label}: no text rule for ${p}`);
  };
  walk(value, '', undefined);
}

// The listing header: availability, each Funnel port with its holder, hub settings.
export function assertListHeader(list, text) {
  const head = text.split('\n')[0];
  assert.ok(head.includes(`cloudflared ${list.cloudflaredAvailable ? 'available' : 'not available'}`), head);
  assert.ok(head.includes(`tailscale ${list.tailscaleAvailable ? 'available' : 'not available'}`), head);
  for (const f of list.funnelPorts) assert.ok(head.includes(f.holder ? `${f.port} held by '${f.holder}'` : `${f.port} free`), head);
  assert.ok(head.includes(`bridgeFallback ${list.hubSettings.bridgeFallback ? 'on' : 'off'}`), head);
}

export const blockOf = (text, id) => text.split('\n\n').find((b) => b.startsWith(`${id} (`));

// Every app of `list` has a block whose lines cover it, and the header covers the rest.
export function assertListText(list, text) {
  assertListHeader(list, text);
  for (const a of list.apps) assertTextCovers('list', a, blockOf(text, a.id) ?? assert.fail(`no text block for ${a.id}`), a.id);
}
