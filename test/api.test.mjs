// Integration test against a running `wrangler dev` with a FRESH local database:
//   rm -rf .wrangler/state && npm run db:migrate:local && npm run dev   (in another terminal)
//   BASE=http://localhost:8787 node --test test/api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE;
const skip = !BASE && 'set BASE to a running dev server to run API tests';

class Client {
  cookie = '';
  async call(method, path, body, headers = {}) {
    const isRaw = body instanceof Uint8Array;
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'X-Requested-With': 'change-desk',
        ...(body && !isRaw ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body ? (isRaw ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
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
