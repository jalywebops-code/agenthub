// Settings → Phone access (step C5): only on the computer; extra addresses must be private and this computer's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, defaultSetup, isPrivateAddress } from '../lib/setup.js';

const checks = { home: '/Users/you', isExecutable: () => true, isDir: () => true, findOnPath: () => true,
  addresses: () => ['192.168.1.20', '10.147.17.5', '100.101.102.103', '203.0.113.9'] };
const at = (access, local = true) => applyChanges(defaultSetup(), { access }, { local, checks });

test('phone access can never be changed from a phone', () => {
  assert.match(at({ homeWifi: true }, false).error, /only be changed on the computer/);
  assert.match(at({ extraAddresses: ['10.147.17.5'] }, false).error, /only be changed on the computer/);
});

test('home Wi-Fi on and off', () => {
  assert.equal(at({ homeWifi: true }).setup.access.homeWifi, true);
  assert.match(at({ homeWifi: 'yes' }).error, /on or off/);
});

test("extra addresses: private, and this computer's own right now", () => {
  assert.deepEqual(at({ extraAddresses: ['10.147.17.5', '10.147.17.5'] }).setup.access.extraAddresses, ['10.147.17.5']);
  assert.match(at({ extraAddresses: ['203.0.113.9'] }).error, /isn't a private/);
  assert.match(at({ extraAddresses: ['0.0.0.0'] }).error, /isn't a private/);
  assert.match(at({ extraAddresses: ['10.0.0.99'] }).error, /isn't one of this computer's addresses/);
  assert.match(at({ extraAddresses: ['::'] }).error, /isn't a private/);
  assert.match(at({ listen: '0.0.0.0' }).error, /can't be changed here/);
});

test('which addresses count as private', () => {
  for (const a of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.10', '100.64.0.1', '100.127.1.1']) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '100.128.0.1', '0.0.0.0', '127.0.0.1', '10.0.0.256', 'x']) assert.equal(isPrivateAddress(a), false, a);
});
