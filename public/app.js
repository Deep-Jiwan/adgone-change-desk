'use strict';
// Change Desk frontend: dependency-free SPA. All dynamic text goes through textContent (see h()).

const STATUS = { new: 'New', review: 'Under Review', approved: 'Approved', in_progress: 'In Progress', testing: 'Testing', completed: 'Completed', rejected: 'Rejected' };
const CATEGORY = { bug: 'Bug Fix', feature: 'New Feature', improvement: 'Improvement', ui: 'UI Change' };
const PRIORITY = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
const ROLE = { admin: 'Admin', developer: 'Developer', requester: 'Requester' };
const APP_STATUS = { active: 'Active', maintenance: 'Maintenance', retired: 'Retired' };
const ACTION_TEXT = { created: 'created the request', status: 'changed status', assigned: 'assigned to', due: 'set due date', priority: 'changed priority', category: 'changed category', progress: 'set progress', edited: 'edited', attachment: 'attached' };
const NEXT_LABEL = { review: 'Start review', approved: 'Approve', in_progress: 'Start work', testing: 'Ready for testing', completed: 'Accept & complete', rejected: 'Reject', new: 'Reopen' };

/* ------------------------------------------------------------ helpers */

function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  const add = (kid) => {
    if (Array.isArray(kid)) kid.forEach(add);
    else if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return node;
}

const state = { user: null, cleanups: [] };
const root = document.getElementById('app');

async function api(method, path, body, extra = {}) {
  const raw = body instanceof Blob;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'change-desk', ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; go('/login'); }
    if (res.status === 403 && data?.error?.includes('temporary password')) go('/account');
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

