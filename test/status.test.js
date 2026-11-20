import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitWaiting, sortCards } from '../lib/status.js';

const one = (c) => splitWaiting([{ status: 'waiting', ...c }])[0].status;

test('approval is blocked', () => assert.equal(one({ needsApproval: true }), 'blocked'));
test('clarify question is blocked', () => assert.equal(one({ question: { kind: 'clarify' } }), 'blocked'));
test('a reply that asks is blocked', () => assert.equal(one({ ask: 'Should I merge it?' }), 'blocked'));
test('a report that asks you to do something is review', () => {
  assert.equal(one({ ask: '', lastReply: 'Done.\n\nPlease open the work Chrome window and tell me when it’s ready.' }), 'review');
  assert.equal(one({ ask: '', lastReply: 'No new work. The contract is correctly blocked awaiting your choice between the two.' }), 'review');
  assert.equal(one({ ask: '', lastReply: 'Nothing committed. The page is ready for visual review; publishing remains a separate approval.' }), 'review');
});
// A status report with nothing for you to do is not "Needs you" (e.g. "Started the release candidate").
test('a plain status report is an update, not review', () => {
  assert.equal(one({ ask: '', lastReply: 'Started the local release-candidate assembly. It is running: the task carries over the boundary.\n\nThis is the first slice. No live data or deployment is in scope.' }), 'update');
  assert.equal(one({ ask: '', lastReply: 'Paused. No further action taken.' }), 'update');
  assert.equal(one({ ask: '', lastReply: '' }), 'update');
});
test('a request far up a long report does not count, only the last paragraphs', () => {
  const t = ['Please send the logo.', 'Step two done.', 'Step three done.', 'Step four done.', 'All finished and deployed.'].join('\n\n');
  assert.equal(one({ ask: '', lastReply: t }), 'update');
});
test('other statuses untouched', () => {
  const cards = splitWaiting([{ status: 'working' }, { status: 'idle' }, { status: 'done' }]);
  assert.deepEqual(cards.map((c) => c.status), ['working', 'idle', 'done']);
});

test('sortCards orders blocked (approvals first, then longest wait), then review, then the rest', () => {
  const cards = sortCards([
    { id: 'review-old', status: 'review', waitingSince: 1 },
    { id: 'update', status: 'update', waitingSince: 0 },
    { id: 'working', status: 'working', lastActivity: 9 },
    { id: 'blocked-old', status: 'blocked', waitingSince: 2 },
    { id: 'approval-new', status: 'blocked', needsApproval: true, waitingSince: 8 },
  ]);
  assert.deepEqual(cards.map((c) => c.id), ['approval-new', 'blocked-old', 'review-old', 'update', 'working']);
});

test('triage lists approvals, other blocked, to review and running', async () => {
  const { triageText } = await import('../lib/triage.js');
  const card = (o) => ({ title: o.id, harness: 'claude', project: 'P', cwd: '', ...o });
  const t = triageText({ lanes: {}, cards: [card({ id: 'A', status: 'blocked', needsApproval: true }), card({ id: 'B', status: 'blocked' }),
    card({ id: 'R', status: 'review' }), card({ id: 'W', status: 'working' })] });
  assert.match(t, /NEEDS APPROVAL \(1\)/);
  assert.match(t, /BLOCKED, other \(1\)/);
  assert.match(t, /TO REVIEW \(1\)/);
  assert.match(t, /RUNNING \(1\)/);
});

test('a chat you paused is parked (idle, Paused), even when its reply lists what is left as numbered items', () => {
  const card = (prompt, reply, extra = {}) => ({ status: 'waiting', lastPrompt: prompt, lastReply: reply,
    question: { kind: 'reply', options: ['a', 'b', 'c'] }, ...extra });
  const parked = card("Let's pause here for now, I'll come back to it tomorrow.",
    'Pausing. When you pick this back up, the open items are:\n1. The steps\n2. The phone number\n3. Email leads');
  splitWaiting([parked]);
  assert.equal(parked.status, 'idle');
  assert.equal(parked.paused, true);
  assert.equal(parked.question, null);
  // Only one side mentions a pause: not parked.
  const feature = card('Add a pause button to the player.', 'Which style?\n1. Icon\n2. Text\n3. Both');
  splitWaiting([feature]);
  assert.equal(feature.status, 'blocked');
  // An approval still needs you, whatever was said.
  const approval = card('Pause after this deploy.', "I'll wait for your approval to deploy.", { needsApproval: true });
  splitWaiting([approval]);
  assert.equal(approval.status, 'blocked');
});
