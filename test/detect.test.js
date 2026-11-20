// Detect (step C3): what it finds on a computer, what it proposes, and what it never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, mergeChanges } from '../lib/detect.js';
import { applyChanges, defaultSetup, loadSetup } from '../lib/setup.js';

const HOME = '/Users/you';
/** A pretend computer with these programs, folders and files. */
function computer({ programs = [], folders = [], json = {}, pathDirs = ['/opt/homebrew/bin', `${HOME}/.local/bin`] } = {}) {
  const p = new Set(programs);
  const f = new Set(folders);
  return {
    home: HOME,
    isExecutable: (x) => p.has(x),
    isDir: (x) => f.has(x),
    readJson: (x) => json[x] || null,
    listDir: (x) => (x === HOME ? [...f].filter((d) => path.dirname(d) === HOME).map((d) => path.basename(d)) : []),
    pathDirs,
  };
}
const ids = (items) => items.map((i) => i.id).sort();

test('a fresh computer with only Claude Code: everything else switched off, nothing else touched', () => {
  const env = computer({ programs: [`${HOME}/.local/bin/claude`], folders: [`${HOME}/.claude`, `${HOME}/.claude/projects`] });
  const items = detect(defaultSetup(), env);
  assert.deepEqual(ids(items), ['codex:off', 'hermes:off', 'openclaw:off']);
  const { setup } = applyChanges(defaultSetup(), mergeChanges(items.filter((i) => i.suggested)), { local: true, checks: { home: HOME, isExecutable: () => true, isDir: () => true, findOnPath: () => true } });
  assert.deepEqual([setup.agents.hermes.enabled, setup.agents.openclaw.enabled, setup.agents.codex.enabled], [false, false, false]);
  assert.equal(setup.agents.claude[0].command, '~/.local/bin/claude'); // already right: left alone
});

test('a missing command is filled in from where the program really is; a working one is never replaced', () => {
  const s = defaultSetup();
  s.agents.claude[0].command = '~/old/claude'; // gone
  const env = computer({ programs: ['/opt/homebrew/bin/claude', '/opt/homebrew/bin/codex'], folders: [`${HOME}/.codex/sessions`] });
  const items = detect(s, env);
  const fix = items.find((i) => i.id === 'claude:claude:command');
  assert.deepEqual(fix.change, { agents: { claude: [{ id: 'claude', command: '/opt/homebrew/bin/claude' }] } });
  assert.ok(!items.some((i) => i.id === 'codex:command')); // `codex` is on the PATH: the default works
  assert.ok(!items.some((i) => i.id === 'codex:off'));
});

test("OpenClaw's port comes from its own settings", () => {
  const env = computer({ programs: [`${HOME}/.openclaw/bin/openclaw`], json: { [`${HOME}/.openclaw/openclaw.json`]: { gateway: { port: 19001 } } } });
  const item = detect(defaultSetup(), env).find((i) => i.id === 'openclaw:port');
  assert.deepEqual(item.change, { agents: { openclaw: { port: 19001 } } });
});

test('an agent switched off but installed is offered back, not ticked; one not found is never switched on', () => {
  const s = defaultSetup();
  s.agents.codex.enabled = false;
  s.agents.hermes.enabled = false;
  const items = detect(s, computer({ programs: ['/opt/homebrew/bin/codex'] }));
  const on = items.find((i) => i.id === 'codex:on');
  assert.equal(on.suggested, false);
  assert.ok(!items.some((i) => i.id === 'hermes:on'));
});

test('other Claude folders with chats are offered as new accounts, never ticked; known ones are skipped', () => {
  const s = defaultSetup();
  s.agents.claude[0].readOnly = [{ dir: '~/.claude-workspace' }];
  const env = computer({ programs: [`${HOME}/.local/bin/claude`], folders: [
    `${HOME}/.claude`, `${HOME}/.claude/projects`, `${HOME}/.claude-work`, `${HOME}/.claude-work/projects`,
    `${HOME}/.claude-workspace`, `${HOME}/.claude-workspace/projects`, `${HOME}/.claude-empty`] });
  const offers = detect(s, env).filter((i) => i.id.startsWith('claude:add:'));
  assert.deepEqual(offers.map((i) => i.id), ['claude:add:.claude-work']);
  assert.equal(offers[0].suggested, false);
  assert.deepEqual(offers[0].change.agents.addClaude, [{ label: 'Claude work', command: '~/.local/bin/claude', configDir: '~/.claude-work' }]);
});

test('ticked findings merge into one change', () => {
  const merged = mergeChanges([
    { change: { agents: { codex: { command: 'codex' } } } },
    { change: { agents: { codex: { sessionsDir: '~/.codex/sessions' } } } },
    { change: { agents: { claude: [{ id: 'a', command: '/x' }] } } },
    { change: { agents: { claude: [{ id: 'a', configDir: '~/.a' }] } } },
    { change: { agents: { addClaude: [{ label: 'One' }] } } },
    { change: { agents: { addClaude: [{ label: 'Two' }] } } },
  ]);
  assert.deepEqual(merged, { agents: { codex: { command: 'codex', sessionsDir: '~/.codex/sessions' }, claude: [{ id: 'a', command: '/x', configDir: '~/.a' }], addClaude: [{ label: 'One' }, { label: 'Two' }] } });
});

test('a brand-new install runs Detect once; an existing setup or a seed never does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-detect-'));
  let runs = 0;
  const onCreate = (s) => { runs++; return { ...s, usage: { rings: false } }; };
  const file = path.join(dir, 'setup.json');
  assert.equal(loadSetup(file, '', { onCreate }).usage.rings, false);
  loadSetup(file, '', { onCreate });
  assert.equal(runs, 1);
  const seed = path.join(dir, 'seed.json');
  fs.writeFileSync(seed, '{}');
  loadSetup(path.join(dir, 'other.json'), seed, { onCreate });
  assert.equal(runs, 1);
});
