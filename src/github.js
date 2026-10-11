// GitHub integration.
//
// Direction of data:
//   desk -> GitHub : a ticket created in the desk becomes a GitHub issue; edits, comments, attachments and
//                    status changes follow.
//   GitHub -> desk : ONLY for issues the desk itself created: closing/reopening and new comments are reflected
//                    back. Issues that were not created by the desk are never imported.
//
// Every GitHub call is best-effort: a failure is recorded on the request (github_error) and never blocks or
// rolls back the desk action that triggered it.

import { HttpError, all, first, hex, run } from './util.js';
import { DEFAULT_PROGRESS } from './workflow.js';

const enc = new TextEncoder();
const MARKER = '<!-- change-desk -->';
const STATUS_LABEL = { new: 'New', review: 'Under Review', approved: 'Approved', in_progress: 'In Progress', testing: 'Testing', completed: 'Completed', rejected: 'Rejected' };

export const githubEnabled = (env) => typeof env.ENCRYPTION_KEY === 'string' && env.ENCRYPTION_KEY.length >= 16;
export const oauthEnabled = (env) => githubEnabled(env) && Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
export const apiBase = (env) => (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
export const webBase = (env) => (env.GITHUB_WEB_URL || 'https://github.com').replace(/\/+$/, '');

export function requireEnabled(env) {
  if (!githubEnabled(env))
    throw new HttpError(503, 'GitHub integration is not configured: set the ENCRYPTION_KEY secret (at least 16 characters) on the Worker.');
}

/* ------------------------------------------------------------------ crypto */

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`change-desk:tokens:${env.ENCRYPTION_KEY}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(token));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function decryptToken(env, stored) {
  const [v, iv, ct] = String(stored).split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('Unrecognised token format');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct));
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error('Could not decrypt the stored GitHub token (was ENCRYPTION_KEY changed? Re-add the connection)');
  }
}

const hmacKey = (secret, usage) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

/** Per-app webhook secret, derived (not stored) so it can always be shown to the admin for manual setup. */
export async function webhookSecret(env, appId) {
  return hex(await crypto.subtle.sign('HMAC', await hmacKey(env.ENCRYPTION_KEY, 'sign'), enc.encode(`change-desk:webhook:${appId}`)));
}

export async function verifySignature(secret, rawBody, header) {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header || '');
  if (!m) return false;
  const sig = Uint8Array.from(m[1].match(/../g), (h) => parseInt(h, 16));
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sig, rawBody); // constant-time
}

/* --------------------------------------------------------------- API client */

export class GithubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function gh(env, token, method, path, body) {
  let res;
  try {
    res = await fetch(apiBase(env) + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'change-desk',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new GithubError(0, `Could not reach GitHub (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const detail = data?.message || (typeof data === 'string' ? data.slice(0, 120) : '');
    const hint = res.status === 401 ? 'GitHub rejected the token' : res.status === 403 ? 'GitHub denied access (token permissions or rate limit)' : res.status === 404 ? 'GitHub could not find that (check the repo name and token access)' : `GitHub error ${res.status}`;
    throw new GithubError(res.status, detail && detail !== hint ? `${hint}: ${detail}` : hint);
  }
  return data;
}

