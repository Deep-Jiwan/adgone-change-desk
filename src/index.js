import {
  assertNotThrottled, checkNewPassword, clearFailures, createSession, currentUser, destroySession,
  hashPassword, purgeExpired, recordFailure, sessionCookie, sessionToken, verifyPassword,
} from './auth.js';
import {
  CATEGORIES, DEFAULT_PROGRESS, PRIORITIES, ROLES, STATUSES, allowedTransitions, canEditDetails,
  canTransition, isStaff, noteRequired,
} from './workflow.js';
import {
  HttpError, csvCell, httpUrlOrEmpty, json, oneOf, optionalDate, randomToken, readJson, sha256Hex, str, tempPassword,
} from './util.js';

const CSRF_HEADER = 'change-desk';
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
// SVG is deliberately absent (script risk). Only images/video are displayed inline; the rest download.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);
const DOWNLOAD_TYPES = new Set([
  'application/pdf', 'text/plain', 'text/csv', 'application/zip',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const REF = `a.key || '-' || printf('%04d', r.seq)`;
const OVERDUE = `(r.due_date IS NOT NULL AND r.due_date < date('now') AND r.status NOT IN ('completed','rejected'))`;
const REQUEST_SELECT = `
  SELECT r.id, r.app_id, r.seq, ${REF} AS ref, r.title, r.description, r.category, r.priority, r.status,
         r.progress, r.requester_id, r.assignee_id, r.due_date, r.completed_at, r.created_at, r.updated_at,
         ${OVERDUE} AS overdue,
         a.name AS app_name, a.icon AS app_icon, a.key AS app_key,
         ru.name AS requester_name, au.name AS assignee_name
    FROM requests r
    JOIN apps a ON a.id = r.app_id
    JOIN users ru ON ru.id = r.requester_id
    LEFT JOIN users au ON au.id = r.assignee_id`;

const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

const logActivity = (env, requestId, userId, action, detail = '') =>
  run(env, 'INSERT INTO activity (request_id, user_id, action, detail) VALUES (?, ?, ?, ?)', requestId, userId, action, detail);

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, 'You do not have permission to do that');
}

const idParam = (s) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'Not found');
  return n;
};

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, must_change_password: !!u.must_change_password });

// ---------------------------------------------------------------- routes

const routes = []; // [method, regex, handler, {auth}]
function route(method, pattern, handler, { auth = true } = {}) {
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push([method, regex, handler, auth]);
}

// ---- auth / session
route('GET', '/api/setup', async ({ env }) => {
  const row = await first(env, 'SELECT COUNT(*) AS n FROM users');
  return json({ needsSetup: row.n === 0 });
}, { auth: false });

