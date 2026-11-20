import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activity } from '../public/activity.js';

test('activity lists agents with a working open card', () => {
  const a = activity([{ harness: 'codex', status: 'working' }, { harness: 'claude', status: 'idle' }]);
  assert.deepEqual([...a.working], ['codex']);
  assert.deepEqual([...a.needsYou], []);
});

test('activity ignores closed cards', () => {
  assert.equal(activity([{ harness: 'codex', status: 'working', closedAt: 1 }]).working.size, 0);
});

test('an agent can be both working and needing you (blocked or review)', () => {
  const a = activity([{ harness: 'hermes', status: 'working' }, { harness: 'hermes', status: 'blocked' }, { harness: 'codex', status: 'review' }]);
  assert.ok(a.working.has('hermes'));
  assert.deepEqual([...a.needsYou].sort(), ['codex', 'hermes']);
});

test('a folded project opens up under Needs you, a status chip or a search', async () => {
  const { foldApplies } = await import('../public/activity.js');
  assert.equal(foldApplies({ needs: false, q: '', status: 'all' }), true);
  assert.equal(foldApplies({ needs: true, q: '', status: 'all' }), false);
  assert.equal(foldApplies({ needs: false, q: 'label', status: 'all' }), false);
  assert.equal(foldApplies({ needs: false, q: '', status: 'blocked' }), false);
});

test('cardActions: one way to answer per situation, plus Defer where you might not be ready', async () => {
  const { cardActions } = await import('../public/activity.js');
  const can = { canReply: true };
  // A question: Answer (its choices, or a reply box), or Defer it.
  assert.deepEqual(cardActions({ ...can, status: 'blocked', ask: 'Which one?' }), ['answer', 'defer', 'ask', 'details']);
  assert.deepEqual(cardActions({ ...can, status: 'blocked', question: { kind: 'reply' } }), ['answer', 'defer', 'ask', 'details']);
  // An approval: Approve or ask for changes (its own choices replace Approve), or Defer it.
  assert.deepEqual(cardActions({ ...can, status: 'blocked', needsApproval: true }), ['approve', 'changes', 'defer', 'ask', 'details']);
  assert.deepEqual(cardActions({ ...can, status: 'blocked', needsApproval: true, question: { kind: 'approval' } }), ['changes', 'defer', 'ask', 'details']);
  // Review: the first button matches what the agent handed over (no Approve when nothing asks for one).
  assert.deepEqual(cardActions({ ...can, status: 'review', reviewKind: 'check' }), ['review', 'reply', 'defer', 'ask', 'details']);
  assert.deepEqual(cardActions({ ...can, status: 'review', reviewKind: 'approval' }), ['approve', 'reply', 'defer', 'ask', 'details']);
  assert.deepEqual(cardActions({ ...can, status: 'review', reviewKind: 'request' }), ['reply', 'defer', 'ask', 'details']);
  // An update (nothing asked of you, agent stopped): Continue pushes it on to its next gate.
  assert.deepEqual(cardActions({ ...can, status: 'update' }), ['continue', 'reply', 'ask', 'details']);
  assert.deepEqual(cardActions({ canReply: false, status: 'update' }), ['ask', 'details']);
  // Anything else: reply.
  for (const status of ['working', 'idle', 'done']) assert.deepEqual(cardActions({ ...can, status }), ['reply', 'ask', 'details']);
  // A session the board can only read (not in tmux): nothing that would act.
  assert.deepEqual(cardActions({ canReply: false, status: 'blocked', ask: 'Which one?' }), ['ask', 'details']);
  // A menu the board can't answer: no Defer either (it has to be handled in the terminal).
  assert.ok(!cardActions({ ...can, status: 'blocked', question: { kind: 'menu', unsupported: 'an update menu' } }).includes('defer'));
  // A terminal menu where Esc would quit (folder trust): no Defer.
  assert.ok(!cardActions({ ...can, status: 'blocked', needsApproval: true, pendingPrompt: 'Trust?', menuEscSafe: false }).includes('defer'));
  // Already closed (e.g. deferred): no Defer.
  assert.ok(!cardActions({ ...can, status: 'blocked', closedAt: 5 }).includes('defer'));
});

