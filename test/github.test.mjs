import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { decryptToken, encryptToken, parseRepo, verifySignature, webhookSecret } from '../src/github.js';

const env = { ENCRYPTION_KEY: 'unit-test-key-0123456789abcdef' };

test('tokens round-trip, are randomised, and fail under a different key', async () => {
  const a = await encryptToken(env, 'ghp_secret');
  const b = await encryptToken(env, 'ghp_secret');
  assert.notEqual(a, b, 'fresh IV each time');
  assert.ok(!a.includes('ghp_secret'));
  assert.equal(await decryptToken(env, a), 'ghp_secret');
  await assert.rejects(() => decryptToken({ ENCRYPTION_KEY: 'a-completely-different-key-xx' }, a), /decrypt/);
});

test('webhook secrets are stable per app and differ between apps', async () => {
  assert.equal(await webhookSecret(env, 1), await webhookSecret(env, 1));
  assert.notEqual(await webhookSecret(env, 1), await webhookSecret(env, 2));
});

test('signature verification', async () => {
  const body = new TextEncoder().encode('{"hello":"world"}');
  const sig = 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(await verifySignature('s3cret', body, sig), true);
  assert.equal(await verifySignature('other', body, sig), false);
  assert.equal(await verifySignature('s3cret', new TextEncoder().encode('{"hello":"w0rld"}'), sig), false);
  assert.equal(await verifySignature('s3cret', body, null), false);
  assert.equal(await verifySignature('s3cret', body, 'sha1=abc'), false);
});

test('repo parsing', () => {
  assert.equal(parseRepo('acme/site'), 'acme/site');
  assert.equal(parseRepo('https://github.com/acme/site'), 'acme/site');
  assert.equal(parseRepo('https://github.com/acme/site.git'), 'acme/site');
  for (const bad of ['acme', 'acme/site/extra', '../etc/passwd', 'a b/c', '', 'acme/..', './site']) {
    assert.throws(() => parseRepo(bad), /owner\/name/, bad);
  }
});
