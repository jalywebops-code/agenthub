// Continue later: planned Continues the board sends at a set time (lib/schedule.js), and the card buttons for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSchedule, cannotSend, CONTINUE_MESSAGE } from '../lib/schedule.js';
import { cardActions, CONTINUE_TEXT } from '../public/activity.js';

const store = () => createSchedule(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-schedule-')), 'scheduled.json'));
const chat = (extra = {}) => ({ id: 'personal:s1', harness: 'personal', ref: 's1', title: 'Fix the build', status: 'update', canReply: true, lastActivity: 1000, ...extra });

test('the server sends the same Continue words as the page', () => {
  assert.equal(CONTINUE_MESSAGE, CONTINUE_TEXT);
});

test('a planned Continue goes at its time, once, and the card says so', async () => {
  const s = store();
  await s.plan(chat(), 5000, 'after the 5-hour limit resets');
  const sent = [];
  const send = async (card) => { sent.push(card.id); };
  assert.equal((await s.runDue({ now: 4000, findCard: () => chat(), send })).length, 0); // not yet
  assert.equal((await s.runDue({ now: 5000, findCard: () => chat(), send })).length, 1);
  assert.equal((await s.runDue({ now: 9000, findCard: () => chat(), send })).length, 0); // never twice
  assert.deepEqual(sent, ['personal:s1']);
  const cards = [chat()];
  await s.decorate(cards);
  assert.equal(cards[0].scheduled.state, 'sent');
});

test('not sent when the chat moved on, is working, shows an approval or is gone', () => {
  const plan = { cardActivity: 1000 };
  assert.equal(cannotSend(plan, chat()), '');
  assert.match(cannotSend(plan, chat({ lastActivity: 1000 + 5 * 60000 })), /moved on/);
  assert.match(cannotSend(plan, chat({ status: 'working' })), /working/);
  assert.match(cannotSend(plan, chat({ pendingPrompt: 'Allow?' })), /approval/);
  assert.match(cannotSend(plan, chat({ canReply: false, replyBlockedReason: 'Closed.' })), /Closed/);
  assert.match(cannotSend(plan, null), /not on the board/);
});

test('a chat that moved on is skipped, with the reason on its card', async () => {
  const s = store();
  await s.plan(chat(), 5000);
  let sent = 0;
  await s.runDue({ now: 6000, findCard: () => chat({ lastActivity: 1000 + 10 * 60000 }), send: async () => { sent++; } });
  assert.equal(sent, 0);
  const cards = [chat()];
  await s.decorate(cards);
  assert.equal(cards[0].scheduled.state, 'skipped');
  assert.match(cards[0].scheduled.reason, /moved on/);
});

test('a failed send is reported, and a cancelled plan never goes', async () => {
  const s = store();
  await s.plan(chat(), 5000);
  await s.runDue({ now: 5000, findCard: () => chat(), send: async () => { throw new Error('tmux pane closed'); } });
  const cards = [chat()];
  await s.decorate(cards);
  assert.equal(cards[0].scheduled.state, 'failed');
  assert.equal(cards[0].scheduled.reason, 'tmux pane closed');

  const t = store();
  await t.plan(chat(), 5000);
  assert.equal(await t.cancel('personal:s1'), true);
  assert.equal(await t.anyDue(9000), false);
});

test('planning again replaces the plan waiting for that chat', async () => {
  const s = store();
  await s.plan(chat(), 5000);
  await s.plan(chat(), 7000);
  const cards = [chat()];
  await s.decorate(cards);
  assert.equal(cards[0].scheduled.at, 7000);
  assert.equal(await s.anyDue(6000), false);
});

test('card buttons: Continue at the reset, then Cancel; Continue again once the reset has passed', () => {
  const now = 10000;
  const limited = chat({ limit: { label: '5-hour limit', resetsAt: 20000, continueAt: 140000 } });
  assert.deepEqual(cardActions(limited, now), ['continue-at', 'reply', 'ask', 'details']);
  assert.deepEqual(cardActions({ ...limited, scheduled: { state: 'waiting', at: 140000 } }, now), ['unschedule', 'reply', 'ask', 'details']);
  assert.deepEqual(cardActions(limited, 200000), ['continue', 'reply', 'ask', 'details']);
});
