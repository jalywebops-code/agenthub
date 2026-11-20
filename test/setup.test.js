import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSetup, loadSetup, expandHome } from '../lib/setup.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-'));

test('the defaults name nobody and point only at standard install locations', () => {
  const text = JSON.stringify(defaultSetup());
  assert.doesNotMatch(text, /@|\.ts\.net/); // no email addresses, no Tailscale machine names
  assert.doesNotMatch(text, /\/Users\//);
  const d = defaultSetup();
  assert.equal(d.agents.claude.length, 1);
  assert.equal(d.agents.claude[0].id, 'claude');
  assert.deepEqual(d.projects.groups, []);
});

test('a missing setup file is made from the seed once; afterwards the file wins', () => {
  const dir = tmp();
  const file = path.join(dir, 'setup.json');
  const seed = path.join(dir, 'seed.json');
  fs.writeFileSync(seed, JSON.stringify({ projects: { root: '~/work' } }));
  assert.equal(loadSetup(file, seed).projects.root, '~/work');
  assert.ok(fs.existsSync(file));
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  fs.writeFileSync(seed, JSON.stringify({ projects: { root: '~/changed' } }));
  assert.equal(loadSetup(file, seed).projects.root, '~/work');
});

test('with no file and no seed, the defaults are written', () => {
  const dir = tmp();
  const file = path.join(dir, 'setup.json');
  assert.equal(loadSetup(file, path.join(dir, 'none.json')).agents.claude[0].id, 'claude');
  assert.ok(fs.existsSync(file));
});

test('missing parts are filled from the defaults; a Claude account list replaces the default one', () => {
  const dir = tmp();
  const file = path.join(dir, 'setup.json');
  fs.writeFileSync(file, JSON.stringify({ agents: { openclaw: { port: 1234 }, claude: [{ id: 'a', label: 'A', command: '/x', configDir: '~/.a' }] } }));
  const s = loadSetup(file, '');
  assert.equal(s.agents.openclaw.port, 1234);
  assert.ok(s.agents.openclaw.bin, 'default bin kept');
  assert.equal(s.agents.hermes.dashboardUrl, defaultSetup().agents.hermes.dashboardUrl);
  assert.deepEqual(s.agents.claude.map((c) => c.id), ['a']);
  assert.ok(Array.isArray(s.projects.groups));
});

test('a broken setup file is an error and is never overwritten', () => {
  const dir = tmp();
  const file = path.join(dir, 'setup.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadSetup(file, ''), /setup\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('expandHome turns ~ into the home folder and leaves other paths alone', () => {
  assert.equal(expandHome('~/.claude'), path.join(os.homedir(), '.claude'));
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('/usr/bin/x'), '/usr/bin/x');
  assert.equal(expandHome('codex'), 'codex');
});
