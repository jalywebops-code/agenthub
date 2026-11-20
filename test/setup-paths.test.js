// Settings → program paths and Claude accounts (step C2): computer only, checked against the disk, stored tidily.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, defaultSetup } from '../lib/setup.js';

// A pretend computer: home /Users/you, a few programs and folders.
const HOME = '/Users/you';
const programs = new Set(['/Users/you/.local/bin/claude', '/Users/you/bin/claude-work', '/opt/homebrew/bin/codex', '/Users/you/.openclaw/bin/openclaw']);
const folders = new Set(['/Users/you/.claude', '/Users/you/.claude-work', '/Users/you/.claude-other', '/Users/you/.codex/sessions', '/Users/you/elsewhere', '/tmp']);
const checks = { home: HOME, isExecutable: (p) => programs.has(p), isDir: (p) => folders.has(p), findOnPath: (n) => n === 'codex' };
const at = (changes, local = true) => applyChanges(base(), changes, { local, checks });
const base = () => {
  const s = defaultSetup();
  s.agents.claude = [{ id: 'claude', label: 'Claude Code', command: '~/.local/bin/claude', configDir: '~/.claude', readOnly: [] }];
  return s;
};

test('paths and accounts can never be changed from a phone', () => {
  for (const c of [{ agents: { codex: { command: 'codex' } } }, { agents: { openclaw: { port: 18790 } } },
    { agents: { addClaude: { label: 'Work', command: '~/bin/claude-work', configDir: '~/.claude-work' } } },
    { agents: { claude: [{ id: 'claude', label: 'Mine' }] } }, { agents: { removeClaude: ['claude'] } }]) {
    assert.match(at(c, false).error, /only be changed on the computer/, JSON.stringify(c));
  }
});

test('commands: a real program by full path, or a name found on the PATH', () => {
  assert.equal(at({ agents: { codex: { command: 'codex' } } }).setup.agents.codex.command, 'codex');
  assert.equal(at({ agents: { codex: { command: '/opt/homebrew/bin/codex' } } }).setup.agents.codex.command, '/opt/homebrew/bin/codex');
  assert.equal(at({ agents: { openclaw: { bin: '/Users/you/.openclaw/bin/openclaw' } } }).setup.agents.openclaw.bin, '~/.openclaw/bin/openclaw');
  assert.match(at({ agents: { codex: { command: 'nope' } } }).error, /isn't installed/);
  assert.match(at({ agents: { codex: { command: '/usr/bin/nothing' } } }).error, /no program/);
  assert.match(at({ agents: { codex: { command: 'codex; rm -rf ~' } } }).error, /letters, digits/);
  assert.match(at({ agents: { codex: { command: 'bin/codex' } } }).error, /full path/);
});

test('folders must exist inside the home folder', () => {
  assert.equal(at({ agents: { codex: { sessionsDir: '~/.codex/sessions' } } }).setup.agents.codex.sessionsDir, '~/.codex/sessions');
  assert.match(at({ agents: { codex: { sessionsDir: '/tmp' } } }).error, /inside your home folder/);
  assert.match(at({ agents: { codex: { sessionsDir: '~/missing' } } }).error, /no folder/);
  assert.match(at({ agents: { codex: { sessionsDir: '~/../other/x' } } }).error, /inside your home folder/);
});

test('ports and the Hermes dashboard address', () => {
  assert.equal(at({ agents: { openclaw: { port: '18790' } } }).setup.agents.openclaw.port, 18790);
  assert.match(at({ agents: { openclaw: { port: 70000 } } }).error, /1 to 65535/);
  assert.equal(at({ agents: { hermes: { dashboardUrl: 'http://localhost:9120/' } } }).setup.agents.hermes.dashboardUrl, 'http://localhost:9120');
  assert.match(at({ agents: { hermes: { dashboardUrl: 'http://example.com:9119' } } }).error, /on this computer/);
});

test('adding a Claude account gives it a lasting id from its name', () => {
  const { setup, error } = at({ agents: { addClaude: { label: 'Claude Work', command: '~/bin/claude-work', configDir: '~/.claude-work', folderArg: true, tag: 'WRK', accent: 'blue-yellow' } } });
  assert.equal(error, undefined);
  assert.deepEqual(setup.agents.claude[1], { id: 'claude-work', label: 'Claude Work', command: '~/bin/claude-work', configDir: '~/.claude-work', folderArg: true, tag: 'WRK', accent: 'blue-yellow', readOnly: [] });
  // A second one with a similar name gets its own id.
  const again = applyChanges(setup, { agents: { addClaude: { label: 'Work', command: '~/.local/bin/claude', configDir: '~/.claude-other' } } }, { local: true, checks });
  assert.equal(again.setup.agents.claude[2].id, 'claude-work-2');
});

test('a new account needs a name, a program and a Claude folder of its own', () => {
  assert.match(at({ agents: { addClaude: { command: '~/bin/claude-work', configDir: '~/.claude-work' } } }).error, /1 to 24/);
  assert.match(at({ agents: { addClaude: { label: 'Work', configDir: '~/.claude-work' } } }).error, /give the command/);
  assert.match(at({ agents: { addClaude: { label: 'Work', command: '~/bin/claude-work', configDir: '~/.claude' } } }).error, /same Claude folder/);
  assert.match(at({ agents: { addClaude: { label: 'claude code', command: '~/bin/claude-work', configDir: '~/.claude-work' } } }).error, /same name/);
  assert.match(at({ agents: { addClaude: { label: 'Work', command: '~/bin/claude-work', configDir: '~/.claude-work', accent: 'neon' } } }).error, /colour/);
});

test('editing and removing accounts', () => {
  const two = at({ agents: { addClaude: { label: 'Work', command: '~/bin/claude-work', configDir: '~/.claude-work' } } }).setup;
  two.suggest.agent = 'claude-work';
  const renamed = applyChanges(two, { agents: { claude: [{ id: 'claude', label: 'Personal', tag: 'ME' }] } }, { local: true, checks }).setup;
  assert.equal(renamed.agents.claude[0].label, 'Personal');
  assert.equal(renamed.agents.claude[0].id, 'claude'); // the id never changes
  const removed = applyChanges(two, { agents: { removeClaude: ['claude-work'] } }, { local: true, checks }).setup;
  assert.deepEqual(removed.agents.claude.map((a) => a.id), ['claude']);
  assert.equal(removed.suggest.agent, ''); // suggestions fall back to the chat's own account
  assert.match(applyChanges(removed, { agents: { removeClaude: ['claude'] } }, { local: true, checks }).error, /at least one/);
});