route('POST', '/api/setup', async ({ env, request, url }) => {
  const body = await readJson(request);
  const email = str(body.email, 'Email', { min: 3, max: 200 }).toLowerCase();
  const name = str(body.name, 'Name', { min: 1, max: 100 });
  checkNewPassword(body.password);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  const hash = await hashPassword(body.password);
  // Atomic: only succeeds while the table is empty, so two racing setups cannot both become admin.
  const res = await run(env,
    `INSERT INTO users (email, name, role, password_hash) SELECT ?, ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    email, name, hash);
  if (!res.meta.changes) throw new HttpError(409, 'Setup has already been completed');
  const user = await first(env, 'SELECT * FROM users WHERE email = ?', email);
  const token = await createSession(env, user.id);
  return json({ user: publicUser(user) }, 201, { 'Set-Cookie': sessionCookie(token, url) });
}, { auth: false });

route('POST', '/api/login', async ({ env, request, url }) => {
  const body = await readJson(request);
  const email = str(body.email, 'Email', { max: 200 }).toLowerCase();
  if (typeof body.password !== 'string') throw new HttpError(400, 'Password is required');
  await assertNotThrottled(env, email);
  const user = await first(env, 'SELECT * FROM users WHERE email = ?', email);
  const ok = await verifyPassword(body.password, user?.password_hash);
  if (!user || !ok || user.disabled) {
    await recordFailure(env, email);
    throw new HttpError(401, 'Incorrect email or password');
  }
  await clearFailures(env, email);
  const token = await createSession(env, user.id);
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token, url) });
}, { auth: false });

route('POST', '/api/logout', async ({ env, request, url }) => {
  const token = sessionToken(request);
  if (token) await destroySession(env, token);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', url, 0) });
}, { auth: false });

// Not an error when signed out: the frontend uses this to decide whether to show the login screen.
route('GET', '/api/me', async ({ env, request }) => {
  const user = await currentUser(env, request);
  return json({ user: user ? publicUser(user) : null });
}, { auth: false });

route('POST', '/api/me/password', async ({ env, request, user }) => {
  const body = await readJson(request);
  checkNewPassword(body.new_password);
  const row = await first(env, 'SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!(await verifyPassword(String(body.current_password ?? ''), row.password_hash)))
    throw new HttpError(403, 'Current password is incorrect');
  await run(env, 'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', await hashPassword(body.new_password), user.id);
  // sign out every other device
  await run(env, 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', user.id, await sessionHash(request));
  return json({ ok: true });
});

const sessionHash = (request) => sha256Hex(sessionToken(request) || '');

// ---- users (team)
route('GET', '/api/users', async ({ env, user }) => {
  const rows = await all(env, `SELECT id, name, role, disabled${user.role === 'admin' ? ', email, created_at' : ''} FROM users ORDER BY name`);
  return json({ users: user.role === 'admin' ? rows : rows.filter((u) => !u.disabled) });
});

route('POST', '/api/users', async ({ env, request, user }) => {
  requireRole(user, 'admin');
  const body = await readJson(request);
  const email = str(body.email, 'Email', { min: 3, max: 200 }).toLowerCase();
  const name = str(body.name, 'Name', { min: 1, max: 100 });
  const role = oneOf(body.role, ROLES, 'role');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (await first(env, 'SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'A user with that email already exists');
  const password = tempPassword();
  const res = await run(env,
    'INSERT INTO users (email, name, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1)',
    email, name, role, await hashPassword(password));
  return json({ id: res.meta.last_row_id, email, name, role, temp_password: password }, 201);
});

route('PATCH', '/api/users/:id', async ({ env, request, user, params }) => {
  requireRole(user, 'admin');
  const id = idParam(params.id);
  const target = await first(env, 'SELECT * FROM users WHERE id = ?', id);
  if (!target) throw new HttpError(404, 'User not found');
  const body = await readJson(request);
  if (id === user.id && (body.role !== undefined || body.disabled !== undefined))
    throw new HttpError(400, 'You cannot change your own role or disable yourself');
  const out = {};
  if (body.role !== undefined) {
    await run(env, 'UPDATE users SET role = ? WHERE id = ?', oneOf(body.role, ROLES, 'role'), id);
  }
  if (body.disabled !== undefined) {
    await run(env, 'UPDATE users SET disabled = ? WHERE id = ?', body.disabled ? 1 : 0, id);
    if (body.disabled) await run(env, 'DELETE FROM sessions WHERE user_id = ?', id);
  }
  if (body.reset_password) {
    const password = tempPassword();
    await run(env, 'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', await hashPassword(password), id);
    await run(env, 'DELETE FROM sessions WHERE user_id = ?', id);
    out.temp_password = password;
  }
  return json({ ok: true, ...out });
});

// ---- apps
const APP_COUNTS = `
  SELECT a.*,
    COALESCE(SUM(r.status IN ('new','review','approved')), 0) AS pending,
    COALESCE(SUM(r.status IN ('in_progress','testing')), 0) AS in_progress,
    COALESCE(SUM(r.status = 'completed'), 0) AS completed,
    COALESCE(SUM(${OVERDUE}), 0) AS overdue
  FROM apps a LEFT JOIN requests r ON r.app_id = a.id`;

route('GET', '/api/apps', async ({ env }) => json({ apps: await all(env, `${APP_COUNTS} GROUP BY a.id ORDER BY a.name COLLATE NOCASE`) }));

route('GET', '/api/apps/:id', async ({ env, params }) => {
  const app = await first(env, `${APP_COUNTS} WHERE a.id = ? GROUP BY a.id`, idParam(params.id));
  if (!app) throw new HttpError(404, 'App not found');
  return json({ app });
});

function appFields(body, { creating }) {
  const f = {};
  if (creating || body.name !== undefined) f.name = str(body.name, 'Name', { min: 1, max: 80 });
  if (body.icon !== undefined) f.icon = str(body.icon, 'Icon', { min: 1, max: 8 });
  if (body.version !== undefined) f.version = str(body.version, 'Version', { max: 40 });
  if (body.status !== undefined) f.status = oneOf(body.status, ['active', 'maintenance', 'retired'], 'status');
  if (body.description !== undefined) f.description = str(body.description, 'Description', { max: 500 });
  if (body.repo_url !== undefined) f.repo_url = httpUrlOrEmpty(body.repo_url, 'Repository URL');
  return f;
}

route('POST', '/api/apps', async ({ env, request, user }) => {
  requireRole(user, 'admin');
  const body = await readJson(request);
  const key = str(body.key, 'Key', { min: 2, max: 10 }).toUpperCase();
  if (!/^[A-Z][A-Z0-9]*$/.test(key)) throw new HttpError(400, 'Key must be 2-10 letters/digits and start with a letter');
  if (await first(env, 'SELECT 1 FROM apps WHERE key = ?', key)) throw new HttpError(409, 'That key is already used by another app');
  const f = appFields(body, { creating: true });
  const row = { icon: '📦', version: '', status: 'active', description: '', repo_url: '', ...f };
  const res = await run(env,
    'INSERT INTO apps (key, name, icon, version, status, description, repo_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
    key, row.name, row.icon, row.version, row.status, row.description, row.repo_url);
  return json({ id: res.meta.last_row_id }, 201);
});

route('PATCH', '/api/apps/:id', async ({ env, request, user, params }) => {
  requireRole(user, 'admin');
  const id = idParam(params.id);
  if (!(await first(env, 'SELECT 1 FROM apps WHERE id = ?', id))) throw new HttpError(404, 'App not found');
  const f = appFields(await readJson(request), { creating: false });
  const cols = Object.keys(f);
  if (cols.length) await run(env, `UPDATE apps SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => f[c]), id);
  return json({ ok: true });
});

