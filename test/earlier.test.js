import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earlierTurns } from '../lib/util.js';

const you = (text) => ({ role: 'you', text });
const agent = (text) => ({ role: 'agent', text });

test('earlierTurns gives the conversation before the last reply, oldest first', () => {
  const msgs = [you('Find printers'), agent('Found three.'), you('Check Penmar'), agent('Penmar stays on hold.')];
  assert.deepEqual(earlierTurns(msgs), [you('Find printers'), agent('Found three.'), you('Check Penmar')]);
});

test('earlierTurns keeps only the last of the agent\'s in-between notes in a turn', () => {
  const msgs = [you('Fix the build'), agent('Let me look.'), agent('Checking the config.'), agent('Fixed: the path was wrong.'), you('Ship it'), agent('Shipped.')];
  assert.deepEqual(earlierTurns(msgs), [you('Fix the build'), agent('Fixed: the path was wrong.'), you('Ship it')]);
});

test('earlierTurns skips empty and system-injected messages', () => {
  const msgs = [you('<system-reminder>x</system-reminder>'), you('Real question'), agent('   '), agent('Answer.'), agent('Last.')];
  assert.deepEqual(earlierTurns(msgs), [you('Real question')]);
});

test('earlierTurns stays within its budget, keeping the most recent turns and cutting long ones', () => {
  const long = 'Earlier detail. '.repeat(200);
  const msgs = [you('one'), agent(long), you('two'), agent(long), you('three'), agent('Done.')];
  const out = earlierTurns(msgs, 1200);
  assert.equal(out[out.length - 1].text, 'three');
  assert.ok(out.reduce((n, t) => n + t.text.length, 0) <= 1200, 'over budget');
  assert.ok(out.every((t) => t.text.length <= 700), 'a turn is too long');
  assert.ok(out[0].text.startsWith('…'), 'a cut agent turn keeps its end');
});

test('earlierTurns is empty with no agent reply', () => {
  assert.deepEqual(earlierTurns([you('hello')]), []);
  assert.deepEqual(earlierTurns([]), []);
});
