// Suggested reply: the reply you would most likely send, written when you ask for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestPrompt, cleanSuggestion, suggestKey, suggestAgent } from '../lib/suggest.js';

const card = {
  id: 'claude:abc', harness: 'claude', status: 'blocked', title: 'Fix the parser',
  ask: 'Should I run the tests now or wait for the migration?',
  replyEnd: 'Should I run the tests now or wait for the migration?',
  lastReply: 'I fixed the parser in lib/util.js.\n\nShould I run the tests now or wait for the migration?',
  question: { kind: 'reply', options: ['run the tests now', 'wait for the migration'] },
};

test('the prompt carries the end of the agent message, its question and its options', () => {
  const p = suggestPrompt(card);
  assert.match(p, /I fixed the parser/);
  assert.match(p, /Should I run the tests now or wait for the migration\?/);
  assert.match(p, /run the tests now/);
  assert.match(p, /only the reply/i);
});

test('cleanSuggestion: one plain reply, no quotes or label, at most 300 characters', () => {
  assert.equal(cleanSuggestion('"Run the tests now."'), 'Run the tests now.');
  assert.equal(cleanSuggestion('Reply: Yes, go ahead.'), 'Yes, go ahead.');
  assert.equal(cleanSuggestion('  Sure.  \n'), 'Sure.');
  assert.equal(cleanSuggestion('x'.repeat(400)).length, 300);
  assert.equal(cleanSuggestion(''), '');
});

test('suggestKey changes when the agent says something new', () => {
  assert.notEqual(suggestKey(card), suggestKey({ ...card, replyEnd: 'Done. Anything else?' }));
  assert.equal(suggestKey(card), suggestKey({ ...card }));
});

test("suggestAgent: a Claude account's cards use that account; everything else the first Claude account", () => {
  const ids = new Set(['personal', 'work']);
  assert.equal(suggestAgent({ harness: 'work' }, ids, 'personal'), 'work');
  for (const h of ['personal', 'hermes', 'openclaw', 'codex']) assert.equal(suggestAgent({ harness: h }, ids, 'personal'), 'personal');
});
