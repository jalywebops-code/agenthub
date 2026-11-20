import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION_COMMANDS, parseVersion } from '../lib/versions.js';

test('only read-only commands are ever run (never an update, never for Codex)', () => {
  for (const [agent, cmds] of Object.entries(VERSION_COMMANDS)) {
    for (const cmd of cmds) {
      const words = cmd.split(/\s+/);
      const i = words.indexOf('update');
      assert.ok(i === -1 || words[i + 1] === 'status', `${agent}: ${cmd}`);
      if (agent === 'codex') assert.equal(i, -1);
    }
  }
});

test('Hermes: version and its own "update available"', () => {
  const v = parseVersion('hermes', ["Hermes Agent v0.23.1 (2026.9.24) · stable · local 3b42157\nInstall method: git\nUpdate available — run 'hermes update'"]);
  assert.deepEqual(v, { version: '0.23.1', updateAvailable: true, updateCommand: 'hermes update', note: '' });
});

test('OpenClaw: version plus update status', () => {
  const status = JSON.stringify({ update: { installOwner: { updateHint: 'Update OpenClaw.app to update this Gateway.' } }, availability: { available: false } });
  const v = parseVersion('openclaw', ['OpenClaw 2026.11.3 (847611d)', status]);
  assert.equal(v.version, '2026.11.3');
  assert.equal(v.updateAvailable, false);
  assert.match(v.note, /OpenClaw.app/);
});

test('Claude Code and Codex: version only', () => {
  assert.deepEqual(parseVersion('claude', ['2.1.326 (Claude Code)']), { version: '2.1.326', updateAvailable: null, updateCommand: 'claude update', note: '' });
  const codex = parseVersion('codex', ['codex-cli 0.153.4']);
  assert.equal(codex.version, '0.153.4');
  assert.equal(codex.updateCommand, '');
  assert.match(codex.note, /yourself/);
});

test('every Claude Code account: one --version call through its own command, read like Claude Code', async () => {
  const { VERSION_COMMANDS, parseVersion } = await import('../lib/versions.js');
  const { config } = await import('../lib/config.js');
  assert.ok(config.claudeAccounts.length >= 1);
  for (const a of config.claudeAccounts) {
    assert.equal(VERSION_COMMANDS[a.id].length, 1);
    assert.ok(VERSION_COMMANDS[a.id][0].endsWith(`${a.bin}' --version`), VERSION_COMMANDS[a.id][0]);
    assert.equal(parseVersion(a.id, ['2.1.327 (Claude Code)']).version, '2.1.327');
  }
});
