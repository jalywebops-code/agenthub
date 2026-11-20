import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewKind } from '../lib/util.js';
import { splitWaiting } from '../lib/status.js';

// A "ready for visual review" card offered a green Approve with nothing to approve.
test('reviewKind: work to look at is a check, even when it mentions a later approval', () => {
  assert.equal(reviewKind('Nothing committed or deployed. The page is ready for visual review; publishing remains a separate approval.'), 'check');
  assert.equal(reviewKind('Deployed the preview. Please take a look at https://example.vercel.app and tell me what to change.'), 'check');
  assert.equal(reviewKind('The draft is done. Can you review it before I send it?'), 'check');
});

test('reviewKind: asking for a go-ahead is an approval', () => {
  assert.equal(reviewKind('The migration is ready. I need your go-ahead before I run it.'), 'approval');
  assert.equal(reviewKind('Waiting for your approval to push.'), 'approval');
  assert.equal(reviewKind('Everything passes. OK to proceed with the deploy?'), 'approval');
});

test('reviewKind: a question that starts with Approve, or a gate that needs approval, is an approval', () => {
  // The shape of a real card that got only Reply (Nov 19).
  assert.equal(reviewKind([
    'I confirmed the commands have no protected proxy connection. The draft exists; no credits were spent.',
    'Approve enabling the egress proxy setting and restarting the gateway? This may briefly interrupt connections. Afterwards I’ll run read-only checks.',
    'Your project rules explicitly require approval for config changes. This approval would not authorize generation or publication.',
  ].join('\n\n')), 'approval');
  assert.equal(reviewKind('Next gate: approval for the protected API configuration change.'), 'approval');
  assert.equal(reviewKind('Approve running the migration on the staging database?'), 'approval');
  assert.equal(reviewKind('The script is ready. Do you approve the cleanup of the old builds?'), 'approval');
  assert.equal(reviewKind('Changing the DNS records needs your approval.'), 'approval');
});

test('reviewKind: a later approval mentioned in a report is not asked for now', () => {
  assert.equal(reviewKind('Built the pages. Deploying to production will be a separate approval step later.'), 'request');
});

test('reviewKind: anything else asked of you is a plain request', () => {
  assert.equal(reviewKind('Please open the work Chrome window and tell me when it’s ready.'), 'request');
  assert.equal(reviewKind('The contract is blocked awaiting your choice between the two.'), 'request');
});

test('a review card carries its kind', () => {
  const [c] = splitWaiting([{ status: 'waiting', ask: '', lastReply: 'The page is ready for visual review.' }]);
  assert.equal(c.status, 'review');
  assert.equal(c.reviewKind, 'check');
});

// These read as plain updates but were waiting on you.
test('holding work for your feedback is a review gate; "we still need" is a request', () => {
  const holding = 'The task is complete. The preview is still open. I’m holding the next release step for your visual feedback; the technical gate also remains blocked.';
  const [a] = splitWaiting([{ status: 'waiting', ask: '', lastReply: holding }]);
  assert.equal(a.status, 'review');
  assert.equal(a.reviewKind, 'check');
  const need = 'The protected-entry request timed out without receiving a value, so nothing was stored. We still need the secret key through masked entry, not chat.';
  const [b] = splitWaiting([{ status: 'waiting', ask: '', lastReply: need }]);
  assert.equal(b.status, 'review');
  assert.equal(b.reviewKind, 'request');
});

test('a plain progress report stays an update', () => {
  const [c] = splitWaiting([{ status: 'waiting', ask: '', lastReply: 'Checks passed. Next is qualifying recurring draft updates and conversion tracking. Automated publishing isn’t active.' }]);
  assert.equal(c.status, 'update');
});

// "Review this local file" was an Update with Continue.
test('a review request without a question mark still counts as asking you', () => {
  const t = 'Result: reviewed the package.\n\nMEDIA:/Users/you/.hermes/kanban/boards/demo/attachments/t_1/comparison.html\n\nReview this local file. It’s an offline comparison with desktop and mobile screenshots, so no localhost server is needed.';
  const [c] = splitWaiting([{ status: 'waiting', ask: '', lastReply: t }]);
  assert.equal(c.status, 'review');
  assert.equal(c.reviewKind, 'check');
});
