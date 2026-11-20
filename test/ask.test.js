import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askOf } from '../lib/util.js';

test('askOf finds the question above an attachment line (Hermes)', () => {
  const t = 'Phase 3 is done.\n\nThe team screenshot is still pending. Can I open a **separate work Chrome window** to capture it? I won’t touch the window you’re using.\n\nUpdated plan: MEDIA:/Users/you/projects/example/.hermes/plans/plan.md';
  assert.match(askOf(t), /Can I open a/);
  assert.doesNotMatch(askOf(t), /MEDIA:/);
});

test('askOf finds a bold question a few paragraphs up', () => {
  const t = '**Can you paste Claude’s actual report as well?** What you sent is its self-correction.\n\nCorrection for Claude Code: MEDIA:/Users/you/.hermes/cache/scratch/fix.md';
  assert.match(askOf(t), /Can you paste Claude/);
});

test('askOf finds numbered questions the agent asks you to answer', () => {
  const t = 'I read the transcript.\n\nBefore I start, I need four decisions from you:\n\n1. **Who it is for.** Sam or you.\n2. **The format.** Checklists or prose.\n3. **Where the master copy lives.** Obsidian or Sam’s base.\n4. **The transcript passages.** Still useful.\n\nOnce you’ve answered these, I’ll start with the lifecycle overview.';
  const a = askOf(t);
  assert.match(a, /four decisions/);
  assert.match(a, /1\. \*\*Who it is for/);
});

test('askOf is empty for a plain report', () => {
  assert.equal(askOf('Deleted all four chats. I verified that none of the four remain in the session library.'), '');
  assert.equal(askOf('Done.\n\nNext step: reconnect with Sarah through your existing thread. Nothing has been sent.'), '');
});

test('askOf ignores a question far back or inside code', () => {
  const far = ['Should I do X?', 'Para two.', 'Para three.', 'Para four.', 'Para five.', 'All finished.'].join('\n\n');
  assert.equal(askOf(far), '');
  assert.equal(askOf('Here is the snippet:\n\n```\nconst ok = a ? b : c;\n```\n\nAll finished.'), '');
});

test('askOf returns the last question paragraph when the reply ends with it', () => {
  assert.equal(askOf('Work done.\n\nShould I use that design?'), 'Should I use that design?');
});

test('askOf starts a long paragraph at the sentence before the question', () => {
  const t = 'Status.\n\nI asked where the one-time bank selector should appear; the question timed out without an answer. I haven’t chosen a UI for you, and nothing was changed in the app while waiting. My recommendation is the chat header, visibly showing **“No bank — capture off”** until you select one. Should I use that design?';
  const a = askOf(t);
  assert.ok(a.startsWith('…My recommendation is the chat header'), a);
  assert.ok(a.endsWith('Should I use that design?'));
});

test('askOf ignores "?" in links, code and an answered question further up', () => {
  assert.equal(askOf('Deployed the fix.\n\nPreview: https://app.vercel.app/dashboard?tab=jobs\n\nAll 85 tests pass.'), '');
  assert.equal(askOf('Done. Changed `foo?.bar` to a guard.'), '');
  assert.equal(askOf('Why did it fail? The cache key was stale.\n\nI fixed it and pushed.\n\nAll tests pass.'), '');
});
