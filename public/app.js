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

const state = { apps: [], cloudflaredAvailable: false, share: {}, credEdit: {}, sort: 'edited', expanded: new Set() }; // share: id → {choosing:true} | 'loading' | {url,kind,...} | {error}; credEdit: id → {username,password} draft while editing; expanded: project names with worktrees shown
const busy = new Set(); // ids with an in-flight action (suppresses re-render churn)

async function api(method, path, opts = {}) {
  const r = await fetch(path, { method, cache: 'no-store', ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
}

// `periodic: true` marks the background poll (see the setInterval below) —
// while a credential edit is in progress (state.credEdit non-empty), it
// skips render() so the poll can't tear down/refocus the edit's <input>s,
// same "suppress re-render churn while something's in flight" idea as the
// `busy` set above. Manual triggers (the refresh button, and action()'s own
// refresh() after Save/Cancel/Unshare/Stop/Restart) never pass this, so they
// keep rendering immediately as before.
async function refresh({ periodic = false } = {}) {
  try {
    const data = await api('GET', 'api/apps');
    state.apps = data.apps;
    state.cloudflaredAvailable = data.cloudflaredAvailable;
    if (!periodic || !Object.keys(state.credEdit).length) render();
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
    // Left block: route name (omitted for a single implicit route) with its
    // primary URL directly beneath, plus any LAN-IP URLs as small links.
    const info = el('div', { class: 'route-info' });
    if (!single) info.appendChild(el('span', { class: 'route-name', title: r.path }, r.name));
    if (primary) info.appendChild(el('a', { class: 'route-url', href: primary, target: '_blank', rel: 'noopener' }, primary));
    if (rest.length) info.appendChild(el('div', { class: 'lan-links' },
      ...rest.map((u) => el('a', { href: u, target: '_blank', rel: 'noopener' }, u))));
    // Right: compact Open button, vertically centered against the block.
    const row = el('div', { class: 'route' }, info,
      primary ? el('a', { class: 'open', href: primary, target: '_blank', rel: 'noopener' }, 'Open ▶') : null);
    wrap.appendChild(row);
  }
  return wrap;
}

function credRow(label, value) {
  return el('div', { class: 'cred' },
    el('span', { class: 'cred-label' }, label),
    el('span', { class: 'cred-val' }, value),
    el('button', { class: 'cred-copy', title: `Copy ${label}`, onclick: () => navigator.clipboard?.writeText(value) }, 'Copy'),
  );
}

// Creds display for an active share: read-only rows, or — while
// state.credEdit[app.id] is set (toggled by the Edit button in sharePanel's
// action row) — an edit form + Save/Cancel. For a LAN share this form is also
// the single place to flip authentication on/off (see the Authentication
// checkbox below); for a tunnel share (always gated) it only ever edits
// credentials. Save applies the auth toggle first, then the credentials PATCH
// (only if actually changed) — see the Save handler below for why the
// ordering and "only if changed" conditions matter. action()'s own refresh()
// re-reads everything back from list() (see appManager.js), so no local merge
// is needed.
function credsBlock(app, shared, kind) {
  const editing = state.credEdit[app.id];
  if (editing) {
    const isLan = kind === 'lan';
    const showCreds = !isLan || editing.auth;
    return el('div', { class: 'creds' },
      isLan ? el('label', { class: 'auth-toggle' },
        el('input', { type: 'checkbox', checked: editing.auth, onchange: (e) => { editing.auth = e.target.checked; render(); } }),
        ' Authentication',
      ) : null,
      isLan ? el('label', { class: 'auth-toggle' },
        el('input', { type: 'checkbox', checked: editing.tls, onchange: (e) => { editing.tls = e.target.checked; render(); } }),
        ' TLS (HTTPS)',
      ) : null,
      // TLS can't flip in place — Save re-shares to swap the scheme, so the link,
      // QR, and password all regenerate. Warn only when it's actually changing.
      isLan && editing.tls !== (shared.tls !== false)
        ? el('div', { class: 'cred-note' }, editing.auth
            ? 'Changing TLS re-shares the app — new link & QR, and the password resets (set one below to keep it).'
            : 'Changing TLS re-shares the app — new link & QR.')
        : null,
      showCreds ? el('div', { class: 'cred' },
        el('span', { class: 'cred-label' }, 'user'),
        el('input', { class: 'cred-input', value: editing.username,
          placeholder: editing.username ? '' : 'leave blank to keep current',
          oninput: (e) => { editing.username = e.target.value; } }),
      ) : null,
      showCreds ? el('div', { class: 'cred' },
        el('span', { class: 'cred-label' }, 'pass'),
        el('input', { class: 'cred-input', value: editing.password,
          placeholder: editing.password ? '' : 'leave blank to keep current',
          oninput: (e) => { editing.password = e.target.value; } }),
      ) : null,
      el('div', { class: 'share-actions' },
        el('button', { onclick: () => action(app.id, async () => {
          if (isLan && editing.tls !== (shared.tls !== false)) {
            // TLS changed — it can't flip in place (scheme/URL/cert are fixed at
            // proxy creation), so re-share to swap it. This spins up a fresh proxy
            // (new URL/QR/token, auto-generated password); share() applies the auth
            // choice itself, so no separate auth PATCH here.
            const res = await api('POST', `api/apps/${encodeURIComponent(app.id)}/share`, {
              body: JSON.stringify({ mode: 'lan', auth: editing.auth, tls: editing.tls }),
              headers: { 'content-type': 'application/json' },
            });
            state.share[app.id] = res;
            // The fresh proxy started with an auto-generated password; apply any
            // creds the user typed in this same edit (blank = keep the fresh one).
            if (editing.auth) {
              const body = {};
              if (editing.username) body.username = editing.username;
              if (editing.password) body.password = editing.password;
              if (Object.keys(body).length) {
                await api('PATCH', `api/apps/${encodeURIComponent(app.id)}/share/credentials`, {
                  body: JSON.stringify(body),
                  headers: { 'content-type': 'application/json' },
                });
              }
            }
          } else if (isLan) {
            // Auth first: updateShareCredentials 400s on a no-auth share, so
            // an auth-enabling toggle must land before any credentials PATCH.
            if (editing.auth !== (shared.auth !== false)) {
              await api('PATCH', `api/apps/${encodeURIComponent(app.id)}/share/auth`, {
                body: JSON.stringify({ enabled: editing.auth }),
                headers: { 'content-type': 'application/json' },
              });
            }
            if (editing.auth) {
              const body = {};
              if (editing.username && editing.username !== (shared.username ?? '')) body.username = editing.username;
              if (editing.password && editing.password !== (shared.password ?? '')) body.password = editing.password;
              // Blank/unchanged fields mean "keep what's there" — the proxy's
              // credentials are stable across an auth toggle, so skipping the
              // PATCH here is what lets re-enabling restore them untouched.
              if (Object.keys(body).length) {
                await api('PATCH', `api/apps/${encodeURIComponent(app.id)}/share/credentials`, {
                  body: JSON.stringify(body),
                  headers: { 'content-type': 'application/json' },
                });
              }
            }
          } else {
            await api('PATCH', `api/apps/${encodeURIComponent(app.id)}/share/credentials`, {
              body: JSON.stringify({ username: editing.username, password: editing.password }),
              headers: { 'content-type': 'application/json' },
            });
          }
          delete state.credEdit[app.id];
        }) }, 'Save'),
        el('button', { onclick: () => { delete state.credEdit[app.id]; render(); } }, 'Cancel'),
      ),
    );
  }
  return el('div', { class: 'creds' },
    credRow('user', shared.username),
    credRow('pass', shared.password),
  );
}

function sharePanel(app) {
  const s = state.share[app.id];
  if (s && s.choosing) {
    return el('div', { class: 'share' },
      el('div', { class: 'share-actions' },
        el('button', { onclick: () => doShare(app, 'lan') }, 'Share on LAN'),
        el('button', {
          disabled: !state.cloudflaredAvailable,
          title: state.cloudflaredAvailable ? '' : 'cloudflared not installed',
          onclick: () => doShare(app, 'tunnel'),
        }, 'Share via Tunnel'),
        el('button', { onclick: () => { delete state.share[app.id]; render(); } }, 'Cancel'),
      ));
  }
  if (s === 'loading') return el('div', { class: 'share' }, el('span', { class: 'spinner' }, 'Sharing…'));
  const shared = app.tunnel || (s && s.url ? s : null);
  if (s && s.error) return el('div', { class: 'share' }, el('div', { class: 'err' }, s.error));
  if (!shared) return null;

  // Opening/QR use the token-bearing authUrl when auth is enabled — scanning
  // it exchanges the token for a session cookie server-side, so no
  // credentials ever appear in the URL. A no-auth share has no token; the
  // plain URL is already the whole story. Username/password now come from
  // `shared` regardless of source (the one-time share() response or the
  // persisted app.tunnel from list()) — both carry the live proxy's creds.
  const openUrl = (s && s.authUrl) || shared.url;
  const kind = shared.kind || 'tunnel';
  const authEnabled = shared.auth !== false;
  const lanTls = kind === 'lan' && String(shared.url).startsWith('https:');
  const panel = el('div', { class: 'share' });
  panel.appendChild(el('div', { class: 'share-url' }, shared.url));
  panel.appendChild(el('div', { class: 'cred-note' },
    kind !== 'lan' ? 'via public tunnel'
    : !authEnabled && lanTls ? 'via LAN (HTTPS, self-signed — your browser warns on first visit), no authentication — anyone on the network can reach this app'
    : !authEnabled ? 'via LAN, no authentication — anyone on the network can reach this app'
    : lanTls ? 'via LAN (HTTPS, self-signed — your browser warns on first visit)'
    : 'via LAN (plain HTTP — credentials are not encrypted in transit)'));

  if (shared.urls && shared.urls.length > 1) {
    panel.appendChild(el('div', { class: 'lan-links' },
      ...shared.urls.slice(1).map((u) => el('a', { href: u, target: '_blank', rel: 'noopener' }, u))));
  }

  // Auth is only ever toggleable on a LAN share — a tunnel share is always
  // gated. The toggle itself now lives inside the Edit form below (credsBlock)
  // rather than a standalone control, so it applies on Save instead of live.
  const editing = !!state.credEdit[app.id];
  if (editing || (authEnabled && shared.username && shared.password)) {
    panel.appendChild(credsBlock(app, shared, kind));
  }

  if (s && s.qrSvg) {
    const qr = el('div', { class: 'qr', title: 'Tap to enlarge', html: s.qrSvg,
      onclick: () => openQr(s.qrSvg, openUrl) });
    panel.appendChild(qr);
  }
  // For a LAN share, Edit is reachable regardless of auth state — it's the
  // only way to turn authentication back on once it's off. A tunnel share is
  // always gated, so Edit there still only ever edits credentials.
  const canEdit = kind === 'lan' || (authEnabled && shared.username && shared.password);
  panel.appendChild(el('div', { class: 'share-actions' },
    el('a', { class: 'btn-link', href: openUrl, target: '_blank', rel: 'noopener' }, '▶ Open'),
    el('button', { onclick: () => { navigator.clipboard?.writeText(openUrl); } }, 'Copy'),
    canEdit && !editing
      ? el('button', { onclick: () => {
          state.credEdit[app.id] = kind === 'lan'
            ? { auth: authEnabled, tls: shared.tls !== false, username: shared.username ?? '', password: shared.password ?? '' }
            : { username: shared.username, password: shared.password };
          render();
        } }, 'Edit')
      : null,
    el('button', { class: 'danger', onclick: () => action(app.id, async () => {
      await api('DELETE', `api/apps/${encodeURIComponent(app.id)}/share`);
      delete state.share[app.id];
      delete state.credEdit[app.id];
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
    row.appendChild(el('button', { class: 'start', disabled: isBusy || !!app.manifestError || app.sourceMissing,
      onclick: () => action(app.id, () => api('POST', `api/apps/${encodeURIComponent(app.id)}/start`)) }, 'Start'));
  } else {
    if (!app.alwaysOn) {
      // Stop/restart tear down any active share server-side (teardownShare)
      // — clear the local share/credEdit state too, or the panel would keep
      // showing the now-defunct URL/creds until a re-share overwrites it.
      row.appendChild(el('button', { class: 'danger', disabled: isBusy,
        onclick: () => action(app.id, async () => {
          await api('POST', `api/apps/${encodeURIComponent(app.id)}/stop`);
          delete state.share[app.id]; delete state.credEdit[app.id];
        }) }, 'Stop'));
      row.appendChild(el('button', { class: 'restart', disabled: isBusy || app.sourceMissing,
        onclick: () => action(app.id, async () => {
          await api('POST', `api/apps/${encodeURIComponent(app.id)}/restart`);
          delete state.share[app.id]; delete state.credEdit[app.id];
        }) }, 'Restart'));
    }
    row.appendChild(el('button', {
      disabled: isBusy || !!app.tunnel,
      onclick: () => { state.share[app.id] = { choosing: true }; render(); },
    }, app.tunnel ? 'Shared' : 'Share'));
  }
  return row;
}

async function doShare(app, mode) {
  state.share[app.id] = 'loading';
  render();
  try {
    const res = await api('POST', `api/apps/${encodeURIComponent(app.id)}/share`, {
      body: JSON.stringify({ mode }),
      headers: { 'content-type': 'application/json' },
    });
    state.share[app.id] = res;
  } catch (e) {
    state.share[app.id] = { error: e.message };
  }
  await refresh();
}

function card(app, { subcard = false, worktrees = [] } = {}) {
  const c = el('div', { class: subcard ? 'card subcard' : 'card' });
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
  if (app.alwaysOn) meta.appendChild(el('span', { class: 'badge always-on' }, 'always on'));
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
  if (worktrees.length) appendWorktrees(c, app.project, worktrees);
  return c;
}

// Attach the collapsed-by-default worktree toggle + nested subcard list to a
// parent card. Expansion state lives in state.expanded (survives the 2s poll).
function appendWorktrees(c, project, worktrees) {
  if (state.expanded.has(project)) c.classList.add('expanded');
  const n = worktrees.length;
  c.appendChild(el('button', { class: 'wt-toggle',
    onclick: () => {
      if (state.expanded.has(project)) state.expanded.delete(project);
      else state.expanded.add(project);
      render();
    },
  }, `${n} worktree${n > 1 ? 's' : ''} `, el('span', { class: 'chev' }, '▾')));
  const list = el('div', { class: 'wt-list' });
  for (const w of worktrees) list.appendChild(card(w, { subcard: true }));
  c.appendChild(list);
}

// A header-only parent for worktrees whose main checkout isn't servable
// (no .hub.json / not discovered), so those worktrees are never hidden.
function orphanParent(project, worktrees) {
  const c = el('div', { class: 'card' });
  c.style.setProperty('--accent-bar', `hsl(${hueFor(project)} 80% 62%)`);
  c.appendChild(el('div', { class: 'card-head' },
    el('span', { class: 'card-title' }, project),
    el('div', { class: 'status-side' }, el('span', {}, 'no main checkout')),
  ));
  appendWorktrees(c, project, worktrees);
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

  // Worktrees nest under their parent project rather than showing as
  // top-level cards. Sort applies to the top-level (main) cards only.
  const mains = state.apps.filter((a) => !a.isWorktree);
  const wtByProject = new Map();
  for (const w of state.apps) {
    if (!w.isWorktree) continue;
    if (!wtByProject.has(w.project)) wtByProject.set(w.project, []);
    wtByProject.get(w.project).push(w);
  }
  for (const list of wtByProject.values()) list.sort((a, b) => (a.branch || a.id).localeCompare(b.branch || b.id));

  root.innerHTML = '';
  const seen = new Set();
  for (const m of sortApps(mains)) {
    seen.add(m.project);
    root.appendChild(card(m, { worktrees: wtByProject.get(m.project) || [] }));
  }
  for (const [project, list] of wtByProject) {
    if (!seen.has(project)) root.appendChild(orphanParent(project, list));
  }
}

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
refresh();
setInterval(() => refresh({ periodic: true }), 2000); // reflect readiness / tunnel progress
