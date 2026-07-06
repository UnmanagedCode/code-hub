// code-hub frontend: vanilla ES module, no build step. Polls /api/apps and
// renders a mobile-first, sortable list of servable apps as accent-barred cards.

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

const state = { apps: [], cloudflaredAvailable: false, share: {}, sort: 'edited' }; // share: id → {url,qrSvg} | 'loading' | {error}
const busy = new Set(); // ids with an in-flight action (suppresses re-render churn)

async function api(method, path, opts = {}) {
  const r = await fetch(path, { method, cache: 'no-store', ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
}

async function refresh() {
  try {
    const data = await api('GET', '/api/apps');
    state.apps = data.apps;
    state.cloudflaredAvailable = data.cloudflaredAvailable;
    render();
    document.getElementById('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    document.getElementById('empty').textContent = `Failed to load: ${e.message}`;
  }
}

async function action(id, run) {
  busy.add(id);
  render();
  try { await run(); }
  catch (e) { alert(e.message); }
  finally { busy.delete(id); await refresh(); }
}

function shortSha(sha) { return sha ? sha.slice(0, 7) : ''; }
function statusWord(s) { return s === 'ready' ? 'running' : s; }

// Deterministic neon hue per app id → stable, distinct left accent bar.
function hueFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

// "34m ago" style relative label; '' for null/unparseable.
function relativeTime(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function statusRank(s) {
  if (s === 'running' || s === 'ready') return 0;
  if (s === 'starting') return 1;
  if (s === 'crashed') return 2;
  return 3; // stopped
}

function sortApps(apps) {
  const byName = (a, b) => (a.name || a.id).localeCompare(b.name || b.id);
  const list = [...apps];
  if (state.sort === 'name') list.sort(byName);
  else if (state.sort === 'status') list.sort((a, b) => statusRank(a.status) - statusRank(b.status) || byName(a, b));
  else list.sort((a, b) => { // 'edited': lastCommitAt desc, nulls last
    const ta = a.lastCommitAt ? Date.parse(a.lastCommitAt) : -Infinity;
    const tb = b.lastCommitAt ? Date.parse(b.lastCommitAt) : -Infinity;
    return tb - ta || byName(a, b);
  });
  return list;
}

function routesBlock(app) {
  if (!['ready', 'running'].includes(app.status) || !app.routes?.length) return null;
  const wrap = el('div', { class: 'routes' });
  const single = app.routes.length === 1;
  for (const r of app.routes) {
    const [primary, ...rest] = r.urls;
    const row = el('div', { class: 'route' });
    if (!single) row.appendChild(el('span', { class: 'route-name', title: r.path }, r.name));
    if (primary) row.appendChild(el('a', { class: 'open', href: primary, target: '_blank', rel: 'noopener' }, 'Open ▶'));
    if (rest.length) row.appendChild(el('div', { class: 'lan-links' },
      ...rest.map((u) => el('a', { href: u, target: '_blank', rel: 'noopener' }, u))));
    wrap.appendChild(row);
  }
  return wrap;
}

function sharePanel(app) {
  const s = state.share[app.id];
  if (s === 'loading') return el('div', { class: 'share' }, el('span', { class: 'spinner' }, 'Creating tunnel…'));
  const shared = app.tunnel || (s && s.url ? s : null);
  if (s && s.error) return el('div', { class: 'share' }, el('div', { class: 'err' }, s.error));
  if (!shared) return null;

  const panel = el('div', { class: 'share' });
  panel.appendChild(el('div', { class: 'share-url' }, shared.url));
  if (s && s.qrSvg) {
    const qr = el('div', { class: 'qr', title: 'Tap to enlarge', html: s.qrSvg,
      onclick: () => openQr(s.qrSvg, shared.url) });
    panel.appendChild(qr);
  }
  panel.appendChild(el('div', { class: 'share-actions' },
    el('a', { class: 'btn-link', href: shared.url, target: '_blank', rel: 'noopener' }, '▶ Open'),
    el('button', { onclick: () => { navigator.clipboard?.writeText(shared.url); } }, 'Copy'),
    el('button', { class: 'danger', onclick: () => action(app.id, async () => {
      await api('DELETE', `/api/apps/${encodeURIComponent(app.id)}/share`);
      delete state.share[app.id];
    }) }, 'Unshare'),
  ));
  return panel;
}

function openQr(svg, url) {
  const dlg = document.getElementById('qr-dialog');
  document.getElementById('qr-large').innerHTML = svg;
  document.getElementById('qr-open').href = url;
  dlg.showModal();
}

function controls(app) {
  const running = ['starting', 'ready', 'running'].includes(app.status);
  const isBusy = busy.has(app.id);
  const row = el('div', { class: 'controls' });

  if (!running) {
    row.appendChild(el('button', { class: 'start', disabled: isBusy || (!!app.error && !app.sourceMissing) || app.sourceMissing,
      onclick: () => action(app.id, () => api('POST', `/api/apps/${encodeURIComponent(app.id)}/start`)) }, 'Start'));
  } else {
    row.appendChild(el('button', { class: 'danger', disabled: isBusy,
      onclick: () => action(app.id, () => api('POST', `/api/apps/${encodeURIComponent(app.id)}/stop`)) }, 'Stop'));
    row.appendChild(el('button', { class: 'restart', disabled: isBusy || app.sourceMissing,
      onclick: () => action(app.id, () => api('POST', `/api/apps/${encodeURIComponent(app.id)}/restart`)) }, 'Restart'));
    row.appendChild(el('button', {
      disabled: isBusy || !state.cloudflaredAvailable || !!app.tunnel,
      title: state.cloudflaredAvailable ? '' : 'cloudflared not installed',
      onclick: () => shareApp(app),
    }, app.tunnel ? 'Shared' : 'Share'));
  }
  return row;
}

async function shareApp(app) {
  state.share[app.id] = 'loading';
  render();
  try {
    const res = await api('POST', `/api/apps/${encodeURIComponent(app.id)}/share`);
    state.share[app.id] = res;
  } catch (e) {
    state.share[app.id] = { error: e.message };
  }
  await refresh();
}

function card(app) {
  const c = el('div', { class: 'card' });
  c.style.setProperty('--accent-bar', `hsl(${hueFor(app.id)} 80% 62%)`);

  c.appendChild(el('div', { class: 'card-head' },
    el('span', { class: `dot ${app.status}`, title: app.status }),
    el('span', { class: 'card-title' }, app.name),
    el('div', { class: 'status-side' },
      el('span', { class: `status-word ${app.status}` }, statusWord(app.status)),
      app.port ? el('span', { class: 'port' }, `:${app.port}`) : null,
    ),
  ));

  const meta = el('div', { class: 'meta' });
  if (app.isWorktree && app.branch) meta.appendChild(el('span', { class: 'badge wt' }, app.branch));
  if (app.id !== app.name) meta.appendChild(el('span', { class: 'desc' }, app.id));
  if (app.currentSha) meta.appendChild(el('span', {}, shortSha(app.currentSha)));
  if (app.outOfDate) meta.appendChild(el('span', { class: 'badge stale' }, 'outdated'));
  if (app.lastCommitAt) meta.appendChild(el('span', { class: 'edited', title: new Date(app.lastCommitAt).toLocaleString() }, `edited ${relativeTime(app.lastCommitAt)}`));
  if (app.sourceMissing) meta.appendChild(el('span', { class: 'badge gone' }, 'source removed'));
  if (meta.childNodes.length) c.appendChild(meta);

  if (app.error) c.appendChild(el('div', { class: 'err' }, app.error));
  c.appendChild(controls(app));
  const routes = routesBlock(app);
  if (routes) c.appendChild(routes);
  const sp = sharePanel(app);
  if (sp) c.appendChild(sp);
  return c;
}

function render() {
  const root = document.getElementById('projects');
  const emptyEl = document.getElementById('empty');
  const cf = document.getElementById('cf-status');
  cf.textContent = state.cloudflaredAvailable ? 'cloudflared ✓' : 'no cloudflared';
  cf.className = `pill ${state.cloudflaredAvailable ? 'ok' : 'off'}`;

  if (!state.apps.length) { emptyEl.textContent = 'No apps found. Add a .hub.json to a sibling project.'; emptyEl.style.display = ''; root.innerHTML = ''; return; }
  emptyEl.style.display = 'none';

  root.innerHTML = '';
  for (const a of sortApps(state.apps)) root.appendChild(card(a));
}

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
refresh();
setInterval(refresh, 2000); // reflect readiness / tunnel progress
