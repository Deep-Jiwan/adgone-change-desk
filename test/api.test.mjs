// Integration test against a running `wrangler dev` with a FRESH local database:
//   rm -rf .wrangler/state && npm run db:migrate:local && npm run dev   (in another terminal)
//   BASE=http://localhost:8787 node --test test/api.test.mjs
//
// The GitHub tests additionally need GH_MOCK_PORT, and the dev server pointed at the in-process fake GitHub:
//   npx wrangler dev --port 8787 --var ENCRYPTION_KEY:test-encryption-key-0123456789 \
//     --var GITHUB_API_URL:http://127.0.0.1:9911 --var GITHUB_WEB_URL:http://127.0.0.1:9911 \
//     --var GITHUB_CLIENT_ID:cid --var GITHUB_CLIENT_SECRET:csecret
//   BASE=http://localhost:8787 GH_MOCK_PORT=9911 node --test test/api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startMockGithub } from './mock-github.mjs';

const BASE = process.env.BASE;
const skip = !BASE && 'set BASE to a running dev server to run API tests';

class Client {
  jar = {};
  get cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  async call(method, path, body, headers = {}) {
    const isRaw = body instanceof Uint8Array;
    const res = await fetch(BASE + path, {
      redirect: headers.redirect || 'follow',
      method,
      headers: {
        'X-Requested-With': 'change-desk',
        ...(body && !isRaw ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'redirect')),
      },
      body: body ? (isRaw ? body : JSON.stringify(body)) : undefined,
    });
    for (const set of res.headers.getSetCookie()) {
      const [pair, ...attrs] = set.split(';');
      const [name, ...value] = pair.split('=');
      if (attrs.some((a) => /^\s*max-age=0/i.test(a)) || value.join('=') === '') delete this.jar[name.trim()];
      else this.jar[name.trim()] = value.join('=');
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, res };
  }
}

const PW = 'correct-horse-battery';
const admin = new Client();
const dev = new Client();
const alice = new Client();
const mallory = new Client();
const ids = {};

test('setup, login and team', { skip }, async () => {
  assert.equal((await admin.call('GET', '/api/setup')).data.needsSetup, true);
  assert.equal((await admin.call('POST', '/api/setup', { email: 'a@x.io', name: 'Ada', password: 'short' })).status, 400);
  const r = await admin.call('POST', '/api/setup', { email: 'a@x.io', name: 'Ada', password: PW });
  assert.equal(r.status, 201);
  assert.equal((await new Client().call('POST', '/api/setup', { email: 'b@x.io', name: 'B', password: PW })).status, 409);

  for (const [c, email, name, role] of [[dev, 'd@x.io', 'Dev', 'developer'], [alice, 'al@x.io', 'Alice', 'requester'], [mallory, 'm@x.io', 'Mallory', 'requester']]) {
    const made = await admin.call('POST', '/api/users', { email, name, role });
    assert.equal(made.status, 201);
    const login = await c.call('POST', '/api/login', { email, password: made.data.temp_password });
    assert.equal(login.data.user.must_change_password, true);
    assert.equal((await c.call('GET', '/api/apps')).status, 403, 'must change temp password first');
    assert.equal((await c.call('POST', '/api/me/password', { current_password: made.data.temp_password, new_password: PW })).status, 200);
    assert.equal((await c.call('GET', '/api/apps')).status, 200);
    ids[role + name] = made.data.id;
  }
  assert.equal((await alice.call('POST', '/api/users', { email: 'z@x.io', name: 'Z', role: 'admin' })).status, 403);
});

test('auth hygiene', { skip }, async () => {
  assert.equal((await new Client().call('GET', '/api/apps')).status, 401);
  const noHeader = await fetch(BASE + '/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie }, body: '{}' });
  assert.equal(noHeader.status, 403, 'CSRF header required');
  const bad = await new Client().call('POST', '/api/login', { email: 'a@x.io', password: 'nope-nope-nope' });
  assert.equal(bad.status, 401);
});

test('apps', { skip }, async () => {
  assert.equal((await alice.call('POST', '/api/apps', { key: 'CHAI', name: 'Chai' })).status, 403);
  assert.equal((await admin.call('POST', '/api/apps', { key: '1x', name: 'Bad' })).status, 400);
  assert.equal((await admin.call('POST', '/api/apps', { key: 'chai', name: 'Chai Site', icon: '🍵', version: '1.0' })).status, 201);
  assert.equal((await admin.call('POST', '/api/apps', { key: 'CHAI', name: 'Dup' })).status, 409);
  const list = (await alice.call('GET', '/api/apps')).data.apps;
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'CHAI');
  ids.app = list[0].id;
});