const go = (path) => { location.hash = '#' + path; };
const utc = (s) => new Date(s.replace(' ', 'T') + 'Z');
const fmtDateTime = (s) => (s ? utc(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fmtDate = (s) => (s ? new Date(s + (s.length === 10 ? 'T00:00:00' : '')).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const isStaff = () => state.user && state.user.role !== 'requester';
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const badge = (cls, text) => h('span', { class: `badge ${cls}` }, text);
const statusBadge = (s) => badge(`s-${s}`, STATUS[s]);
const priorityBadge = (p) => badge(`p-${p}`, PRIORITY[p]);
const progressBar = (pct, done) => {
  const bar = h('div', { class: `progress${done ? ' done' : ''}`, title: `${pct}%` }, h('i'));
  bar.firstChild.style.width = `${pct}%`;
  return bar;
};
const errorBox = () => h('div', { class: 'error hidden', role: 'alert' });
function showError(box, e) { box.textContent = e.message || String(e); box.classList.remove('hidden'); }

function select(name, options, value, { blank } = {}) {
  const s = h('select', { name });
  if (blank !== undefined) s.append(h('option', { value: '' }, blank));
  for (const [v, t] of Object.entries(options)) s.append(h('option', { value: v, selected: v === value }, t));
  return s;
}

function toast(message, ok = true) {
  const t = h('div', { class: ok ? 'notice' : 'error', role: 'status', style: 'position:fixed;bottom:1rem;right:1rem;z-index:20;max-width:90vw' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

/* ------------------------------------------------------------ layout */

function layout(active, ...content) {
  const link = (href, text, key) => h('a', { href: '#' + href, class: active === key ? 'active' : '' }, text);
  const nav = h('nav', { class: 'nav' },
    link('/', 'Dashboard', 'dashboard'),
    link('/requests', 'All requests', 'requests'),
    state.user.role === 'admin' && link('/team', 'Team', 'team'));
  const me = h('div', { class: 'me small' },
    h('div', {}, h('b', {}, state.user.name)),
    h('div', { class: 'muted' }, ROLE[state.user.role]),
    h('div', { class: 'row' },
      h('a', { href: '#/account' }, 'Account'),
      h('button', { class: 'link', onclick: logout }, 'Sign out')));
  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' }, h('div', { class: 'brand' }, '📋 Change Desk'), nav, me),
    h('main', {}, ...content)));
}

async function logout() {
  try { await api('POST', '/api/logout'); } catch { /* ignore */ }
  state.user = null;
  go('/login');
}

/* ------------------------------------------------------------ auth views */

function authCard(title, subtitle, form) {
  root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card stack' }, h('div', {}, h('h1', {}, title), h('p', { class: 'muted' }, subtitle)), form)));
}

async function loginView() {
  const { needsSetup } = await api('GET', '/api/setup');
  const err = errorBox();
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username' });
  const password = h('input', { type: 'password', name: 'password', required: true, autocomplete: needsSetup ? 'new-password' : 'current-password', minLength: needsSetup ? 10 : undefined });
  const name = needsSetup && h('input', { name: 'name', required: true, autocomplete: 'name' });
  const form = h('form', {
    class: 'stack',
    async onsubmit(e) {
      e.preventDefault();
      err.classList.add('hidden');
      try {
        const body = needsSetup ? { email: email.value, name: name.value, password: password.value } : { email: email.value, password: password.value };
        const { user } = await api('POST', needsSetup ? '/api/setup' : '/api/login', body);
        state.user = user;
        go(user.must_change_password ? '/account' : '/');
      } catch (ex) { showError(err, ex); }
    },
  },
  err,
  needsSetup && h('label', {}, 'Your name', name),
  h('label', {}, 'Email', email),
  h('label', {}, 'Password', needsSetup && h('span', { class: 'hint' }, 'At least 10 characters'), password),
  h('button', { class: 'primary', type: 'submit' }, needsSetup ? 'Create admin account' : 'Sign in'));
  authCard(needsSetup ? 'Welcome to Change Desk' : 'Sign in', needsSetup ? 'Create the first account. It becomes the administrator.' : 'Use the account your administrator created for you.', form);
  email.focus();
}

/* ------------------------------------------------------------ dashboard */

async function dashboardView() {
  layout('dashboard', h('p', { class: 'muted' }, 'Loading…'));
  const { apps } = await api('GET', '/api/apps');
  const sum = (k) => apps.reduce((n, a) => n + a[k], 0);
  let query = '';
  let statusFilter = '';
  const grid = h('div', { class: 'grid' });
  const draw = () => {
    const shown = apps.filter((a) => (!statusFilter || a.status === statusFilter) && (a.name + a.key + a.description).toLowerCase().includes(query));
    grid.replaceChildren(...shown.map(appCard));
    if (!shown.length) grid.replaceChildren(h('div', { class: 'card empty', style: 'grid-column:1/-1' }, apps.length ? 'No apps match your filter.' : state.user.role === 'admin' ? 'No apps yet. Add your first one to start collecting change requests.' : 'No apps have been added yet. Ask an admin to add them.'));
  };
  const tile = (n, text, extra) => h('div', { class: 'card tile' }, h('b', { class: extra }, n), h('span', { class: 'muted' }, text));
  layout('dashboard',
    h('div', { class: 'row between' }, h('h1', {}, 'Applications'), state.user.role === 'admin' && h('button', { class: 'primary', onclick: () => appModal() }, '+ Add app')),
    h('div', { class: 'tiles' }, tile(sum('pending'), 'Pending'), tile(sum('in_progress'), 'In progress'), tile(sum('completed'), 'Completed'), tile(sum('overdue'), 'Overdue', sum('overdue') ? 'overdue' : '')),
    h('div', { class: 'filters' },
      h('input', { type: 'search', placeholder: 'Search apps…', 'aria-label': 'Search apps', oninput: (e) => { query = e.target.value.toLowerCase(); draw(); } }),
      select('status', APP_STATUS, '', { blank: 'All statuses' }),
    ),
    grid);
  document.querySelector('.filters select').addEventListener('change', (e) => { statusFilter = e.target.value; draw(); });
  draw();
}

function appCard(a) {
  const stat = (n, t, bad) => h('div', { class: `stat${bad && n ? ' bad' : ''}` }, h('b', {}, n), h('span', {}, t));
  return h('a', { class: 'card', href: `#/app/${a.id}` },
    h('div', { class: 'row between' }, h('span', { class: 'app-icon' }, a.icon), badge('', APP_STATUS[a.status])),
    h('h2', { style: 'margin-top:.5rem' }, a.name),
    h('div', { class: 'muted small' }, a.key, a.version && ` · v${a.version}`),
    a.description && h('p', { class: 'small' }, a.description),
    h('div', { class: 'counts' }, stat(a.pending, 'Pending'), stat(a.in_progress, 'In progress'), stat(a.completed, 'Done'), stat(a.overdue, 'Overdue', true)));
}

function modal(title, body, onClose) {
  const close = () => { overlay.remove(); onClose?.(); };
  const overlay = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'box' }, h('div', { class: 'row between' }, h('h2', {}, title), h('button', { onclick: close, 'aria-label': 'Close' }, '✕')), body));
  document.body.append(overlay);
  return close;
}

function appModal(app) {
  const err = errorBox();
  const f = (name, value = '', props = {}) => h('input', { name, value, ...props });
  const key = f('key', app?.key, { required: true, maxLength: 10, disabled: !!app, placeholder: 'e.g. CHAI' });
  const name = f('name', app?.name, { required: true, maxLength: 80 });
  const icon = f('icon', app?.icon || '📦', { required: true, maxLength: 8 });
  const version = f('version', app?.version, { placeholder: '1.0.0' });
  const repo = f('repo_url', app?.repo_url, { type: 'url', placeholder: 'https://github.com/…' });
  const status = select('status', APP_STATUS, app?.status || 'active');
  const description = h('textarea', { name: 'description', maxLength: 500, style: 'min-height:70px' }, app?.description || '');
  const form = h('form', {
    class: 'stack',
    async onsubmit(e) {
      e.preventDefault();
      try {
        const body = { name: name.value, icon: icon.value, version: version.value, repo_url: repo.value, status: status.value, description: description.value };
        if (app) await api('PATCH', `/api/apps/${app.id}`, body);
        else await api('POST', '/api/apps', { ...body, key: key.value });
        close();
        route();
      } catch (ex) { showError(err, ex); }
    },
  }, err,
  h('div', { class: 'form-grid' }, h('label', {}, 'Name', name), h('label', {}, 'Key', h('span', { class: 'hint' }, 'Used in request IDs (CHAI-0001)'), key), h('label', {}, 'Icon', icon), h('label', {}, 'Version', version), h('label', {}, 'Status', status)),
  h('label', {}, 'Repository URL', repo), h('label', {}, 'Description', description),
  h('button', { class: 'primary', type: 'submit' }, app ? 'Save changes' : 'Add app'));
  const close = modal(app ? 'Edit app' : 'Add app', form);
  name.focus();
}

/* ------------------------------------------------------------ request lists */

function requestTable(requests, { showApp = true } = {}) {
  if (!requests.length) return h('div', { class: 'card empty' }, 'No change requests match.');
  return h('div', { class: 'card table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['ID', 'Title', showApp && 'App', 'Category', 'Priority', 'Status', 'Progress', 'Assignee', 'Due'].map((t) => t !== false && h('th', {}, t)))),
    h('tbody', {}, requests.map((r) => h('tr', { class: 'clickable', tabIndex: 0, onclick: () => go(`/request/${r.id}`), onkeydown: (e) => { if (e.key === 'Enter') go(`/request/${r.id}`); } },
      h('td', {}, h('a', { href: `#/request/${r.id}` }, r.ref)),
      h('td', {}, r.title),
      showApp && h('td', {}, `${r.app_icon} ${r.app_name}`),
      h('td', {}, CATEGORY[r.category]),
      h('td', {}, priorityBadge(r.priority)),
      h('td', {}, statusBadge(r.status)),
      h('td', { style: 'min-width:100px' }, progressBar(r.progress, r.status === 'completed')),
      h('td', {}, r.assignee_name || h('span', { class: 'muted' }, '—')),
      h('td', { class: r.overdue ? 'overdue' : '' }, r.due_date ? fmtDate(r.due_date) + (r.overdue ? ' (overdue)' : '') : h('span', { class: 'muted' }, '—')))))));
}

/** Filter bar + results. `fixed` holds query params that cannot be changed (e.g. app). */
async function requestList(container, fixed, { exportable } = {}) {
  const users = (await api('GET', '/api/users')).users.filter((u) => u.role !== 'requester');
  const f = { q: '', status: '', priority: '', category: '', assignee: '', overdue: '' };
  const results = h('div');
  const params = () => new URLSearchParams(Object.entries({ ...f, ...fixed }).filter(([, v]) => v));
  const load = async () => {
    try { results.replaceChildren(requestTable((await api('GET', `/api/requests?${params()}`)).requests, { showApp: !fixed.app })); }
    catch (e) { results.replaceChildren(h('div', { class: 'error' }, e.message)); }
  };
  const bind = (name, ctl, ev = 'change') => {
    const apply = () => { f[name] = ctl.type === 'checkbox' ? (ctl.checked ? '1' : '') : ctl.value; load(); };
    ctl.addEventListener(ev, ev === 'input' ? debounce(apply) : apply);
    return ctl;
  };
  const assignee = h('select', { 'aria-label': 'Assignee' }, h('option', { value: '' }, 'Any assignee'), h('option', { value: 'me' }, 'Assigned to me'), h('option', { value: 'none' }, 'Unassigned'), users.map((u) => h('option', { value: u.id }, u.name)));
  const overdue = h('input', { type: 'checkbox', style: 'width:auto' });
  container.append(
    h('div', { class: 'filters' },
      bind('q', h('input', { type: 'search', placeholder: 'Search title, description or ID…', 'aria-label': 'Search requests' }), 'input'),
      bind('status', select('status', STATUS, '', { blank: 'All statuses' })),
      bind('priority', select('priority', PRIORITY, '', { blank: 'All priorities' })),
      bind('category', select('category', CATEGORY, '', { blank: 'All categories' })),
      bind('assignee', assignee),
      h('label', { class: 'row', style: 'font-weight:400' }, bind('overdue', overdue), 'Overdue only'),
      exportable && isStaff() && h('a', { class: 'btn', href: '#', onclick: (e) => { e.preventDefault(); location.href = `/api/export.csv?${params()}`; } }, '⬇ Export CSV')),
    results);
  await load();
}

async function allRequestsView() {
  const main = h('div', { class: 'stack' }, h('h1', {}, 'All change requests'));
  layout('requests', main);
  await requestList(main, {}, { exportable: true });
}

/* ------------------------------------------------------------ app page */

async function appView(id) {
  const { app } = await api('GET', `/api/apps/${id}`);
  const stat = (n, t, bad) => h('div', { class: `stat${bad && n ? ' bad' : ''}` }, h('b', {}, n), h('span', {}, t));
  const list = h('div', { class: 'stack' });
  layout('dashboard',
    h('div', { class: 'crumbs small' }, h('a', { href: '#/' }, '← All applications')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row between' },
        h('div', { class: 'row' }, h('span', { class: 'app-icon' }, app.icon), h('div', {}, h('h1', { style: 'margin:0' }, app.name), h('div', { class: 'muted small' }, app.key, app.version && ` · v${app.version}`, ' · ', APP_STATUS[app.status]))),
        h('div', { class: 'row' },
          app.repo_url && h('a', { class: 'btn', href: app.repo_url, target: '_blank', rel: 'noopener noreferrer' }, 'Repository ↗'),
          state.user.role === 'admin' && h('button', { onclick: () => appModal(app) }, 'Edit'),
          app.status !== 'retired' && h('a', { class: 'btn primary', href: `#/app/${app.id}/new` }, '+ Request change'))),
      app.description && h('p', { class: 'muted', style: 'margin:0' }, app.description),
      h('div', { class: 'counts' }, stat(app.pending, 'Pending'), stat(app.in_progress, 'In progress'), stat(app.completed, 'Completed'), stat(app.overdue, 'Overdue', true))),
    h('h2', {}, 'Change history'), list);
  await requestList(list, { app: app.id }, { exportable: true });
}

