// Settings → Agent settings (step C1): what a change may touch, the computer-only rule, and where the settings land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, defaultSetup } from '../lib/setup.js';
import { fromThisComputer } from '../lib/local.js';
import { startArgv } from '../lib/lanes/claude.js';
import { suggestAgent } from '../lib/suggest.js';

const base = () => {
  const s = defaultSetup();
  s.agents.claude = [
    { id: 'personal', label: 'Claude Personal', command: '~/bin/claude', configDir: '~/.claude', readOnly: [] },
    { id: 'work', label: 'Claude Work', command: '~/bin/claude-work', configDir: '~/.claude-work', readOnly: [] },
  ];
  return s;
};

test('from this computer: loopback, not forwarded, asked for by name', () => {
  assert.equal(fromThisComputer({ peer: '127.0.0.1', host: 'localhost:4400' }), true);
  assert.equal(fromThisComputer({ peer: '::1', host: '[::1]:4400' }), true);
  assert.equal(fromThisComputer({ peer: '::ffff:127.0.0.1', host: '127.0.0.1' }), true);
  // tailscale serve also arrives over loopback, but forwarded: a phone.
  assert.equal(fromThisComputer({ peer: '127.0.0.1', forwarded: '100.64.0.7', host: 'example.ts.net' }), false);
  assert.equal(fromThisComputer({ peer: '127.0.0.1', host: 'example.ts.net' }), false);
  assert.equal(fromThisComputer({ peer: '100.64.0.7', host: 'localhost:4400' }), false);
  assert.equal(fromThisComputer({ peer: '192.168.1.20', host: '192.168.1.5:4400' }), false);
});

test('switching agents on and off works from any device', () => {
  const { setup, error } = applyChanges(base(), { agents: { hermes: { enabled: false }, claude: [{ id: 'work', enabled: false }] } });
  assert.equal(error, undefined);
  assert.equal(setup.agents.hermes.enabled, false);
  assert.equal(setup.agents.claude.find((a) => a.id === 'work').enabled, false);
});

test('a default model can only be changed on the computer itself', () => {
  assert.match(applyChanges(base(), { agents: { claude: [{ id: 'personal', model: 'opus' }] } }).error, /only be changed on the computer/);
  assert.match(applyChanges(base(), { agents: { codex: { model: 'gpt-5.5' } } }).error, /only be changed on the computer/);
  const { setup } = applyChanges(base(), { agents: { claude: [{ id: 'personal', model: 'opus' }], codex: { model: 'gpt-5.5' } } }, { local: true });
  assert.equal(setup.agents.claude[0].model, 'opus');
  assert.equal(setup.agents.codex.model, 'gpt-5.5');
  // Sending the same value back from a phone (unchanged) is fine.
  assert.equal(applyChanges(setup, { agents: { codex: { model: 'gpt-5.5', enabled: true } } }).error, undefined);
  // Empty clears it, back to the agent's own default.
  assert.equal(applyChanges(setup, { agents: { codex: { model: '' } } }, { local: true }).setup.agents.codex.model, undefined);
});

test('a model name can never become an option or anything but a plain name', () => {
  for (const bad of ['--dangerously-skip-permissions', '-m', 'opus; rm -rf ~', 'a b', '$(x)', '../x', 'x'.repeat(80)]) {
    assert.ok(applyChanges(base(), { agents: { codex: { model: bad } } }, { local: true }).error, bad);
  }
  assert.equal(applyChanges(base(), { agents: { codex: { model: 'gpt-5.5-codex' } } }, { local: true }).error, undefined);
  assert.equal(applyChanges(base(), { agents: { claude: [{ id: 'personal', model: 'claude-opus-5-5' }] } }, { local: true }).error, undefined);
});

test('only the fields Settings edits; no unknown accounts', () => {
  assert.match(applyChanges(base(), { agents: { codex: { command: '/tmp/evil' } } }).error, /only be changed on the computer/);
  assert.match(applyChanges(base(), { preview: { chrome: '/tmp/x' } }, { local: true }).error, /can't be changed here/);
  assert.match(applyChanges(base(), { agents: { claude: [{ id: 'nobody', enabled: false }] } }).error, /no Claude account/);
  assert.match(applyChanges(base(), { agents: { hermes: { enabled: 'yes' } } }).error, /on or off/);
});

test('suggested replies and usage rings', () => {
  const { setup } = applyChanges(base(), { suggest: { agent: 'work', model: 'haiku' }, usage: { rings: false } });
  assert.deepEqual(setup.suggest, { agent: 'work', model: 'haiku' });
  assert.equal(setup.usage.rings, false);
  assert.match(applyChanges(base(), { suggest: { agent: 'nobody' } }).error, /Claude accounts/);
  assert.match(applyChanges(base(), { suggest: { model: '' } }).error, /pick a model/);
});

test('a change leaves everything else as it was, and never edits the input', () => {
  const before = base();
  const copy = JSON.stringify(before);
  const { setup } = applyChanges(before, { usage: { rings: false } });
  assert.equal(JSON.stringify(before), copy);
  assert.deepEqual({ ...setup, usage: before.usage }, before);
});

test('New chat passes the default model, after the folder for a wrapper', () => {
  assert.deepEqual(startArgv({ bin: 'claude', dirs: ['/h/.claude'], defaultDir: true, model: 'opus' }, '/p/site', 'hi'),
    ['/usr/bin/env', '-u', 'CLAUDE_CONFIG_DIR', 'claude', '--model', 'opus', 'hi']);
  assert.deepEqual(startArgv({ bin: '/b/claude-work', dirs: ['/h/.claude-work'], folderArg: true, model: 'sonnet' }, '/p/site', 'hi'),
    ['/b/claude-work', '/p/site', '--model', 'sonnet', 'hi']);
  assert.deepEqual(startArgv({ bin: 'claude', dirs: ['/h/.claude-work'] }, '/p/site', 'hi'),
    ['/usr/bin/env', 'CLAUDE_CONFIG_DIR=/h/.claude-work', 'claude', 'hi']);
});

test('suggestions: the account chosen in Settings, else the chat\'s own, else the first', () => {
  const ids = new Set(['personal', 'work']);
  assert.equal(suggestAgent({ harness: 'work' }, ids, 'personal', ''), 'work');
  assert.equal(suggestAgent({ harness: 'hermes' }, ids, 'personal', ''), 'personal');
  assert.equal(suggestAgent({ harness: 'work' }, ids, 'personal', 'personal'), 'personal');
  assert.equal(suggestAgent({ harness: 'work' }, ids, 'personal', 'switched-off'), 'work');
});