// ---- requests
function filterQuery(url, user) {
  const q = url.searchParams;
  const where = [];
  const args = [];
  if (q.get('app')) { where.push('r.app_id = ?'); args.push(idParam(q.get('app'))); }
  if (q.get('status')) {
    const statuses = q.get('status').split(',');
    for (const s of statuses) oneOf(s, STATUSES, 'status');
    where.push(`r.status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }
  if (q.get('priority')) { where.push('r.priority = ?'); args.push(oneOf(q.get('priority'), PRIORITIES, 'priority')); }
  if (q.get('category')) { where.push('r.category = ?'); args.push(oneOf(q.get('category'), CATEGORIES, 'category')); }
  if (q.get('assignee') === 'me') { where.push('r.assignee_id = ?'); args.push(user.id); }
  else if (q.get('assignee') === 'none') where.push('r.assignee_id IS NULL');
  else if (q.get('assignee')) { where.push('r.assignee_id = ?'); args.push(idParam(q.get('assignee'))); }
  if (q.get('requester') === 'me') { where.push('r.requester_id = ?'); args.push(user.id); }
  else if (q.get('requester')) { where.push('r.requester_id = ?'); args.push(idParam(q.get('requester'))); }
  if (q.get('overdue') === '1') where.push(OVERDUE);
  if (q.get('from')) { where.push('date(r.created_at) >= ?'); args.push(optionalDate(q.get('from'), 'from')); }
  if (q.get('to')) { where.push('date(r.created_at) <= ?'); args.push(optionalDate(q.get('to'), 'to')); }
  if (q.get('q')) {
    const term = `%${q.get('q').slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`;
    where.push(`(r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR ${REF} LIKE ? ESCAPE '\\')`);
    args.push(term, term, term);
  }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', args };
}

route('GET', '/api/requests', async ({ env, url, user }) => {
  const { sql, args } = filterQuery(url, user);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
  const rows = await all(env, `${REQUEST_SELECT}${sql} ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`, ...args, limit);
  return json({ requests: rows });
});

route('GET', '/api/export.csv', async ({ env, url, user }) => {
  requireRole(user, 'admin', 'developer');
  const { sql, args } = filterQuery(url, user);
  const rows = await all(env, `${REQUEST_SELECT}${sql} ORDER BY r.id`, ...args);
  const header = ['ID', 'App', 'Title', 'Category', 'Priority', 'Status', 'Progress %', 'Requester', 'Assignee', 'Due', 'Overdue', 'Created', 'Updated', 'Completed'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([r.ref, r.app_name, r.title, r.category, r.priority, r.status, r.progress, r.requester_name,
      r.assignee_name, r.due_date, r.overdue ? 'yes' : 'no', r.created_at, r.updated_at, r.completed_at].map(csvCell).join(','));
  }
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="change-requests.csv"',
      'Cache-Control': 'no-store',
    },
  });
});

route('POST', '/api/requests', async ({ env, request, user }) => {
  const body = await readJson(request);
  const appId = idParam(body.app_id);
  const title = str(body.title, 'Title', { min: 3, max: 150 });
  const description = str(body.description, 'Description', { max: 10000 });
  const category = oneOf(body.category, CATEGORIES, 'category');
  const priority = oneOf(body.priority, PRIORITIES, 'priority');
  const app = await first(env, 'SELECT id, status FROM apps WHERE id = ?', appId);
  if (!app) throw new HttpError(404, 'App not found');
  if (app.status === 'retired') throw new HttpError(400, 'This app is retired and no longer accepts requests');
  const taken = await first(env, 'UPDATE apps SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq', appId);
  const res = await run(env,
    `INSERT INTO requests (app_id, seq, title, description, category, priority, requester_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    appId, taken.seq, title, description, category, priority, user.id);
  const id = res.meta.last_row_id;
  await logActivity(env, id, user.id, 'created');
  const created = await first(env, `${REQUEST_SELECT} WHERE r.id = ?`, id);
  return json({ id, ref: created.ref }, 201);
});

async function loadRequest(env, id) {
  const r = await first(env, `${REQUEST_SELECT} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'Request not found');
  return r;
}

route('GET', '/api/requests/:id', async ({ env, user, params }) => {
  const id = idParam(params.id);
  const request = await loadRequest(env, id);
  const [attachments, comments, activity] = await Promise.all([
    all(env, `SELECT t.id, t.name, t.content_type, t.size, t.created_at, u.name AS uploader_name
                FROM attachments t JOIN users u ON u.id = t.uploader_id WHERE t.request_id = ? ORDER BY t.id`, id),
    all(env, `SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name, u.role AS user_role
                FROM comments c JOIN users u ON u.id = c.user_id WHERE c.request_id = ? ORDER BY c.id`, id),
    all(env, `SELECT x.id, x.action, x.detail, x.created_at, u.name AS user_name
                FROM activity x LEFT JOIN users u ON u.id = x.user_id WHERE x.request_id = ? ORDER BY x.id DESC`, id),
  ]);
  return json({
    request,
    attachments: attachments.map((a) => ({ ...a, inline: INLINE_TYPES.has(a.content_type) })),
    comments,
    activity,
    permissions: {
      transitions: allowedTransitions(user, request),
      edit_details: canEditDetails(user, request),
      manage: isStaff(user),
      attach: isStaff(user) || request.requester_id === user.id,
    },
  });
});

const label = (s) => s.replace('_', ' ');

route('PATCH', '/api/requests/:id', async ({ env, request, user, params }) => {
  const id = idParam(params.id);
  const body = await readJson(request);
  const current = await loadRequest(env, id);
  const staff = isStaff(user);
  const changes = []; // [column, value]
  const log = []; // [action, detail]

  // descriptive fields
  const detailKeys = ['title', 'description', 'category', 'priority'].filter((k) => body[k] !== undefined);
  if (detailKeys.length && !canEditDetails(user, current)) throw new HttpError(403, 'You can no longer edit this request');
  if (body.title !== undefined) { const v = str(body.title, 'Title', { min: 3, max: 150 }); if (v !== current.title) { changes.push(['title', v]); log.push(['edited', 'title']); } }
  if (body.description !== undefined) { const v = str(body.description, 'Description', { max: 10000 }); if (v !== current.description) { changes.push(['description', v]); log.push(['edited', 'description']); } }
  if (body.category !== undefined) { const v = oneOf(body.category, CATEGORIES, 'category'); if (v !== current.category) { changes.push(['category', v]); log.push(['category', `${current.category} → ${v}`]); } }
  if (body.priority !== undefined) { const v = oneOf(body.priority, PRIORITIES, 'priority'); if (v !== current.priority) { changes.push(['priority', v]); log.push(['priority', `${current.priority} → ${v}`]); } }

  // staff-only planning fields
  const planningKeys = ['assignee_id', 'due_date', 'progress'].filter((k) => body[k] !== undefined);
  if (planningKeys.length && !staff) throw new HttpError(403, 'Only developers and admins can change assignment, due date or progress');
  if (body.assignee_id !== undefined) {
    let v = null;
    if (body.assignee_id !== null) {
      v = idParam(body.assignee_id);
      const dev = await first(env, `SELECT name FROM users WHERE id = ? AND disabled = 0 AND role IN ('admin','developer')`, v);
      if (!dev) throw new HttpError(400, 'Assignee must be an active developer or admin');
    }
    if (v !== current.assignee_id) {
      changes.push(['assignee_id', v]);
      log.push(['assigned', v ? (await first(env, 'SELECT name FROM users WHERE id = ?', v)).name : 'unassigned']);
    }
  }
  if (body.due_date !== undefined) {
    const v = optionalDate(body.due_date, 'Due date');
    if (v !== current.due_date) { changes.push(['due_date', v]); log.push(['due', v || 'cleared']); }
  }
  if (body.progress !== undefined) {
    const v = Number(body.progress);
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new HttpError(400, 'Progress must be a whole number from 0 to 100');
    if (current.status !== 'in_progress' && body.status === undefined) throw new HttpError(400, 'Progress can only be set while the request is in progress');
    if (v !== current.progress) { changes.push(['progress', v]); log.push(['progress', `${v}%`]); }
  }

  // status
  let note = null;
  if (body.status !== undefined) {
    const to = oneOf(body.status, STATUSES, 'status');
    if (to !== current.status) {
      if (!canTransition(user, current, current.status, to)) throw new HttpError(403, `You cannot move this request from ${label(current.status)} to ${label(to)}`);
      if (noteRequired(current.status, to)) note = str(body.note, 'A note explaining this change', { min: 3, max: 2000 });
      else if (body.note) note = str(body.note, 'Note', { max: 2000 });
      changes.push(['status', to]);
      const progressIdx = changes.findIndex(([c]) => c === 'progress');
      if (progressIdx >= 0) changes.splice(progressIdx, 1);
      changes.push(['progress', body.progress !== undefined && to === 'in_progress' ? Number(body.progress) : DEFAULT_PROGRESS[to]]);
      changes.push(['completed_at', to === 'completed' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null]);
      log.push(['status', `${label(current.status)} → ${label(to)}`]);
    }
  }

  if (!changes.length) return json({ ok: true, changed: false });
  const cols = changes.map(([c]) => `${c} = ?`).join(', ');
  await run(env, `UPDATE requests SET ${cols}, updated_at = datetime('now') WHERE id = ?`, ...changes.map(([, v]) => v), id);
  for (const [action, detail] of log) await logActivity(env, id, user.id, action, detail);
  if (note) await run(env, 'INSERT INTO comments (request_id, user_id, body) VALUES (?, ?, ?)', id, user.id, note);
  return json({ ok: true, changed: true });
});

route('POST', '/api/requests/:id/comments', async ({ env, request, user, params }) => {
  const id = idParam(params.id);
  await loadRequest(env, id);
  const body = str((await readJson(request)).body, 'Comment', { min: 1, max: 5000 });
  const res = await run(env, 'INSERT INTO comments (request_id, user_id, body) VALUES (?, ?, ?)', id, user.id, body);
  await run(env, `UPDATE requests SET updated_at = datetime('now') WHERE id = ?`, id);
  return json({ id: res.meta.last_row_id }, 201);
});

// ---- attachments
route('POST', '/api/requests/:id/attachments', async ({ env, request, user, params }) => {
  const id = idParam(params.id);
  const r = await loadRequest(env, id);
  if (!isStaff(user) && r.requester_id !== user.id) throw new HttpError(403, 'Only the requester or the team can attach files');
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!INLINE_TYPES.has(type) && !DOWNLOAD_TYPES.has(type)) throw new HttpError(415, 'That file type is not allowed');
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > MAX_UPLOAD) throw new HttpError(413, 'Files can be at most 10 MB');
  const count = await first(env, 'SELECT COUNT(*) AS n FROM attachments WHERE request_id = ?', id);
  if (count.n >= MAX_ATTACHMENTS) throw new HttpError(400, `A request can have at most ${MAX_ATTACHMENTS} attachments`);
  let name = 'file';
  try { name = decodeURIComponent(request.headers.get('X-Filename') || 'file'); } catch { /* keep default */ }
  name = name.replace(/[\u0000-\u001f"\\/]/g, '_').slice(0, 120) || 'file';
  const data = await request.arrayBuffer();
  if (!data.byteLength) throw new HttpError(400, 'Empty file');
  if (data.byteLength > MAX_UPLOAD) throw new HttpError(413, 'Files can be at most 10 MB');
  const key = `requests/${id}/${randomToken(16)}`;
  await env.FILES.put(key, data, { httpMetadata: { contentType: type } });
  const res = await run(env,
    'INSERT INTO attachments (request_id, r2_key, name, content_type, size, uploader_id) VALUES (?, ?, ?, ?, ?, ?)',
    id, key, name, type, data.byteLength, user.id);
  await logActivity(env, id, user.id, 'attachment', name);
  await run(env, `UPDATE requests SET updated_at = datetime('now') WHERE id = ?`, id);
  return json({ id: res.meta.last_row_id }, 201);
});

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(size - Number(m[2]), 0); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start <= end && start < size ? { start, end } : 'invalid';
}

route('GET', '/api/files/:id', async ({ env, request, params }) => {
  const a = await first(env, 'SELECT * FROM attachments WHERE id = ?', idParam(params.id));
  if (!a) throw new HttpError(404, 'File not found');
  const range = parseRange(request.headers.get('Range'), a.size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${a.size}` } });
  const obj = await env.FILES.get(a.r2_key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!obj) throw new HttpError(404, 'File not found');
  const inline = INLINE_TYPES.has(a.content_type);
  const headers = {
    'Content-Type': a.content_type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=3600',
    'Accept-Ranges': 'bytes',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${a.size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
    return new Response(obj.body, { status: 206, headers });
  }
  headers['Content-Length'] = String(a.size);
  return new Response(obj.body, { headers });
});

// ---------------------------------------------------------------- dispatcher

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  try {
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    let matched = null;
    let pathMatched = false;
    for (const [m, regex, handler, auth] of routes) {
      const hit = regex.exec(url.pathname);
      if (!hit) continue;
      pathMatched = true;
      if (m === method) { matched = { handler, auth, params: hit.groups || {} }; break; }
    }
    if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');

    if (method !== 'GET') {
      // CSRF defence in depth: custom header (forces a CORS preflight) + same-origin check.
      if (request.headers.get('X-Requested-With') !== CSRF_HEADER) throw new HttpError(403, 'Missing request header');
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin requests are not allowed');
    }

    let user = null;
    if (matched.auth) {
      user = await currentUser(env, request);
      if (!user) throw new HttpError(401, 'Please sign in');
      if (user.must_change_password && !(url.pathname === '/api/me' || url.pathname === '/api/me/password'))
        throw new HttpError(403, 'You must change your temporary password first');
    }
    if (url.pathname === '/api/login') ctx?.waitUntil(purgeExpired(env));
    return await matched.handler({ env, request, url, user, params: matched.params });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong' }, 500);
  }
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
