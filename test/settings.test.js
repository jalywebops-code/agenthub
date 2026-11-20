import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, readSettings, cleanSettings, writeSettings } from '../lib/settings.js';
import { pickAge } from '../public/activity.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-settings-')), 'settings.json');

test('missing or broken settings file gives the defaults', () => {
  assert.deepEqual(readSettings(tmp()), DEFAULTS);
  const f = tmp(); fs.writeFileSync(f, '{not json');
  assert.deepEqual(readSettings(f), DEFAULTS);
});

test('cleanSettings checks values and drops unknown keys', () => {
  assert.match(cleanSettings({ defaultAge: '1y' }), /window/);
  assert.match(cleanSettings({ foldDone: 'yes' }), /on or off/);
  assert.deepEqual(cleanSettings({ defaultAge: '30d', extra: 1 }), { ...DEFAULTS, defaultAge: '30d' });
});

test('settings round-trip through the file', () => {
  const f = tmp();
  writeSettings(f, { ...DEFAULTS, foldQuietProjects: true });
  assert.equal(readSettings(f).foldQuietProjects, true);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test("a device's own window wins over the default", () => {
  assert.equal(pickAge('30d', { defaultAge: '7d' }), '30d');
  assert.equal(pickAge('', { defaultAge: 'today' }), 'today');
  assert.equal(pickAge(null, {}), '7d');
});
