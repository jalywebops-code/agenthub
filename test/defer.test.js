// Defer: tell the agent to hold off, and keep its card off the board until you come back to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { keepClosed } from '../lib/closed.js';
import { DEFER_MESSAGE, RESUME_MESSAGE, canDefer } from '../lib/defer.js';
import { act, _setCapture } from '../lib/tmux.js';
import { fakeTmux } from './helpers/fake-tmux.js';

// Never a real tmux: every command is recorded instead.
fakeTmux();

const GRACE = 2 * 60 * 1000;
const at = 1_000_000;

test('the two messages are exactly the ones in the design', () => {
  assert.equal(DEFER_MESSAGE, "Let's hold off on this for now. Please pause here and don't take any further action until I come back to it.");
  assert.equal(RESUME_MESSAGE, "Let's pick this back up where we left off.");
});

test('keepClosed: a plain close still ends on new activity after the grace period', () => {
  assert.equal(keepClosed(at, { lastActivity: at + 60_000 }, GRACE), true);
  assert.equal(keepClosed(at, { lastActivity: at + 3 * 60_000 }, GRACE), false);
});

test("a deferred card stays closed through the agent's own reply", () => {
  const entry = { at, deferred: true, prompts: ['Which colour?', DEFER_MESSAGE] };
  assert.equal(keepClosed(entry, { lastPrompt: DEFER_MESSAGE, lastActivity: at + 3_600_000 }, GRACE), true);
  // Before the transcript shows the defer message, your last message is still the old one.
  assert.equal(keepClosed(entry, { lastPrompt: 'Which colour?', lastActivity: at + 10_000 }, GRACE), true);
});

test('a deferred card comes back when you write in that chat', () => {
  const entry = { at, deferred: true, prompts: ['Which colour?', DEFER_MESSAGE] };
  assert.equal(keepClosed(entry, { lastPrompt: 'Use blue', lastActivity: at + 60_000 }, GRACE), false);
});

test('canDefer: Blocked or Review cards the board can act on, not unanswerable menus', () => {
  const base = { canReply: true, status: 'blocked' };
  assert.equal(canDefer(base), true);
  assert.equal(canDefer({ ...base, status: 'review' }), true);
  assert.equal(canDefer({ ...base, status: 'working' }), false);
  assert.equal(canDefer({ ...base, canReply: false }), false);
  assert.equal(canDefer({ ...base, question: { unsupported: 'an update menu' } }), false);
  assert.equal(canDefer({ ...base, closedAt: 5 }), false);
});

test('act defer refuses a changed menu and presses nothing', async () => {
  const screen = fs.readFileSync(new URL('./fixtures/menus/claude-single.txt', import.meta.url), 'utf8').replace(/\s+$/g, '');
  _setCapture(async () => screen);
  try {
    await assert.rejects(act('%1', { kind: 'defer', message: DEFER_MESSAGE, expectPrompt: true, expectText: 'something else' }),
      /changed since you looked/);
  } finally {
    _setCapture(null);
  }
});

test("the page's copy of the messages matches the server's", async () => {
  const page = await import('../public/activity.js');
  assert.equal(page.DEFER_TEXT, DEFER_MESSAGE);
  assert.equal(page.RESUME_TEXT, RESUME_MESSAGE);
});

// ---- final review fixes ----
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/menus/${name}.txt`, import.meta.url), 'utf8').replace(/\s+$/g, '');

test('escSafe: Esc only where it declines (questions, plan approval, "tell it differently"), never "No, exit"', async () => {
  const { escSafe, detectPrompt } = await import('../lib/tmux.js');
  assert.equal(escSafe(detectPrompt(fixture('claude-trust'))), false);
  assert.equal(escSafe(detectPrompt(fixture('claude-single'))), true);
  assert.equal(escSafe(detectPrompt(fixture('claude-plan-approval'))), true);
  assert.equal(escSafe(detectPrompt(fixture('codex-approval'))), true);
});

test('act defer refuses the folder-trust menu (Esc would quit) before pressing anything', async () => {
  const screen = fixture('claude-trust');
  const { detectPrompt } = await import('../lib/tmux.js');
  _setCapture(async () => screen);
  try {
    await assert.rejects(act('%999', { kind: 'defer', message: DEFER_MESSAGE, expectPrompt: true, expectText: detectPrompt(screen).text }),
      /can't be left safely/);
  } finally {
    _setCapture(null);
  }
});

test('canDefer: no Defer on a menu whose Esc is not safe', () => {
  assert.equal(canDefer({ canReply: true, status: 'blocked', pendingPrompt: 'Trust?', menuEscSafe: false }), false);
  assert.equal(canDefer({ canReply: true, status: 'blocked', pendingPrompt: 'Run?', menuEscSafe: true }), true);
});

test('deferMismatch: the menu you saw must still be the one on the card', async () => {
  const { deferMismatch } = await import('../lib/defer.js');
  const card = { pendingPrompt: 'Run npm test?', question: null };
  assert.equal(deferMismatch(card, { expectPrompt: true, expectText: 'Run npm test?' }), null);
  assert.match(deferMismatch(card, { expectPrompt: false, expectText: '' }), /changed/);
  assert.match(deferMismatch({ pendingPrompt: '' }, { expectPrompt: true, expectText: 'Run npm test?' }), /changed/);
  assert.match(deferMismatch({ pendingPrompt: 'Other?', question: { expect: 'Other?' } }, { expectPrompt: true, expectText: 'Run npm test?' }), /changed/);
});

test('keepClosed: an unreadable last message keeps a deferred card closed', () => {
  const entry = { at, deferred: true, prompts: ['Which colour?', DEFER_MESSAGE] };
  assert.equal(keepClosed(entry, { lastPrompt: '', lastActivity: at + 60_000 }, GRACE), true);
});

test('keepClosed: a short earlier message does not hide a longer new one', () => {
  const entry = { at, deferred: true, prompts: ['yes', DEFER_MESSAGE] };
  assert.equal(keepClosed(entry, { lastPrompt: 'yes, use the blue one', lastActivity: at + 60_000 }, GRACE), false);
});
