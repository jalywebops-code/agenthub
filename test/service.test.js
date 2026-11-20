// The board as a service (lib/service.js): finding its launchd label, and filling in the templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { labelFromList, fillTemplate } from '../lib/service.js';
import { ROOT } from '../lib/config.js';

test("the board's label in launchctl list: one ending in agenthub, never a helper", () => {
  const list = 'PID\tStatus\tLabel\n123\t0\tcom.apple.thing\n-\t0\tlocal.agenthub.hermes-dashboard\n456\t0\tlocal.agenthub\n';
  assert.equal(labelFromList(list), 'local.agenthub');
  assert.equal(labelFromList('789\t0\tcom.example.agenthub\n'), 'com.example.agenthub');
  assert.equal(labelFromList('1\t0\tcom.example.notagenthubx\n'), '');
});

test('templates fill every placeholder, escape XML and refuse a missing value', () => {
  assert.equal(fillTemplate('<string>__ROOT__/x</string>', { ROOT: '/Users/you/a&b' }), '<string>/Users/you/a&amp;b/x</string>');
  assert.throws(() => fillTemplate('__LABEL__ __NODE__', { LABEL: 'x' }), /NODE/);
});

test('both shipped templates fill completely with the values install-service gives', () => {
  const board = fs.readFileSync(path.join(ROOT, 'launchd/agenthub.plist.template'), 'utf8');
  const filled = fillTemplate(board, { LABEL: 'local.agenthub', NODE: '/usr/local/bin/node', ROOT: '/Users/you/agenthub', PATH: '/usr/bin:/bin' });
  assert.doesNotMatch(filled, /__[A-Z]+__/);
  assert.match(filled, /<string>local\.agenthub<\/string>/);
  const hermes = fs.readFileSync(path.join(ROOT, 'launchd/agenthub-hermes-dashboard.plist.template'), 'utf8');
  assert.doesNotMatch(fillTemplate(hermes, { LABEL: 'local.agenthub.hermes-dashboard', HOME: '/Users/you', ROOT: '/Users/you/agenthub', PORT: 9119 }), /__[A-Z]+__/);
});
