// Several Claude Code accounts on one computer: each lane shows only the sessions registered in its own config folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeLane } from '../lib/lanes/claude.js';
import { ownsConfigDir } from '../lib/tmux.js';
import { fakeTmux } from './helpers/fake-tmux.js';

// Never a real tmux: every command is recorded instead.
fakeTmux();

/** A config folder with one live (this process) session and its transcript. */
function configDir(root, name, sessionId, cwd) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', `${sessionId}.json`),
    JSON.stringify({ pid: process.pid, sessionId, cwd, kind: 'interactive', status: 'idle', statusUpdatedAt: Date.now() }));
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'projects', 'x', `${sessionId}.jsonl`), [
    { type: 'user', cwd, timestamp: ts, message: { role: 'user', content: `hello from ${sessionId}` } },
    { type: 'assistant', cwd, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-accounts-'));
const A = configDir(root, 'a', 'a1', '/tmp/project-a');
const B = configDir(root, 'b', 'b1', '/tmp/project-b');
const C = configDir(root, 'c', 'c1', '/x/Clients/west-coast/site');
const D = configDir(root, 'd', 'd1', '/x/Clients');

// Two example accounts: a personal one and a work one (ids and labels come from each install's setup).
const personal = (extra = {}) => ({ id: 'personal', label: 'Claude Personal', bin: 'claude', dirs: [A], ...extra });
const work = (extra = {}) => ({ id: 'work', label: 'Claude Work', bin: 'claude-work', dirs: [B], ...extra });

test('a lane only shows sessions registered in its own folders', async () => {
  const mine = (await createClaudeLane(personal()).collect()).cards.map((c) => c.ref);
  const theirs = (await createClaudeLane(work()).collect()).cards.map((c) => c.ref);
  assert.ok(mine.includes('a1') && !mine.includes('b1'));
  assert.ok(theirs.includes('b1') && !theirs.includes('a1'));
});

test('card ids, harness and account carry the account id', async () => {
  const card = (await createClaudeLane(work()).collect()).cards.find((c) => c.ref === 'b1');
  assert.equal(card.id, 'work:b1');
  assert.equal(card.harness, 'work');
  assert.equal(card.account, 'work');
});

test('read-only sessions name their sub-folder and carry the setup tag', async () => {
  const lane = createClaudeLane(work({ readOnlyDirs: [C], readOnlyRoot: '/x/Clients', readOnlyTag: 'Tools' }));
  const cards = (await lane.collect()).cards;
  assert.equal(cards.find((c) => c.ref === 'c1').readOnly, 'west-coast');
  assert.equal(cards.find((c) => c.ref === 'c1').readOnlyTag, 'Tools');
  assert.equal(cards.find((c) => c.ref === 'b1').readOnly, '');
});

test('a read-only session in the read-only root itself is labelled by that folder', async () => {
  const lane = createClaudeLane(work({ readOnlyDirs: [D], readOnlyRoot: '/x/Clients', readOnlyTag: 'Tools' }));
  assert.equal((await lane.collect()).cards.find((c) => c.ref === 'd1').readOnly, 'Clients');
  const named = createClaudeLane(work({ readOnlyDirs: [D], readOnlyRoot: '/x/Clients', readOnlyTag: 'Tools', readOnlyName: 'All clients' }));
  assert.equal((await named.collect()).cards.find((c) => c.ref === 'd1').readOnly, 'All clients');
});

test('ownsConfigDir: an unset CLAUDE_CONFIG_DIR means ~/.claude', () => {
  assert.equal(ownsConfigDir('', ['/h/.claude'], '/h'), true);
  assert.equal(ownsConfigDir('', ['/h/.claude-work'], '/h'), false);
  assert.equal(ownsConfigDir('/h/.claude-work', ['/h/.claude-work'], '/h'), true);
  assert.equal(ownsConfigDir('/h/.claude-work/', ['/h/.claude-work'], '/h'), true);
  assert.equal(ownsConfigDir('/h/.claude-work', ['/h/.claude'], '/h'), false);
});

test('startArgv: every account is pinned to its own config folder', async () => {
  const { startArgv } = await import('../lib/lanes/claude.js');
  // The default folder (~/.claude): an inherited CLAUDE_CONFIG_DIR (e.g. a tmux server started from another account) is dropped.
  assert.deepEqual(startArgv({ bin: 'claude', dirs: ['/h/.claude'], defaultDir: true }, '/p/site', 'hi'),
    ['/usr/bin/env', '-u', 'CLAUDE_CONFIG_DIR', 'claude', 'hi']);
  // Another folder with plain claude: set explicitly.
  assert.deepEqual(startArgv({ bin: 'claude', dirs: ['/h/.claude-work'] }, '/p/site', 'hi'),
    ['/usr/bin/env', 'CLAUDE_CONFIG_DIR=/h/.claude-work', 'claude', 'hi']);
  // A wrapper that takes the folder: the folder is passed explicitly, first.
  assert.deepEqual(startArgv({ bin: '/b/claude-work', dirs: ['/h/.claude-work'], folderArg: true }, '/p/site', 'hi'),
    ['/b/claude-work', '/p/site', 'hi']);
});

test("a wrapper's New chat can't be turned into one of its options by the message", async () => {
  const { startArgv } = await import('../lib/lanes/claude.js');
  const argv = startArgv({ bin: '/b/claude-work', folderArg: true }, '/p/site', '--workspace=west-coast');
  assert.ok(!argv[2].startsWith('-'));
  assert.ok(argv.every((a) => !a.startsWith('--workspace')));
});
