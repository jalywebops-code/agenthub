import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNewChat, chatTitle } from '../lib/newchat.js';

const ctx = { connected: ['hermes', 'openclaw', 'claude', 'codex'], folders: ['/Users/you/projects/example'] };
const ok = { agent: 'claude', folder: '/Users/you/projects/example', message: 'Hello', confirm: true };

test('checkNewChat accepts a listed folder for every agent', () => {
  for (const agent of ctx.connected) assert.equal(checkNewChat({ ...ok, agent }, ctx), null, agent);
});

test('checkNewChat allows No folder only for Hermes and OpenClaw', () => {
  assert.equal(checkNewChat({ ...ok, agent: 'hermes', folder: '' }, ctx), null);
  assert.equal(checkNewChat({ ...ok, agent: 'openclaw', folder: '' }, ctx), null);
  assert.match(checkNewChat({ ...ok, agent: 'claude', folder: '' }, ctx), /Pick a project folder/);
  assert.match(checkNewChat({ ...ok, agent: 'codex', folder: '' }, ctx), /Pick a project folder/);
});

test('checkNewChat refuses what the board did not offer', () => {
  assert.match(checkNewChat({ ...ok, confirm: false }, ctx), /Not confirmed/);
  assert.match(checkNewChat({ ...ok, agent: 'codex' }, { ...ctx, connected: ['hermes'] }), /not connected/);
  assert.match(checkNewChat({ ...ok, agent: 'nope' }, ctx), /not connected/);
  assert.match(checkNewChat({ ...ok, folder: '/etc' }, ctx), /listed folders/);
  assert.match(checkNewChat({ ...ok, message: '   ' }, ctx), /Type the first message/);
  assert.match(checkNewChat({ ...ok, message: 'x'.repeat(8001) }, ctx), /too long/);
});

test('chatTitle is the first line, plain, at most 60 characters', () => {
  assert.equal(chatTitle('**Fix** the exporter\nmore detail'), 'Fix the exporter');
  const t = chatTitle('a'.repeat(100));
  assert.equal(t.length, 60);
  assert.ok(t.endsWith('…'));
});

test('checkNewChat refuses a folder that is not plain text', () => {
  assert.match(checkNewChat({ ...ok, agent: 'openclaw', folder: ['/etc'] }, ctx), /listed folders/);
});

test('safeFirstMessage keeps a message that starts with "-" from being read as an option', async () => {
  const { safeFirstMessage } = await import('../lib/newchat.js');
  assert.equal(safeFirstMessage('- fix the exporter'), ' - fix the exporter');
  assert.equal(safeFirstMessage('Fix it'), 'Fix it');
});

test('New chat for any Claude account needs a folder', () => {
  const ctx = { connected: ['work'], folders: ['/p/site'], needsFolder: new Set(['work', 'codex']) };
  assert.equal(checkNewChat({ confirm: true, agent: 'work', message: 'hi', folder: '/p/site' }, ctx), null);
  assert.match(checkNewChat({ confirm: true, agent: 'work', message: 'hi' }, ctx), /^Pick a project folder for /);
});