/* ------------------------------------------------------------ attachments picker + annotator */

const ALLOWED_PREFIX = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'application/pdf', 'text/plain', 'text/csv', 'application/zip', 'application/msword', 'application/vnd.openxmlformats-officedocument', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'];
const MAX_BYTES = 10 * 1024 * 1024;

function filePicker(onChange) {
  const files = [];
  const thumbs = h('div', { class: 'thumbs' });
  const err = errorBox();
  const render = () => {
    thumbs.replaceChildren(...files.map((file, i) => {
      const isImg = file.type.startsWith('image/');
      const isVid = file.type.startsWith('video/');
      const url = (isImg || isVid) ? URL.createObjectURL(file) : null;
      const pic = h('div', { class: 'pic' }, isImg ? h('img', { src: url, alt: file.name }) : isVid ? h('video', { src: url, muted: true }) : '📄');
      return h('div', { class: 'thumb' }, pic, h('div', { class: 'meta' }, file.name, h('div', { class: 'muted' }, fmtSize(file.size))),
        h('div', { class: 'acts' },
          isImg && h('button', { type: 'button', class: 'link', onclick: () => annotate(file, (edited) => { files[i] = edited; render(); }) }, 'Annotate'),
          h('button', { type: 'button', class: 'link', onclick: () => { files.splice(i, 1); render(); } }, 'Remove')));
    }));
    onChange?.(files);
  };
  const add = (list) => {
    err.classList.add('hidden');
    for (const f of list) {
      if (!ALLOWED_PREFIX.some((p) => f.type.startsWith(p))) { showError(err, new Error(`${f.name || 'That file'}: this file type is not allowed`)); continue; }
      if (f.size > MAX_BYTES) { showError(err, new Error(`${f.name}: files can be at most 10 MB`)); continue; }
      if (files.length >= 20) { showError(err, new Error('At most 20 attachments')); break; }
      files.push(f);
    }
    render();
  };
  const input = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: () => { add([...input.files]); input.value = ''; } });
  const onPaste = (e) => {
    const pasted = [...(e.clipboardData?.files || [])];
    if (!pasted.length) return; // normal text paste
    e.preventDefault();
    add(pasted.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${Date.now()}-${i + 1}.${f.type.split('/')[1] || 'png'}`, { type: f.type }))));
  };
  document.addEventListener('paste', onPaste);
  state.cleanups.push(() => document.removeEventListener('paste', onPaste));
  const drop = h('div', {
    class: 'drop',
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); add([...e.dataTransfer.files]); },
  },
  h('div', {}, h('b', {}, 'Paste a screenshot with Ctrl+V'), ' (⌘V on Mac), drag files here, or ', h('button', { type: 'button', class: 'link', onclick: () => input.click() }, 'browse'), '.'),
  h('div', { class: 'small' }, 'Images, videos, PDFs and Office documents · up to 10 MB each'), input, thumbs, err);
  return { el: drop, files, clear() { files.length = 0; render(); } };
}

function annotate(file, done) {
  const img = new Image();
  const src = URL.createObjectURL(file);
  img.onload = () => {
    const scale = Math.min(1, 2000 / img.naturalWidth);
    const W = Math.round(img.naturalWidth * scale);
    const H = Math.round(img.naturalHeight * scale);
    const canvas = h('canvas', { width: W, height: H });
    const ctx = canvas.getContext('2d');
    const shapes = [];
    let tool = 'rect';
    let color = '#ff2d2d';
    let cur = null;
    const lw = Math.max(3, Math.round(W / 250));
    const draw = (s) => {
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (s.type === 'pen') { ctx.beginPath(); s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
      else if (s.type === 'rect') ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
      else if (s.type === 'arrow') {
        const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1); const head = lw * 5;
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - head * Math.cos(a - 0.45), s.y2 - head * Math.sin(a - 0.45));
        ctx.lineTo(s.x2 - head * Math.cos(a + 0.45), s.y2 - head * Math.sin(a + 0.45)); ctx.closePath(); ctx.fill();
      }
    };
    const redraw = () => { ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); shapes.forEach(draw); if (cur) draw(cur); };
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); const [x, y] = pos(e); cur = { type: tool, color, x1: x, y1: y, x2: x, y2: y, pts: [[x, y]] }; });
    canvas.addEventListener('pointermove', (e) => { if (!cur) return; const [x, y] = pos(e); cur.x2 = x; cur.y2 = y; if (cur.type === 'pen') cur.pts.push([x, y]); redraw(); });
    const finish = () => { if (cur) { shapes.push(cur); cur = null; redraw(); } };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    const toolBtn = (id, text) => { const b = h('button', { type: 'button', class: tool === id ? 'on' : '', onclick: () => { tool = id; tools.querySelectorAll('button[data-tool]').forEach((x) => x.classList.toggle('on', x === b)); } }, text); b.dataset.tool = id; return b; };
    const tools = h('div', { class: 'tools' }, toolBtn('rect', '▭ Box'), toolBtn('arrow', '↗ Arrow'), toolBtn('pen', '✎ Draw'),
      h('input', { type: 'color', value: color, 'aria-label': 'Colour', oninput: (e) => { color = e.target.value; } }),
      h('button', { type: 'button', onclick: () => { shapes.pop(); redraw(); } }, 'Undo'),
      h('button', { type: 'button', onclick: () => { shapes.length = 0; redraw(); } }, 'Clear'),
      h('span', { style: 'flex:1' }),
      h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'button', class: 'primary', onclick: () => canvas.toBlob((blob) => {
        const base = file.name.replace(/\.[^.]+$/, '');
        done(new File([blob], `${base}-annotated.png`, { type: 'image/png' }));
        close();
      }, 'image/png') }, 'Save'));
    const close = modal('Annotate screenshot', h('div', { class: 'stack' }, tools, canvas), () => URL.revokeObjectURL(src));
    redraw();
  };
  img.src = src;
}

async function uploadAll(requestId, files) {
  const failed = [];
  for (const f of files) {
    try { await api('POST', `/api/requests/${requestId}/attachments`, f, { 'Content-Type': f.type, 'X-Filename': encodeURIComponent(f.name) }); }
    catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  return failed;
}

/* ------------------------------------------------------------ new request */

async function newRequestView(appId) {
  const { app } = await api('GET', `/api/apps/${appId}`);
  const err = errorBox();
  const title = h('input', { name: 'title', required: true, minLength: 3, maxLength: 150, placeholder: 'Short summary of the change' });
  const description = h('textarea', { name: 'description', maxLength: 10000, placeholder: 'What should change? Where? What is the expected result? Paste a screenshot anywhere on this page with Ctrl+V.' });
  const category = select('category', CATEGORY, 'improvement');
  const priority = select('priority', PRIORITY, 'medium');
  const picker = filePicker();
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Submit request');
  const form = h('form', {
    class: 'stack',
    async onsubmit(e) {
      e.preventDefault();
      err.classList.add('hidden');
      submit.disabled = true; submit.textContent = 'Submitting…';
      try {
        const { id, ref } = await api('POST', '/api/requests', { app_id: app.id, title: title.value, description: description.value, category: category.value, priority: priority.value });
        const failed = await uploadAll(id, picker.files);
        if (failed.length) alert(`${ref} was created, but some files failed to upload:\n\n${failed.join('\n')}\n\nYou can attach them again from the request page.`);
        go(`/request/${id}`);
      } catch (ex) { showError(err, ex); submit.disabled = false; submit.textContent = 'Submit request'; }
    },
  }, err,
  h('label', {}, 'Title', title),
  h('div', { class: 'form-grid' }, h('label', {}, 'Category', category), h('label', {}, 'Priority', priority)),
  h('label', {}, 'Description', description),
  h('div', { class: 'stack', style: 'gap:.4rem' }, h('b', {}, 'Screenshots & files'), picker.el),
  h('div', { class: 'row' }, submit, h('a', { class: 'btn', href: `#/app/${app.id}` }, 'Cancel')));
  layout('dashboard',
    h('div', { class: 'crumbs small' }, h('a', { href: '#/' }, 'Applications'), ' / ', h('a', { href: `#/app/${app.id}` }, app.name), ' / New request'),
    h('h1', {}, `Request a change to ${app.icon} ${app.name}`), form);
  title.focus();
}

/* ------------------------------------------------------------ request detail */

async function requestView(id) {
  const data = await api('GET', `/api/requests/${id}`);
  const { request: r, attachments, comments, activity, permissions: perm } = data;
  const users = isStaff() ? (await api('GET', '/api/users')).users.filter((u) => u.role !== 'requester') : [];
  const reload = () => requestView(id).catch(handleError);
  const patch = async (body) => { try { await api('PATCH', `/api/requests/${id}`, body); await reload(); } catch (e) { toast(e.message, false); } };

  // workflow buttons
  const actions = h('div', { class: 'actions' }, perm.transitions.map((to) => {
    const needsNote = (r.status === 'testing' && to === 'in_progress') || (r.status === 'completed' && to === 'in_progress') || to === 'rejected';
    const order = ['new', 'review', 'approved', 'in_progress', 'testing', 'completed'];
    const back = to !== 'rejected' && order.indexOf(to) < order.indexOf(r.status) && !(r.status === 'completed');
    const label = r.status === 'testing' && to === 'in_progress' ? 'Reject – needs corrections'
      : r.status === 'completed' && to === 'in_progress' ? 'Reopen'
      : back ? `← Back to ${STATUS[to]}` : NEXT_LABEL[to];
    return h('button', {
      class: to === 'rejected' ? 'danger' : back ? '' : (r.status === 'rejected' ? '' : 'primary'),
      onclick: () => needsNote ? noteModal(label, (note) => patch({ status: to, note })) : patch({ status: to }),
    }, label);
  }));

  const detailsEdit = perm.edit_details && h('button', { onclick: () => editModal(r, patch) }, 'Edit details');

  const meta = h('dl', { class: 'meta-list' },
    ...[
      ['Status', statusBadge(r.status)],
      ['Progress', h('div', { class: 'row' }, h('div', { style: 'flex:1' }, progressBar(r.progress, r.status === 'completed')), `${r.progress}%`)],
      ['Priority', priorityBadge(r.priority)],
      ['Category', CATEGORY[r.category]],
      ['Requested by', `${r.requester_name} · ${fmtDateTime(r.created_at)}`],
      ['Assignee', perm.manage
        ? (() => { const s = h('select', { 'aria-label': 'Assignee', onchange: () => patch({ assignee_id: s.value ? Number(s.value) : null }) }, h('option', { value: '' }, 'Unassigned'), users.map((u) => h('option', { value: u.id, selected: u.id === r.assignee_id }, `${u.name} (${ROLE[u.role]})`))); return s; })()
        : (r.assignee_name || '—')],
      ['Due date', perm.manage
        ? h('input', { type: 'date', value: r.due_date || '', 'aria-label': 'Due date', onchange: (e) => patch({ due_date: e.target.value || null }) })
        : (r.due_date ? h('span', { class: r.overdue ? 'overdue' : '' }, fmtDate(r.due_date), r.overdue ? ' (overdue)' : '') : '—')],
      perm.manage && r.status === 'in_progress' && ['Set progress', (() => { const range = h('input', { type: 'range', min: 0, max: 100, step: 5, value: r.progress, 'aria-label': 'Progress', onchange: () => patch({ progress: Number(range.value) }) }); return range; })()],
      r.completed_at && ['Completed', fmtDateTime(r.completed_at)],
    ].filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

  // attachments
  const gallery = h('div', { class: 'thumbs' }, attachments.map((a) => {
    const url = `/api/files/${a.id}`;
    const isImg = a.content_type.startsWith('image/');
    const isVid = a.content_type.startsWith('video/');
    return h('a', { class: 'thumb', href: url, target: '_blank', rel: 'noopener noreferrer', download: a.inline ? undefined : a.name, title: `${a.name} — ${a.uploader_name}` },
      h('div', { class: 'pic' }, isImg ? h('img', { src: url, alt: a.name, loading: 'lazy' }) : isVid ? h('video', { src: url, preload: 'metadata', muted: true }) : '📄'),
      h('div', { class: 'meta' }, a.name, h('div', { class: 'muted' }, fmtSize(a.size))));
  }));
  let adder = null;
  if (perm.attach) {
    const err = errorBox();
    const up = h('button', { class: 'primary', disabled: true }, 'Upload');
    const picker = filePicker((files) => { up.disabled = !files.length; });
    up.addEventListener('click', async () => {
      up.disabled = true; up.textContent = 'Uploading…';
      const failed = await uploadAll(id, picker.files);
      if (failed.length) { showError(err, new Error(failed.join('; '))); up.textContent = 'Upload'; up.disabled = false; picker.clear(); }
      else reload();
    });
    adder = h('details', {}, h('summary', { style: 'cursor:pointer' }, 'Add screenshots or files'), h('div', { class: 'stack', style: 'margin-top:.5rem' }, picker.el, err, up));
  }

  // comments
  const commentBox = h('textarea', { placeholder: 'Write a comment…', maxLength: 5000, style: 'min-height:80px' });
  const post = h('button', { class: 'primary', onclick: async () => {
    if (!commentBox.value.trim()) return;
    post.disabled = true;
    try { await api('POST', `/api/requests/${id}/comments`, { body: commentBox.value }); await reload(); } catch (e) { toast(e.message, false); post.disabled = false; }
  } }, 'Comment');

  layout('dashboard',
    h('div', { class: 'crumbs small' }, h('a', { href: '#/' }, 'Applications'), ' / ', h('a', { href: `#/app/${r.app_id}` }, `${r.app_icon} ${r.app_name}`), ' / ', r.ref),
    h('div', { class: 'row between' }, h('div', {}, h('div', { class: 'muted' }, r.ref), h('h1', {}, r.title)), h('div', { class: 'row' }, detailsEdit)),
    actions.children.length ? h('div', { class: 'card' }, h('div', { class: 'small muted', style: 'margin-bottom:.5rem' }, 'Next step'), actions) : null,
    h('div', { class: 'detail' },
      h('div', { class: 'stack' },
        h('div', { class: 'card stack' }, h('h2', {}, 'Description'), r.description ? h('div', { class: 'prose' }, r.description) : h('div', { class: 'muted' }, 'No description provided.')),
        h('div', { class: 'card stack' }, h('h2', {}, `Screenshots & files (${attachments.length})`), attachments.length ? gallery : h('div', { class: 'muted' }, 'Nothing attached yet.'), adder),
        h('div', { class: 'card stack' }, h('h2', {}, `Discussion (${comments.length})`),
          comments.length ? h('div', {}, comments.map((c) => h('div', { class: 'comment' }, h('div', {}, h('span', { class: 'who' }, c.user_name), ' ', badge('', ROLE[c.user_role]), ' ', h('span', { class: 'muted small' }, fmtDateTime(c.created_at))), h('div', { class: 'prose' }, c.body)))) : h('div', { class: 'muted' }, 'No comments yet.'),
          commentBox, h('div', {}, post))),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, meta),
        h('div', { class: 'card stack' }, h('h2', {}, 'Activity'),
          h('ul', { class: 'log' }, activity.map((a) => h('li', {}, h('b', {}, a.user_name || 'System'), ' ', ACTION_TEXT[a.action] || a.action, a.detail && `: ${a.detail}`, h('div', { class: 'muted small' }, fmtDateTime(a.created_at)))))))));
}