/** Accepts "owner/name" or a github.com URL. Returns "owner/name" or throws. */
export function parseRepo(value) {
  let v = String(value || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  v = v.replace(/^https?:\/\/[^/]+\//, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) || v.split('/').some((part) => /^\.+$/.test(part)))
    throw new HttpError(400, 'Repository must look like owner/name');
  return v;
}

/* -------------------------------------------------------------- connections */

export async function addConnection(env, { label, kind, token, userId }) {
  requireEnabled(env);
  let who;
  try { who = await gh(env, token, 'GET', '/user'); }
  catch (e) { throw new HttpError(400, `That token did not work: ${e.message}`); }
  const tokenEnc = await encryptToken(env, token);
  if (kind === 'oauth') {
    const existing = await first(env, `SELECT id FROM github_connections WHERE kind = 'oauth' AND login = ?`, who.login);
    if (existing) {
      await run(env, 'UPDATE github_connections SET token_enc = ?, label = ? WHERE id = ?', tokenEnc, label, existing.id);
      return { id: existing.id, login: who.login };
    }
  }
  const res = await run(env, 'INSERT INTO github_connections (label, kind, login, token_enc, created_by) VALUES (?, ?, ?, ?, ?)', label, kind, who.login, tokenEnc, userId);
  return { id: res.meta.last_row_id, login: who.login };
}

/** Returns { repo, token } when the app is fully linked, else null. */
async function linkFor(env, appId) {
  const row = await first(env,
    `SELECT a.github_repo, c.token_enc FROM apps a JOIN github_connections c ON c.id = a.github_connection_id
      WHERE a.id = ? AND a.github_repo != ''`, appId);
  if (!row) return null;
  return { repo: row.github_repo, token: await decryptToken(env, row.token_enc) };
}

/* ------------------------------------------------------- linking an app */

export const webhookUrl = (origin, appId) => `${origin}/api/github/webhook/${appId}`;

/** Best-effort removal of the webhook the desk created for an app. */
export async function removeWebhook(env, app) {
  if (!app.github_webhook_id || !app.github_repo || !app.github_connection_id) return;
  try {
    const conn = await first(env, 'SELECT token_enc FROM github_connections WHERE id = ?', app.github_connection_id);
    if (!conn) return;
    await gh(env, await decryptToken(env, conn.token_enc), 'DELETE', `/repos/${app.github_repo}/hooks/${app.github_webhook_id}`);
  } catch (e) {
    console.error('Could not remove GitHub webhook', e.message);
  }
}

/** Verify access to the repo and register (or refresh) the webhook that carries GitHub -> desk updates. */
export async function linkApp(env, { app, connectionId, repo, origin }) {
  requireEnabled(env);
  const conn = await first(env, 'SELECT * FROM github_connections WHERE id = ?', connectionId);
  if (!conn) throw new HttpError(400, 'Choose a GitHub connection first');
  const token = await decryptToken(env, conn.token_enc);

  let info;
  try { info = await gh(env, token, 'GET', `/repos/${repo}`); }
  catch (e) { throw new HttpError(400, e.message); }
  if (info.has_issues === false) throw new HttpError(400, 'Issues are turned off on that repository. Enable them in its settings first.');
  if (info.permissions && !(info.permissions.push || info.permissions.triage || info.permissions.admin))
    throw new HttpError(400, 'This connection can read the repository but not create issues in it (needs write or triage access).');

  if (app.github_webhook_id && (app.github_repo !== info.full_name || app.github_connection_id !== conn.id)) await removeWebhook(env, app);

  const url = webhookUrl(origin, app.id);
  const secret = await webhookSecret(env, app.id);
  const config = { url, content_type: 'json', secret, insecure_ssl: '0' };
  let hookId = null;
  let webhook = 'created';
  try {
    const hooks = await gh(env, token, 'GET', `/repos/${info.full_name}/hooks`);
    const existing = Array.isArray(hooks) ? hooks.find((h) => h.config?.url === url) : null;
    if (existing) {
      await gh(env, token, 'PATCH', `/repos/${info.full_name}/hooks/${existing.id}`, { active: true, events: ['issues', 'issue_comment'], config });
      hookId = existing.id;
    } else {
      hookId = (await gh(env, token, 'POST', `/repos/${info.full_name}/hooks`, { name: 'web', active: true, events: ['issues', 'issue_comment'], config })).id;
    }
  } catch (e) {
    webhook = 'manual'; // token lacks webhook permission: admin adds it by hand (details returned to the UI)
    console.error('Webhook setup failed', e.message);
  }

  await run(env,
    `UPDATE apps SET github_connection_id = ?, github_repo = ?, github_webhook_id = ?,
            repo_url = CASE WHEN repo_url = '' THEN ? ELSE repo_url END WHERE id = ?`,
    conn.id, info.full_name, hookId, info.html_url || '', app.id);
  return { repo: info.full_name, webhook, webhook_url: url, ...(webhook === 'manual' ? { webhook_secret: secret } : {}) };
}

export async function unlinkApp(env, app) {
  await removeWebhook(env, app);
  await run(env, `UPDATE apps SET github_connection_id = NULL, github_repo = '', github_webhook_id = NULL WHERE id = ?`, app.id);
}

/* --------------------------------------------------------- desk -> GitHub */

// Stop untrusted desk text from pinging GitHub users.
const neutralise = (s) => String(s || '').replace(/@(?=[A-Za-z0-9])/g, '@​');
const labelsFor = (r) => ['change-desk', `type:${r.category}`, `priority:${r.priority}`];
const refOf = (r) => `${r.app_key}-${String(r.seq).padStart(4, '0')}`;

async function issueBody(env, r, origin) {
  const files = await all(env, 'SELECT name FROM attachments WHERE request_id = ? ORDER BY id', r.id);
  const link = `${origin}/#/request/${r.id}`;
  const lines = [
    neutralise(r.description) || '_No description provided._',
    '',
    '---',
    `**Change Desk** · [${refOf(r)}](${link}) · ${r.category} · priority ${r.priority}`,
    `Requested by ${neutralise(r.requester_name)}`,
  ];
  if (files.length) {
    lines.push('', `**Attachments (${files.length})** – screenshots and files live in Change Desk, [open the request](${link}) to view them:`,
      ...files.map((f) => `- ${neutralise(f.name).replace(/[<>[\]]/g, '')}`));
  }
  lines.push('', `<!-- change-desk:${refOf(r)} -->`);
  return lines.join('\n');
}

/**
 * Push the current desk state of a request to its GitHub issue.
 *   opts.create   create the issue if the request has none (otherwise requests without an issue are skipped)
 *   opts.state    also set open/closed from the desk status
 *   opts.labels   { remove: [...], add: [...] }
 *   opts.comment  { text, deskCommentId? } post a comment on the issue
 *   opts.commentOnly  skip updating the issue itself
 * Never throws: failures are stored on the request.
 */
export async function syncIssue(env, requestId, origin, opts = {}) {
  if (!githubEnabled(env)) return;
  try {
    const r = await first(env,
      `SELECT r.*, a.key AS app_key, u.name AS requester_name
         FROM requests r JOIN apps a ON a.id = r.app_id JOIN users u ON u.id = r.requester_id WHERE r.id = ?`, requestId);
    if (!r) return;
    const link = await linkFor(env, r.app_id);
    if (!link) return;
    const closed = r.status === 'completed' || r.status === 'rejected';
    const stateFields = closed ? { state: 'closed', state_reason: r.status === 'rejected' ? 'not_planned' : 'completed' } : { state: 'open' };

    if (!r.github_issue_number) {
      if (!opts.create) return;
      const issue = await gh(env, link.token, 'POST', `/repos/${link.repo}/issues`, {
        title: `[${refOf(r)}] ${neutralise(r.title)}`, body: await issueBody(env, r, origin), labels: labelsFor(r),
      });
      await run(env, 'UPDATE requests SET github_repo = ?, github_issue_number = ?, github_issue_url = ?, github_error = NULL WHERE id = ?',
        link.repo, issue.number, issue.html_url, r.id);
      await run(env, 'INSERT INTO activity (request_id, user_id, action, detail) VALUES (?, NULL, ?, ?)', r.id, 'github', `Created GitHub issue #${issue.number} in ${link.repo}`);
      if (closed) await gh(env, link.token, 'PATCH', `/repos/${link.repo}/issues/${issue.number}`, stateFields);
      return;
    }
    if (String(r.github_repo).toLowerCase() !== link.repo.toLowerCase()) return; // belongs to a repo this app used to be linked to

    const base = `/repos/${link.repo}/issues/${r.github_issue_number}`;
    if (!opts.commentOnly) {
      await gh(env, link.token, 'PATCH', base, {
        title: `[${refOf(r)}] ${neutralise(r.title)}`,
        body: await issueBody(env, r, origin),
        ...(opts.state ? stateFields : {}),
      });
    }
    for (const name of opts.labels?.remove || []) {
      try { await gh(env, link.token, 'DELETE', `${base}/labels/${encodeURIComponent(name)}`); } catch (e) { if (e.status !== 404) throw e; }
    }
    if (opts.labels?.add?.length) await gh(env, link.token, 'POST', `${base}/labels`, { labels: opts.labels.add });
    if (opts.comment) {
      const posted = await gh(env, link.token, 'POST', `${base}/comments`, { body: `${neutralise(opts.comment.text)}\n\n${MARKER}` });
      if (opts.comment.deskCommentId) await run(env, 'UPDATE comments SET github_comment_id = ? WHERE id = ?', posted.id, opts.comment.deskCommentId);
    }
    await run(env, 'UPDATE requests SET github_error = NULL WHERE id = ? AND github_error IS NOT NULL', r.id);
  } catch (e) {
    console.error('GitHub sync failed', e.message);
    await run(env, 'UPDATE requests SET github_error = ? WHERE id = ?', String(e.message).slice(0, 300), requestId).catch(() => {});
  }
}

export const commentText = (name, body) => `**${name}** commented in Change Desk:\n\n${body}`;
export const statusText = (name, from, to, note) =>
  `**Status:** ${STATUS_LABEL[from]} → **${STATUS_LABEL[to]}** · by ${name}${note ? `\n\n> ${String(note).replace(/\n/g, '\n> ')}` : ''}`;
export const labelDiff = (r, next) => {
  const remove = [];
  const add = [];
  for (const k of ['category', 'priority']) {
    if (next[k] && next[k] !== r[k]) { remove.push(`${k === 'category' ? 'type' : 'priority'}:${r[k]}`); add.push(`${k === 'category' ? 'type' : 'priority'}:${next[k]}`); }
  }
  return remove.length ? { remove, add } : null;
};

/* --------------------------------------------------------- GitHub -> desk */

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export async function handleWebhook(env, request, appId) {
  requireEnabled(env);
  if (Number(request.headers.get('Content-Length')) > 1024 * 1024) throw new HttpError(413, 'Payload too large');
  const raw = new Uint8Array(await request.arrayBuffer());
  if (!(await verifySignature(await webhookSecret(env, appId), raw, request.headers.get('X-Hub-Signature-256'))))
    throw new HttpError(401, 'Invalid signature');
  const event = request.headers.get('X-GitHub-Event');
  if (event === 'ping') return { ok: true, pong: true };
  let p;
  try { p = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new HttpError(400, 'Invalid JSON'); }

  const app = await first(env, `SELECT id, github_repo FROM apps WHERE id = ? AND github_repo != ''`, appId);
  if (!app) return { ignored: 'app is not linked to GitHub' };
  if (String(p.repository?.full_name || '').toLowerCase() !== app.github_repo.toLowerCase()) return { ignored: 'different repository' };
  const number = p.issue?.number;
  if (!number || p.issue.pull_request) return { ignored: 'not an issue' };

  // Only issues the desk created are known. Anything else on GitHub is deliberately ignored (never imported).
  const req = await first(env, 'SELECT id, status FROM requests WHERE app_id = ? AND github_repo = ? COLLATE NOCASE AND github_issue_number = ?', app.id, app.github_repo, number);
  if (!req) return { ignored: 'not a Change Desk ticket' };
  const who = p.sender?.login || 'someone';

  if (event === 'issues' && p.action === 'closed') {
    if (req.status === 'completed' || req.status === 'rejected') return { ignored: 'already closed in the desk' };
    const to = p.issue.state_reason === 'not_planned' ? 'rejected' : 'completed';
    await run(env, `UPDATE requests SET status = ?, progress = ?, completed_at = ?, updated_at = datetime('now') WHERE id = ?`,
      to, DEFAULT_PROGRESS[to], to === 'completed' ? nowSql() : null, req.id);
    await run(env, 'INSERT INTO activity (request_id, user_id, action, detail) VALUES (?, NULL, ?, ?)', req.id, 'github', `${who} closed issue #${number} on GitHub → ${STATUS_LABEL[to]}`);
    return { ok: true, status: to };
  }
  if (event === 'issues' && p.action === 'reopened') {
    const to = req.status === 'completed' ? 'in_progress' : req.status === 'rejected' ? 'new' : null;
    if (!to) return { ignored: 'already open in the desk' };
    await run(env, `UPDATE requests SET status = ?, progress = ?, completed_at = NULL, updated_at = datetime('now') WHERE id = ?`, to, DEFAULT_PROGRESS[to], req.id);
    await run(env, 'INSERT INTO activity (request_id, user_id, action, detail) VALUES (?, NULL, ?, ?)', req.id, 'github', `${who} reopened issue #${number} on GitHub → ${STATUS_LABEL[to]}`);
    return { ok: true, status: to };
  }
  if (event === 'issue_comment' && p.action === 'created') {
    const body = String(p.comment?.body || '');
    if (body.includes('<!-- change-desk')) return { ignored: 'comment came from the desk' }; // loop guard
    if (await first(env, 'SELECT 1 FROM comments WHERE github_comment_id = ?', p.comment.id)) return { ignored: 'duplicate delivery' };
    await run(env, `INSERT INTO comments (request_id, user_id, body, source, external_author, github_comment_id) VALUES (?, NULL, ?, 'github', ?, ?)`,
      req.id, body.slice(0, 5000), who, p.comment.id);
    await run(env, `UPDATE requests SET updated_at = datetime('now') WHERE id = ?`, req.id);
    return { ok: true, comment: true };
  }
  return { ignored: `${event}/${p.action}` };
}
