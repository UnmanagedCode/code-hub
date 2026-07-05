// code-hub frontend: vanilla ES module, no build step. Polls /api/apps and
// renders a mobile-first list of servable apps grouped by project.

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

const state = { apps: [], cloudflaredAvailable: false, share: {} }; // share: id → {url,qrSvg} | 'loading' | {error}
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

function urlsBlock(app) {
  return el('div', { class: 'urls' },
    ...app.urls.map((u) => el('a', { class: 'btn-link', href: u, target: '_blank', rel: 'noopener' }, `▶ ${u}`)));
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
    row.appendChild(el('button', { class: 'primary', disabled: isBusy || !!app.error && !app.sourceMissing || app.sourceMissing,
      onclick: () => action(app.id, () => api('POST', `/api/apps/${encodeURIComponent(app.id)}/start`)) }, 'Start'));
  } else {
    row.appendChild(el('button', { class: 'danger', disabled: isBusy,
      onclick: () => action(app.id, () => api('POST', `/api/apps/${encodeURIComponent(app.id)}/stop`)) }, 'Stop'));
    row.appendChild(el('button', { disabled: isBusy || app.sourceMissing,
      onclick: () => action(app.id, () => api('POST', `/api/apps/${encodeURIComponent(app.id)}/restart`)) }, 'Restart'));
    const shareBtn = el('button', {
      disabled: isBusy || !state.cloudflaredAvailable || !!app.tunnel,
      title: state.cloudflaredAvailable ? '' : 'cloudflared not installed',
      onclick: () => shareApp(app),
    }, app.tunnel ? 'Shared' : 'Share');
    row.appendChild(shareBtn);
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
  const c = el('div', { class: `card${app.isWorktree ? ' wt' : ''}` });
  c.appendChild(el('div', { class: 'card-head' },
    el('span', { class: `dot ${app.status}`, title: app.status }),
    el('span', { class: 'card-title' }, app.name),
  ));

  const meta = el('div', { class: 'meta' });
  if (app.isWorktree && app.branch) meta.appendChild(el('span', { class: 'badge wt' }, app.branch));
  if (app.currentSha) meta.appendChild(el('span', {}, shortSha(app.currentSha)));
  if (app.outOfDate) meta.appendChild(el('span', { class: 'badge stale' }, 'out of date'));
  if (app.sourceMissing) meta.appendChild(el('span', { class: 'badge gone' }, 'source removed'));
  if (app.port) meta.appendChild(el('span', {}, `:${app.port}`));
  if (meta.childNodes.length) c.appendChild(meta);

  if (app.error) c.appendChild(el('div', { class: 'err' }, app.error));
  if (app.urls && ['ready', 'running'].includes(app.status)) c.appendChild(urlsBlock(app));
  c.appendChild(controls(app));
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

  if (!state.apps.length) { emptyEl.textContent = 'No apps found. Add a .hub.json to a sibling project.'; root.innerHTML = ''; return; }
  emptyEl.style.display = 'none';

  // Group by project; main checkout first, then its worktrees.
  const groups = new Map();
  for (const a of state.apps) {
    if (!groups.has(a.project)) groups.set(a.project, []);
    groups.get(a.project).push(a);
  }
  root.innerHTML = '';
  for (const [project, apps] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    apps.sort((a, b) => (a.isWorktree ? 1 : 0) - (b.isWorktree ? 1 : 0) || a.id.localeCompare(b.id));
    const det = el('details', { class: 'project', open: true }, el('summary', {}, project));
    for (const a of apps) det.appendChild(card(a));
    root.appendChild(det);
  }
}

document.getElementById('refresh').addEventListener('click', refresh);
refresh();
setInterval(refresh, 2000); // reflect readiness / tunnel progress