function noteModal(title, onSubmit) {
  const note = h('textarea', { placeholder: 'Explain what needs to change or why…', required: true, minLength: 3, maxLength: 2000 });
  const form = h('form', { class: 'stack', style: 'min-width:min(480px,86vw)', onsubmit: (e) => { e.preventDefault(); close(); onSubmit(note.value); } },
    h('label', {}, 'Note (saved as a comment)', note), h('button', { class: 'primary', type: 'submit' }, 'Confirm'));
  const close = modal(title, form);
  note.focus();
}

function editModal(r, patch) {
  const title = h('input', { value: r.title, required: true, minLength: 3, maxLength: 150 });
  const description = h('textarea', {}, r.description);
  const category = select('category', CATEGORY, r.category);
  const priority = select('priority', PRIORITY, r.priority);
  const form = h('form', { class: 'stack', style: 'min-width:min(560px,86vw)', onsubmit: (e) => { e.preventDefault(); close(); patch({ title: title.value, description: description.value, category: category.value, priority: priority.value }); } },
    h('label', {}, 'Title', title), h('div', { class: 'form-grid' }, h('label', {}, 'Category', category), h('label', {}, 'Priority', priority)),
    h('label', {}, 'Description', description), h('button', { class: 'primary', type: 'submit' }, 'Save'));
  const close = modal('Edit request', form);
}

