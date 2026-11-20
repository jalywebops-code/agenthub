import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayHealth, tmuxHealth } from '../lib/health.js';

// A light means "the board can act on it right now".
test('gateway agents: green when the gateway answers, red when it does not', () => {
  assert.equal(gatewayHealth('Hermes', '').health, 'ok');
  const down = gatewayHealth('Hermes', 'Hermes gateway is not ready: stopped');
  assert.equal(down.health, 'down');
  assert.match(down.why, /can't reply/);
  assert.match(down.why, /not ready: stopped/);
});

test('tmux agents: green with a session the board can answer', () => {
  const h = tmuxHealth('Claude Code', { binOk: true, running: 3, inTmux: 1 });
  assert.equal(h.health, 'ok');
  assert.match(h.why, /1 session in tmux/);
});

test('tmux agents: amber when nothing is running, or only sessions the board can only read', () => {
  const none = tmuxHealth('Codex', { binOk: true, running: 0, inTmux: 0 });
  assert.equal(none.health, 'idle');
  assert.match(none.why, /No Codex session is running\. New chat starts one/);
  const readOnly = tmuxHealth('Claude Code', { binOk: true, running: 2, inTmux: 0 });
  assert.equal(readOnly.health, 'idle');
  assert.match(readOnly.why, /2 sessions running, none in tmux/);
});

test('tmux agents: red when the program is missing', () => {
  const h = tmuxHealth('Claude · Work', { binOk: false, bin: '/x/claude-work', running: 0, inTmux: 0 });
  assert.equal(h.health, 'down');
  assert.match(h.why, /\/x\/claude-work/);
});
