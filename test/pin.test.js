import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, verifyPin, changePin, actionToken, checkAction } from '../lib/auth.js';

const pinHash = hashPin('12345678');

test('a wrong current PIN changes nothing', () => {
  assert.match(changePin({ current: '00000000', next: '87654321', pinHash }).error, /current PIN/);
});

test('the new PIN must be 8 to 12 digits', () => {
  assert.match(changePin({ current: '12345678', next: '123456', pinHash }).error, /8 to 12/);
});

test('a PIN change gives a new hash and a new secret; old tokens stop working', () => {
  const r = changePin({ current: '12345678', next: '87654321', pinHash });
  assert.equal(r.error, undefined);
  assert.equal(verifyPin('87654321', r.pinHash), true);
  assert.equal(verifyPin('12345678', r.pinHash), false);
  assert.match(r.secret, /^[0-9a-f]{64}$/);
  const oldSecret = 'a'.repeat(64);
  const cookie = '999.x';
  const req = { method: 'POST', path: '/api/choose', origin: 'http://h', host: 'h', cookie, token: actionToken(cookie, oldSecret) };
  assert.equal(checkAction(req, oldSecret), null);
  assert.match(checkAction(req, r.secret), /board page/);
});