/* ------------------------------------------------------------ team + account */

async function teamView() {
  if (state.user.role !== 'admin') return go('/');
  const { users } = await api('GET', '/api/users');
  const err = errorBox();
  const reveal = (who, pw) => {
    const box = h('div', { class: 'stack' }, h('p', {}, 'Share this temporary password with ', h('b', {}, who), '. It is shown only once, and they must change it when they first sign in.'), h('p', {}, h('code', { class: 'pw' }, pw)));
    modal('Temporary password', box, () => route());
  };
  const email = h('input', { type: 'email', required: true });
  const name = h('input', { required: true, maxLength: 100 });
  const role = select('role', ROLE, 'requester');
  const addForm = h('form', {
    class: 'card stack',
    async onsubmit(e) {
      e.preventDefault();
      try { const u = await api('POST', '/api/users', { email: email.value, name: name.value, role: role.value }); reveal(u.name, u.temp_password); }
      catch (ex) { showError(err, ex); }
    },
  }, h('h2', {}, 'Invite a teammate'), err,
  h('div', { class: 'form-grid' }, h('label', {}, 'Name', name), h('label', {}, 'Email', email), h('label', {}, 'Role', role)),
  h('div', {}, h('button', { class: 'primary', type: 'submit' }, 'Create account')));
  const act = async (u, body, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    try { const res = await api('PATCH', `/api/users/${u.id}`, body); if (res.temp_password) reveal(u.name, res.temp_password); else route(); } catch (ex) { toast(ex.message, false); }
  };
  layout('team', h('h1', {}, 'Team'),
    h('p', { class: 'muted' }, 'Admins manage apps and people. Developers run the workflow. Requesters submit changes and sign off on testing.'),
    addForm,
    h('div', { class: 'card table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => {
        const me = u.id === state.user.id;
        const roleSel = select('role', ROLE, u.role);
        roleSel.disabled = me;
        roleSel.addEventListener('change', () => act(u, { role: roleSel.value }));
        return h('tr', {}, h('td', {}, u.name, me && ' (you)'), h('td', {}, u.email), h('td', {}, roleSel), h('td', {}, u.disabled ? badge('s-rejected', 'Disabled') : badge('s-completed', 'Active')),
          h('td', { class: 'row' }, h('button', { onclick: () => act(u, { reset_password: true }, `Reset ${u.name}'s password? They will be signed out.`) }, 'Reset password'),
            !me && h('button', { class: u.disabled ? '' : 'danger', onclick: () => act(u, { disabled: !u.disabled }, u.disabled ? null : `Disable ${u.name}? They will be signed out.`) }, u.disabled ? 'Enable' : 'Disable')));
      })))));
}

