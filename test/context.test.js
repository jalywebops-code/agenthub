import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askContext, askOf, replyEnd } from '../lib/util.js';

// Lead Launch (OpenClaw): the question points back at the paragraph above it.
const LEAD = 'I checked the existing OpenRouter credential: it works.\n\n**My recommendation:** leave that $0.05 reserved and its outcome marked unknown, but permit further live work within the original $2 total ceiling.\n\n**Are you comfortable with that approach?**';

test('askContext brings the paragraph above a short question', () => {
  const ask = askOf(LEAD);
  assert.equal(ask, '**Are you comfortable with that approach?**');
  assert.match(askContext(LEAD, ask), /^\*\*My recommendation:\*\* leave that \$0\.05 reserved/);
});

test('askContext is empty when there is no question, it is long, or nothing comes before it', () => {
  assert.equal(askContext(LEAD, ''), '');
  assert.equal(askContext('Should I use that design?', 'Should I use that design?'), '');
  const long = `Work done.\n\n${'The exporter now streams rows and the cache key includes the locale. '.repeat(3)}Should I merge it?`;
  assert.equal(askContext(long, askOf(long)), '');
});

test('askContext skips a code block between the context and the question', () => {
  const t = 'I would rename the flag.\n\n```\n--fast\n```\n\nOK with that?';
  assert.equal(askContext(t, askOf(t)), 'I would rename the flag.');
});

// Cline (Hermes): a trailing "Review: `file`" line hid the real request above it.
test('replyEnd skips a trailing file pointer line', () => {
  const t = 'The reference pass is in the brief.\n\nI haven’t reviewed the gallery yet. Please open the work Chrome window and tell me when it’s ready.\n\nReview: `docs/research/spikes/SPIKE_2_DESIGN_WORKSPACE.md`';
  assert.match(replyEnd(t), /Please open the work Chrome window/);
  assert.doesNotMatch(replyEnd(t), /Review:/);
});

test('replyEnd keeps a pointer line that is the whole reply, and a "Next step:" sentence', () => {
  assert.equal(replyEnd('Review: `docs/plan.md`'), 'Review: `docs/plan.md`');
  const next = 'Done.\n\nNext step: reconnect with Sarah through your existing thread.';
  assert.match(replyEnd(next), /Next step: reconnect/);
});