test('request lifecycle with permissions', { skip }, async () => {
  const created = await alice.call('POST', '/api/requests', {
    app_id: ids.app, title: 'Make header bigger', description: 'see screenshot', category: 'ui', priority: 'high',
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.ref, 'CHAI-0001');
  const id = created.data.id;
  assert.equal((await alice.call('POST', '/api/requests', { app_id: ids.app, title: 'Second', category: 'bug', priority: 'low' })).data.ref, 'CHAI-0002');

  // screenshot upload: owner ok, stranger refused, bad type refused
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const up = await alice.call('POST', `/api/requests/${id}/attachments`, png, { 'Content-Type': 'image/png', 'X-Filename': 'shot.png' });
  assert.equal(up.status, 201);
  assert.equal((await mallory.call('POST', `/api/requests/${id}/attachments`, png, { 'Content-Type': 'image/png' })).status, 403);
  assert.equal((await alice.call('POST', `/api/requests/${id}/attachments`, png, { 'Content-Type': 'image/svg+xml' })).status, 415);
  const file = await alice.call('GET', `/api/files/${up.data.id}`);
  assert.equal(file.status, 200);
  assert.equal(file.res.headers.get('content-type'), 'image/png');
  assert.equal((await new Client().call('GET', `/api/files/${up.data.id}`)).status, 401);

  // requester cannot drive workflow
  assert.equal((await alice.call('PATCH', `/api/requests/${id}`, { status: 'review' })).status, 403);
  assert.equal((await alice.call('PATCH', `/api/requests/${id}`, { assignee_id: ids.developerDev })).status, 403);
  // mallory cannot edit alice's request
  assert.equal((await mallory.call('PATCH', `/api/requests/${id}`, { title: 'hijack' })).status, 403);
  // alice can edit while new
  assert.equal((await alice.call('PATCH', `/api/requests/${id}`, { title: 'Make header much bigger' })).status, 200);

  const patch = (c, body) => c.call('PATCH', `/api/requests/${id}`, body);
  assert.equal((await patch(dev, { status: 'completed' })).status, 403, 'cannot skip steps');
  assert.equal((await patch(dev, { status: 'review' })).status, 200);
  assert.equal((await patch(dev, { status: 'approved', assignee_id: ids.developerDev, due_date: '2020-01-01' })).status, 200);
  assert.equal((await patch(alice, { title: 'too late' })).status, 403, 'requester edits locked after new');
  assert.equal((await patch(dev, { assignee_id: ids.requesterAlice })).status, 400, 'assignee must be staff');
  assert.equal((await patch(dev, { status: 'in_progress', progress: 40 })).status, 200);
  let d = (await alice.call('GET', `/api/requests/${id}`)).data;
  assert.equal(d.request.progress, 40);
  assert.equal(d.request.overdue, 1, 'past due date and still open');
  assert.equal((await patch(dev, { progress: 101 })).status, 400);
  assert.equal((await patch(dev, { status: 'testing' })).status, 200);
  assert.equal((await patch(dev, { status: 'completed' })).status, 403, 'dev cannot self-accept');
  assert.equal((await patch(mallory, { status: 'completed' })).status, 403);
  // reject with note is mandatory
  assert.equal((await patch(alice, { status: 'in_progress' })).status, 400);
  assert.equal((await patch(alice, { status: 'in_progress', note: 'Still too small on mobile' })).status, 200);
  assert.equal((await patch(dev, { status: 'testing' })).status, 200);
  assert.equal((await patch(alice, { status: 'completed' })).status, 200);

  d = (await alice.call('GET', `/api/requests/${id}`)).data;
  assert.equal(d.request.status, 'completed');
  assert.equal(d.request.progress, 100);
  assert.equal(d.request.overdue, 0);
  assert.ok(d.request.completed_at);
  assert.ok(d.comments.some((c) => c.body === 'Still too small on mobile'));
  assert.ok(d.activity.length >= 8);
  assert.deepEqual(d.permissions.transitions, ['in_progress']);

  assert.equal((await mallory.call('POST', `/api/requests/${id}/comments`, { body: 'nice' })).status, 201);
});

test('lists, filters and export', { skip }, async () => {
  assert.equal((await alice.call('GET', '/api/requests')).data.requests.length, 2);
  assert.equal((await alice.call('GET', '/api/requests?status=completed')).data.requests.length, 1);
  assert.equal((await alice.call('GET', '/api/requests?q=CHAI-0002')).data.requests.length, 1);
  assert.equal((await alice.call('GET', '/api/requests?q=%25')).data.requests.length, 0, 'LIKE wildcards are escaped');
  assert.equal((await alice.call('GET', '/api/requests?status=bogus')).status, 400);
  const apps = (await alice.call('GET', '/api/apps')).data.apps[0];
  assert.equal(apps.completed, 1);
  assert.equal(apps.pending, 1);
  assert.equal((await alice.call('GET', '/api/export.csv')).status, 403);
  const csv = await dev.call('GET', '/api/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /CHAI-0001/);
});

test('admin user management', { skip }, async () => {
  assert.equal((await admin.call('PATCH', `/api/users/${ids.requesterMallory}`, { disabled: true })).status, 200);
  assert.equal((await mallory.call('GET', '/api/apps')).status, 401, 'disabled user is signed out');
  assert.equal((await admin.call('PATCH', '/api/users/1', { role: 'requester' })).status, 400, 'cannot demote self');
});


/* ------------------------------------------------------------------ GitHub integration */

const ghSkip = skip || (!process.env.GH_MOCK_PORT && 'set GH_MOCK_PORT (and start the dev server against the mock) to run GitHub tests');
const gh = {};

async function webhook(appId, event, payload, { secret, signed = true } = {}) {
  const raw = JSON.stringify(payload);
  const sec = secret ?? gh.secret;
  return fetch(`${BASE}/api/github/webhook/${appId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, ...(signed ? { 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', sec).update(raw).digest('hex') } : {}) },
    body: raw,
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
}
const issueEvent = (action, number, extra = {}) => ({ action, issue: { number, state_reason: extra.state_reason }, repository: { full_name: 'acme/site' }, sender: { login: 'octocat' } });
const commentEvent = (number, body, id) => ({ action: 'created', issue: { number }, comment: { id, body }, repository: { full_name: 'acme/site' }, sender: { login: 'octocat' } });
const detail = async (id) => (await admin.call('GET', `/api/requests/${id}`)).data;

test('github: setup, connections and linking', { skip: ghSkip }, async () => {
  gh.mock = await startMockGithub(Number(process.env.GH_MOCK_PORT));
  const { state } = gh.mock;
  assert.equal((await alice.call('GET', '/api/github/connections')).status, 403);
  assert.deepEqual((await admin.call('GET', '/api/github/config')).data, { enabled: true, oauth: true });

  assert.equal((await admin.call('POST', '/api/github/connections', { label: 'x', token: 'not-a-valid-token' })).status, 400);
  const added = await admin.call('POST', '/api/github/connections', { label: 'Acme bot', token: 'good-token' });
  assert.equal(added.status, 201);
  const list = (await admin.call('GET', '/api/github/connections')).data.connections;
  assert.equal(list[0].login, 'octo');
  assert.ok(!JSON.stringify(list).includes('good-token') && !('token_enc' in list[0]), 'token never leaves the server');
  gh.conn = added.data.id;

  const link = (repo, c = gh.conn) => admin.call('PUT', `/api/apps/${ids.app}/github`, { connection_id: c, repo });
  assert.equal((await alice.call('PUT', `/api/apps/${ids.app}/github`, { connection_id: gh.conn, repo: 'acme/site' })).status, 403);
  assert.equal((await link('acme/private')).status, 400, 'repo the token cannot see');
  assert.equal((await link('acme/noissues')).status, 400, 'issues disabled');
  assert.equal((await link('acme/readonly')).status, 400, 'no write access');
  assert.equal((await link('nonsense')).status, 400);

  const ok = await link('https://github.com/acme/site');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.repo, 'acme/site');
  assert.equal(ok.data.webhook, 'created');
  const secret = (await admin.call('GET', `/api/apps/${ids.app}/github/webhook`)).data;
  gh.secret = secret.secret;
  assert.equal(state.hooks.length, 1);
  assert.equal(state.hooks[0].config.secret, secret.secret, 'hook registered with the derived secret');
  assert.equal(state.hooks[0].config.url, secret.url);
  assert.deepEqual(state.hooks[0].events, ['issues', 'issue_comment']);
  assert.equal((await link('acme/site')).status, 200, 're-linking is idempotent');
  assert.equal(state.hooks.length, 1, 'no duplicate webhook');
  assert.equal((await admin.call('GET', `/api/apps/${ids.app}`)).data.app.github_repo, 'acme/site');
});

test('github: desk ticket creates an issue and keeps it in step', { skip: ghSkip }, async () => {
  const { state } = gh.mock;
  const made = await alice.call('POST', '/api/requests', {
    app_id: ids.app, title: 'Footer link broken', description: 'ping @someone about #1\nsee shot', category: 'bug', priority: 'high',
  });
  assert.equal(made.status, 201);
  assert.match(made.data.github_issue_url, /github\.com\/acme\/site\/issues\/\d+/);
  gh.id = made.data.id;
  gh.ref = made.data.ref;
  const issue = state.issues.at(-1);
  gh.number = issue.number;
  assert.equal(issue.title, `[${made.data.ref}] Footer link broken`);
  assert.deepEqual(issue.labels, ['change-desk', 'type:bug', 'priority:high']);
  assert.ok(issue.body.includes(`<!-- change-desk:${made.data.ref} -->`));
  assert.ok(!issue.body.includes('@someone'), 'mentions are neutralised so desk users cannot ping GitHub accounts');

  // attachment -> issue body lists it
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  await alice.call('POST', `/api/requests/${gh.id}/attachments`, png, { 'Content-Type': 'image/png', 'X-Filename': 'broken.png' });
  assert.match(issue.body, /Attachments \(1\)[\s\S]*broken\.png/);

  // desk comment -> GitHub comment (with loop-guard marker) and id remembered
  const before = state.comments.length;
  await alice.call('POST', `/api/requests/${gh.id}/comments`, { body: 'It is the privacy link' });
  assert.equal(state.comments.length, before + 1);
  assert.match(state.comments.at(-1).body, /Alice\*\* commented in Change Desk[\s\S]*privacy link[\s\S]*<!-- change-desk -->/);
  const comments = (await detail(gh.id)).comments;
  assert.equal(comments.at(-1).body, 'It is the privacy link');

  // edit title (requester, still new) + priority change by dev -> issue title and labels follow
  await alice.call('PATCH', `/api/requests/${gh.id}`, { title: 'Footer privacy link broken' });
  assert.equal(issue.title, `[${gh.ref}] Footer privacy link broken`);
  await dev.call('PATCH', `/api/requests/${gh.id}`, { priority: 'critical' });
  assert.deepEqual(issue.labels, ['change-desk', 'type:bug', 'priority:critical']);

  // status changes -> comment; completion -> closed
  const patch = (c, body) => c.call('PATCH', `/api/requests/${gh.id}`, body);
  for (const status of ['review', 'approved', 'in_progress', 'testing']) assert.equal((await patch(dev, { status })).status, 200);
  assert.equal(issue.state, 'open');
  assert.match(state.comments.at(-1).body, /Status:\*\* In Progress → \*\*Testing\*\* · by Dev/);
  await patch(alice, { status: 'in_progress', note: 'Still broken on Safari' });
  assert.match(state.comments.at(-1).body, /> Still broken on Safari/);
  await patch(dev, { status: 'testing' });
  await patch(alice, { status: 'completed' });
  assert.equal(issue.state, 'closed');
  assert.equal(issue.state_reason, 'completed');
  await patch(alice, { status: 'in_progress', note: 'Regressed' });
  assert.equal(issue.state, 'open', 'reopening in the desk reopens the issue');
});

test('github: updates made on GitHub flow back (only for desk tickets)', { skip: ghSkip }, async () => {
  const { state } = gh.mock;
  const n = gh.number;
  const callsBefore = state.calls.length;

  // authenticity
  assert.equal((await webhook(ids.app, 'issue_comment', commentEvent(n, 'hi', 9001), { signed: false })).status, 401);
  assert.equal((await webhook(ids.app, 'issue_comment', commentEvent(n, 'hi', 9001), { secret: 'wrong' })).status, 401);
  assert.equal((await webhook(ids.app, 'ping', {})).data.pong, true);

  // a comment on GitHub shows up in the desk, once
  const c = await webhook(ids.app, 'issue_comment', commentEvent(n, 'Looks fixed on my side', 9001));
  assert.equal(c.data.comment, true);
  assert.equal((await webhook(ids.app, 'issue_comment', commentEvent(n, 'Looks fixed on my side', 9001))).data.ignored, 'duplicate delivery');
  let d = await detail(gh.id);
  const gc = d.comments.find((x) => x.body === 'Looks fixed on my side');
  assert.equal(gc.user_name, 'octocat');
  assert.equal(gc.source, 'github');

  // loop guard: comments the desk itself posted are never re-imported
  assert.equal((await webhook(ids.app, 'issue_comment', commentEvent(n, 'x\n\n<!-- change-desk -->', 9002))).data.ignored, 'comment came from the desk');
  assert.ok(!(await detail(gh.id)).comments.some((x) => x.body.startsWith('x')));

  // closing the issue on GitHub completes the ticket; a repeat is a no-op
  assert.equal((await webhook(ids.app, 'issues', issueEvent('closed', n, { state_reason: 'completed' }))).data.status, 'completed');
  d = await detail(gh.id);
  assert.equal(d.request.status, 'completed');
  assert.equal(d.request.progress, 100);
  assert.ok(d.request.completed_at);
  assert.ok(d.activity.some((a) => a.action === 'github' && /octocat closed issue/.test(a.detail)));
  assert.match((await webhook(ids.app, 'issues', issueEvent('closed', n))).data.ignored, /already closed/);

  // reopening on GitHub reopens the ticket
  assert.equal((await webhook(ids.app, 'issues', issueEvent('reopened', n))).data.status, 'in_progress');
  assert.equal((await detail(gh.id)).request.completed_at, null);
  // closed as "not planned" -> rejected, then reopen -> new
  assert.equal((await webhook(ids.app, 'issues', issueEvent('closed', n, { state_reason: 'not_planned' }))).data.status, 'rejected');
  assert.equal((await webhook(ids.app, 'issues', issueEvent('reopened', n))).data.status, 'new');

  // GitHub-native issues are never imported
  const reqCount = (await admin.call('GET', '/api/requests')).data.requests.length;
  assert.equal((await webhook(ids.app, 'issues', { ...issueEvent('opened', 9999), issue: { number: 9999, title: 'Native issue' } })).data.ignored, 'not a Change Desk ticket');
  assert.equal((await webhook(ids.app, 'issue_comment', commentEvent(9999, 'comment on native issue', 9100))).data.ignored, 'not a Change Desk ticket');
  assert.equal((await admin.call('GET', '/api/requests')).data.requests.length, reqCount);
  // wrong repo / pull requests ignored
  assert.equal((await webhook(ids.app, 'issues', { ...issueEvent('closed', n), repository: { full_name: 'evil/other' } })).data.ignored, 'different repository');
  assert.equal((await webhook(ids.app, 'issue_comment', { ...commentEvent(n, 'pr', 9101), issue: { number: n, pull_request: {} } })).data.ignored, 'not an issue');

  // none of the above made the desk call GitHub back (no echo loops)
  assert.equal(state.calls.length, callsBefore, 'webhook handling makes no outbound GitHub calls');
});

test('github: failures never block the desk, and can be retried', { skip: ghSkip }, async () => {
  const { state } = gh.mock;
  state.failIssueCreate = 1;
  const made = await alice.call('POST', '/api/requests', { app_id: ids.app, title: 'GitHub is down right now', category: 'bug', priority: 'low' });
  assert.equal(made.status, 201, 'desk request still created');
  assert.equal(made.data.github_issue_url, null);
  let d = await detail(made.data.id);
  assert.match((await dev.call('GET', `/api/requests/${made.data.id}`)).data.request.github_error, /GitHub error 500/);
  assert.equal(d.request.github_issue_number, null);
  assert.equal((await alice.call('GET', `/api/requests/${made.data.id}`)).data.request.github_error, 'Not synced to GitHub yet', 'raw error text hidden from requesters');
  assert.equal((await mallory.call('POST', `/api/requests/${made.data.id}/github/sync`)).status, 401); // disabled user
  const retry = await alice.call('POST', `/api/requests/${made.data.id}/github/sync`);
  assert.equal(retry.data.ok, true);
  d = await detail(made.data.id);
  assert.ok(d.request.github_issue_number);
  assert.equal(d.request.github_error, null);
});

test('github: oauth connect flow', { skip: ghSkip }, async () => {
  const begin = async () => {
    const start = await admin.call('GET', '/api/github/oauth/start', undefined, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const loc = new URL(start.res.headers.get('location'));
    assert.equal(loc.pathname, '/login/oauth/authorize');
    assert.equal(loc.searchParams.get('client_id'), 'cid');
    assert.equal(loc.searchParams.get('scope'), 'repo');
    assert.ok(admin.jar.gh_oauth_state, 'state cookie set');
    return loc.searchParams.get('state');
  };
  const cb = (qs, headers = {}) => admin.call('GET', `/api/github/oauth/callback?${qs}`, undefined, { redirect: 'manual', ...headers });
  const where = (r) => decodeURIComponent(r.res.headers.get('location'));
  assert.equal((await alice.call('GET', '/api/github/oauth/start', undefined, { redirect: 'manual' })).status, 403);

  // forged state, missing cookie and a bad code are all rejected (the one-time state cookie is cleared each time)
  await begin();
  assert.match(where(await cb('code=good-code&state=forged')), /error=.*did not match/);
  const state2 = await begin();
  assert.match(where(await cb(`code=good-code&state=${state2}`, { Cookie: `sid=${admin.jar.sid}` })), /error=/);
  const state3 = await begin();
  assert.match(where(await cb(`code=bad&state=${state3}`)), /error=.*incorrect/);

  const state4 = await begin();
  const good = await cb(`code=good-code&state=${state4}`);
  assert.equal(good.status, 302);
  assert.match(where(good), /connected=Connected as octo-oauth/);
  assert.ok(!admin.jar.gh_oauth_state, 'state cookie cleared after use');
  const conns = (await admin.call('GET', '/api/github/connections')).data.connections;
  assert.ok(conns.some((c) => c.kind === 'oauth' && c.login === 'octo-oauth'));
});

test('github: unlinking and removing a connection', { skip: ghSkip }, async () => {
  const { state } = gh.mock;
  assert.equal((await admin.call('DELETE', `/api/apps/${ids.app}/github`)).status, 200);
  assert.equal(state.hooks.length, 0, 'webhook removed from GitHub');
  const issues = state.issues.length;
  const made = await alice.call('POST', '/api/requests', { app_id: ids.app, title: 'After unlink', category: 'ui', priority: 'low' });
  assert.equal(made.data.github_issue_url, null);
  assert.equal(state.issues.length, issues, 'unlinked app creates no issues');
  // old tickets keep their link info but are no longer pushed
  await dev.call('PATCH', `/api/requests/${gh.id}`, { priority: 'low' });
  assert.equal((await webhook(ids.app, 'issues', issueEvent('closed', gh.number))).data.ignored, 'app is not linked to GitHub');

  // removing a connection unlinks apps that use it
  await admin.call('PUT', `/api/apps/${ids.app}/github`, { connection_id: gh.conn, repo: 'acme/site' });
  assert.equal(state.hooks.length, 1);
  assert.equal((await admin.call('DELETE', `/api/github/connections/${gh.conn}`)).status, 200);
  assert.equal(state.hooks.length, 0);
  assert.equal((await admin.call('GET', `/api/apps/${ids.app}`)).data.app.github_repo, '');
  gh.mock.close();
});