function accountView() {
  const err = errorBox();
  const cur = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const next = h('input', { type: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
  const forced = state.user.must_change_password;
  const form = h('form', {
    class: 'card stack',
    async onsubmit(e) {
      e.preventDefault();
      try { await api('POST', '/api/me/password', { current_password: cur.value, new_password: next.value }); state.user.must_change_password = false; toast('Password changed'); go('/'); }
      catch (ex) { showError(err, ex); }
    },
  }, forced && h('div', { class: 'notice' }, 'You are using a temporary password. Choose a new one to continue.'), err,
  h('label', {}, 'Current password', cur), h('label', {}, 'New password', h('span', { class: 'hint' }, 'At least 10 characters'), next),
  h('div', {}, h('button', { class: 'primary', type: 'submit' }, 'Change password')));
  layout('', h('h1', {}, 'Account'), h('p', { class: 'muted' }, `${state.user.name} · ${state.user.email} · ${ROLE[state.user.role]}`), form);
}

/* ------------------------------------------------------------ router */

function handleError(e) {
  root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card stack' }, h('h2', {}, 'Something went wrong'), h('div', { class: 'error' }, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to dashboard'))));
}

async function route() {
  state.cleanups.splice(0).forEach((fn) => fn());
  document.querySelectorAll('.modal').forEach((m) => m.remove());
  const path = location.hash.replace(/^#/, '') || '/';
  try {
    if (!state.user) {
      try { state.user = (await api('GET', '/api/me')).user; } catch { /* not signed in */ }
    }
    if (!state.user) return path === '/login' ? await loginView() : go('/login');
    if (path === '/login') return go('/');
    if (state.user.must_change_password && path !== '/account') return go('/account');
    let m;
    if (path === '/') await dashboardView();
    else if (path === '/requests') await allRequestsView();
    else if (path === '/team') await teamView();
    else if (path === '/account') accountView();
    else if ((m = path.match(/^\/app\/(\d+)\/new$/))) await newRequestView(m[1]);
    else if ((m = path.match(/^\/app\/(\d+)$/))) await appView(m[1]);
    else if ((m = path.match(/^\/request\/(\d+)$/))) await requestView(m[1]);
    else go('/');
  } catch (e) { handleError(e); }
}

window.addEventListener('hashchange', route);
route();