test('boardLayout: Needs you on top, then folded projects with Home and No project last', async () => {
  const { boardLayout } = await import('../public/activity.js');
  const card = (id, project, status, lastActivity) => ({ id, project, status, lastActivity });
  const cards = [
    card('h1', 'Home', 'blocked', 50),
    card('m1', 'client-site', 'review', 40),
    card('m2', 'client-site', 'done', 90),
    card('a1', 'agenthub', 'idle', 30),
    card('l1', 'shop', 'working', 10),
    card('h2', 'Home', 'idle', 99),
    card('n1', 'No project', 'idle', 100),
  ];
  const { needs, projects } = boardLayout(cards);
  // Needs you: Blocked and Review from every project, in the order given (the server's order).
  assert.deepEqual(needs.map((c) => c.id), ['h1', 'm1']);
  // Projects: something running first, then most recent activity; Home, then No project, always last.
  assert.deepEqual(projects.map((p) => p.name), ['shop', 'client-site', 'agenthub', 'Home', 'No project']);
  // A project's own list leaves out what is already in Needs you, and says how many are above.
  const site = projects.find((p) => p.name === 'client-site');
  assert.deepEqual(site.cards.map((c) => c.id), ['m2']);
  assert.equal(site.above, 1);
  // Counts still describe the whole project.
  assert.deepEqual(site.all.map((c) => c.id), ['m1', 'm2']);
});

test('Needs you: the most recent first, Blocked and Review together (you work on several projects at once)', async () => {
  const { boardLayout, newestFirst } = await import('../public/activity.js');
  const cards = [
    { id: 'old-blocked', project: 'a', status: 'blocked', waitingSince: 10, lastActivity: 10 },
    { id: 'new-review', project: 'b', status: 'review', waitingSince: 90, lastActivity: 90 },
    { id: 'mid-blocked', project: 'c', status: 'blocked', waitingSince: 50, lastActivity: 50 },
    { id: 'no-wait', project: 'c', status: 'review', lastActivity: 70 },
  ];
  assert.deepEqual(boardLayout(cards).needs.map((c) => c.id), ['new-review', 'no-wait', 'mid-blocked', 'old-blocked']);
  assert.deepEqual(newestFirst(cards).map((c) => c.id), ['new-review', 'no-wait', 'mid-blocked', 'old-blocked']);
});

// Below Needs you: the work in progress you can't see at a glance (running, updates, recently quiet).
test('boardLayout: Recent is everything else that moved in the last 24 hours, newest first', async () => {
  const { boardLayout } = await import('../public/activity.js');
  const now = 100 * 3600000;
  const ago = (h) => now - h * 3600000;
  const card = (id, status, hoursAgo, extra = {}) => ({ id, project: 'P', status, lastActivity: ago(hoursAgo), ...extra });
  const cards = [
    card('needs', 'review', 1),
    card('running', 'working', 0.1),
    card('update', 'update', 2),
    card('idle-recent', 'idle', 5),
    card('done-recent', 'done', 20),
    card('old', 'idle', 30),
    card('closed', 'update', 1, { closedAt: 5 }),
    card('silent', 'idle', 0.5, { lastReply: '' }),
    card('update-newer-than-running', 'update', 0.05),
    card('automatic-run', 'done', 0.2, { automated: true }), // a one-off run Hermes or Kanban started: projects only
  ];
  for (const c of cards) if (c.lastReply === undefined) c.lastReply = 'Something.';
  const { needs, recent } = boardLayout(cards, now);
  assert.deepEqual(needs.map((c) => c.id), ['needs']);
  // Running first, then updates, then quiet ones; newest first within each; nothing-said-yet cards skipped.
  assert.deepEqual(recent.map((c) => c.id), ['running', 'update-newer-than-running', 'update', 'idle-recent', 'done-recent']);
});

test('the Continue message asks the agent to carry on to its next gate and say what it needs', async () => {
  const { CONTINUE_TEXT } = await import('../public/activity.js');
  assert.match(CONTINUE_TEXT, /keep going/i);
  assert.match(CONTINUE_TEXT, /next gate/i);
  assert.match(CONTINUE_TEXT, /what you need/i);
});
