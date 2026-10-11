import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedTransitions, canTransition, canEditDetails, noteRequired } from '../src/workflow.js';

const admin = { id: 1, role: 'admin' };
const dev = { id: 2, role: 'developer' };
const alice = { id: 3, role: 'requester' };
const bob = { id: 4, role: 'requester' };
const req = (status, requester_id = 3) => ({ status, requester_id });

test('developers drive the workflow but cannot accept their own testing result', () => {
  assert.ok(canTransition(dev, req('new'), 'new', 'review'));
  assert.ok(canTransition(dev, req('approved'), 'approved', 'in_progress'));
  assert.ok(canTransition(dev, req('in_progress'), 'in_progress', 'testing'));
  assert.equal(canTransition(dev, req('testing'), 'testing', 'completed'), false);
});

test('requester accepts or rejects testing on their own request only', () => {
  assert.ok(canTransition(alice, req('testing'), 'testing', 'completed'));
  assert.ok(canTransition(alice, req('testing'), 'testing', 'in_progress'));
  assert.equal(canTransition(bob, req('testing'), 'testing', 'completed'), false);
  assert.ok(canTransition(admin, req('testing'), 'testing', 'completed'));
});

test('requesters cannot approve or start work', () => {
  assert.equal(canTransition(alice, req('new'), 'new', 'review'), false);
  assert.equal(canTransition(alice, req('approved'), 'approved', 'in_progress'), false);
  assert.deepEqual(allowedTransitions(alice, req('new')), []);
});

test('reopen paths', () => {
  assert.ok(canTransition(alice, req('completed'), 'completed', 'in_progress'));
  assert.ok(canTransition(alice, req('rejected'), 'rejected', 'new'));
  assert.equal(canTransition(bob, req('rejected'), 'rejected', 'new'), false);
});

test('invalid jumps are refused for everyone', () => {
  assert.equal(canTransition(admin, req('new'), 'new', 'completed'), false);
  assert.equal(canTransition(admin, req('completed'), 'completed', 'new'), false);
});

test('notes are required when rejecting or sending back', () => {
  assert.ok(noteRequired('new', 'rejected'));
  assert.ok(noteRequired('testing', 'in_progress'));
  assert.ok(noteRequired('completed', 'in_progress'));
  assert.equal(noteRequired('new', 'review'), false);
});

test('requesters can edit details only while the request is new', () => {
  assert.ok(canEditDetails(alice, req('new')));
  assert.equal(canEditDetails(alice, req('review')), false);
  assert.equal(canEditDetails(bob, req('new')), false);
  assert.ok(canEditDetails(dev, req('in_progress')));
});
