import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, verifyPin, isHashed, actionToken, checkAction } from '../lib/auth.js';

test('a PIN is stored as a salted hash and checked against it', () => {
  const stored = hashPin('123456');
  assert.ok(isHashed(stored));
  assert.doesNotMatch(stored, /123456/);
  assert.notEqual(hashPin('123456'), stored, 'salted: two hashes of the same PIN differ');
  assert.equal(verifyPin('123456', stored), true);
  assert.equal(verifyPin('123457', stored), false);
  assert.equal(verifyPin('', stored), false);
  assert.equal(isHashed('123456'), false);
});

const SECRET = 'a'.repeat(64);
const cookie = '9999999999999.abc';
const good = { method: 'POST', path: '/api/choose', origin: 'http://localhost:4400', host: 'localhost:4400', cookie, token: actionToken(cookie, SECRET) };

test('an action needs the board page: same origin and the per-login token', () => {
  assert.equal(checkAction(good, SECRET), null);
  assert.match(checkAction({ ...good, origin: undefined }, SECRET), /board page/);
  assert.match(checkAction({ ...good, origin: 'http://evil.example' }, SECRET), /board page/);
  assert.match(checkAction({ ...good, token: '' }, SECRET), /board page/);
  assert.match(checkAction({ ...good, token: actionToken('other.cookie', SECRET) }, SECRET), /board page/);
});

test('login and reads are not actions', () => {
  assert.equal(checkAction({ ...good, path: '/api/login', token: '' }, SECRET), null);
  assert.equal(checkAction({ ...good, method: 'GET', origin: undefined, token: '' }, SECRET), null);
});

test('checkAction refuses a malformed or "null" Origin instead of failing', () => {
  assert.match(checkAction({ ...good, origin: 'null' }, SECRET), /board page/);
  assert.match(checkAction({ ...good, origin: '::::' }, SECRET), /board page/);
});

test('validPin: 8 to 12 digits for a new PIN', async () => {
  const { validPin } = await import('../lib/auth.js');
  assert.equal(validPin('12345678'), true);
  assert.equal(validPin('123456'), false);
  assert.equal(validPin('1234567890123'), false);
  assert.equal(validPin('12345a78'), false);
});

test('failureKeys: anything arriving over loopback shares one local allowance; network logins keep the board-wide one', async () => {
  const { failureKeys } = await import('../lib/auth.js');
  assert.deepEqual(failureKeys({ peer: '127.0.0.1', forwarded: '100.74.121.37' }), ['client:100.74.121.37', 'shared:loopback']);
  assert.deepEqual(failureKeys({ peer: '127.0.0.1', forwarded: '' }), ['client:127.0.0.1', 'shared:loopback']);
  assert.deepEqual(failureKeys({ peer: '100.74.121.37', forwarded: 'spoofed' }), ['client:100.74.121.37', 'shared:network']);
  // A faked forwarded value can never name a shared counter.
  for (const fake of ['network', 'shared:network', 'loopback']) {
    assert.notEqual(failureKeys({ peer: '127.0.0.1', forwarded: fake })[0], 'shared:network');
    assert.ok(failureKeys({ peer: '127.0.0.1', forwarded: fake })[0].startsWith('client:'));
  }
});

test('each port gets its own login cookie, so :4400 and :4443 never overwrite each other (no PIN loop)', async () => {
  const { cookieName } = await import('../lib/auth.js');
  assert.equal(cookieName('laptop.example.ts.net:4443'), 'agenthub_auth_4443');
  assert.equal(cookieName('laptop.example.ts.net:4400'), 'agenthub_auth_4400');
  assert.equal(cookieName('laptop.example.ts.net'), 'agenthub_auth_default');
  assert.equal(cookieName('[::1]:4400'), 'agenthub_auth_4400');
  assert.equal(cookieName('evil:4400;x=1'), 'agenthub_auth_default');
});

test('a token stays bound to its own login (a token from another login is refused)', () => {
  assert.match(checkAction({ ...good, cookie: '1111111111111.other' }, SECRET), /board page/);
});

test('wrong-PIN counters survive a restart (saved and loaded)', async () => {
  const { saveFailures, loadFailures } = await import('../lib/auth.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fail-')), 'f.json');
  const now = Date.now();
  saveFailures(file, new Map([['client:1.2.3.4', [now - 1000, now]], ['shared:network', [now - 20 * 60000]]]));
  const back = loadFailures(file, now, 10 * 60000);
  assert.deepEqual(back.get('client:1.2.3.4'), [now - 1000, now]);
  assert.equal(back.has('shared:network'), false, 'expired entries dropped');
  assert.equal(loadFailures(path.join(path.dirname(file), 'missing.json'), now, 600000).size, 0);
});
