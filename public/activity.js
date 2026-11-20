// Which agents are busy right now, for the glow on agent buttons. Pure, so the tests can import it too.

/** Agent keys with at least one open (not closed) card that is working, and that needs you (blocked or review). */
export function activity(cards) {
  const working = new Set();
  const needsYou = new Set();
  for (const c of cards || []) {
    if (c.closedAt) continue;
    if (c.status === 'working') working.add(c.harness);
    if (c.status === 'blocked' || c.status === 'review') needsYou.add(c.harness);
  }
  return { working, needsYou };
}

/** Whether your folded projects stay folded: not while Needs you, a status chip or a search is on, so nothing
 *  that needs you hides inside a folded project. */
export function foldApplies({ needs, q, status }) {
  return !needs && !q && status === 'all';
}

/** The time window to show: this device's own choice if it made one, else the board default, else 7 days. */
export function pickAge(deviceChoice, settings) {
  return deviceChoice || settings?.defaultAge || '7d';
}

/**
 * The buttons a card gets, in order. One way to answer per situation: a question gets Answer (its choices, or a
 * reply box), an approval gets Approve / Changes (or its own choices on the card), a report gets Approve / Reply,
 * anything else Reply. Blocked and Review cards also get Defer. A session the board can only read gets nothing that
 * would act. Ask and Details always. A helper's finished task gets "Send result" first (and no Continue: its job
 * is done).
 */
export function cardActions(c, now = Date.now()) {
  const tail = ['ask', 'details'];
  // A helper that finished a task for another chat leads with sending its result back (lib/delegate.js).
  const result = c.delegation?.role === 'to' && c.delegation.state === 'working' && c.delegation.result ? ['result'] : [];
  if (result.length) return [...result, ...cardActions({ ...c, delegation: null }).filter((k) => k !== 'continue')];
  if (!c.canReply) return tail;
  // A chat stopped on a usage limit: Continue now would fail, so it offers Continue at the reset (or Cancel once
  // planned). Its other buttons stay (lib/limits.js, lib/schedule.js).
  if (c.scheduled?.state === 'waiting') return ['unschedule', ...cardActions({ ...c, scheduled: null, limit: null }).filter((k) => k !== 'continue')];
  if (c.limit?.continueAt > now) return ['continue-at', ...cardActions({ ...c, limit: null }).filter((k) => k !== 'continue')];
  // Defer: the same rule as the server's canDefer (lib/defer.js); the page can't import server code.
  const defer = ['blocked', 'review'].includes(c.status) && !c.question?.unsupported && !c.closedAt
    && !(c.pendingPrompt && c.menuEscSafe === false) ? ['defer'] : [];
  if (c.needsApproval) return [...(['menu', 'approval', 'clarify'].includes(c.question?.kind) ? [] : ['approve']), 'changes', ...defer, ...tail];
  if (c.status === 'blocked') return ['answer', ...defer, ...tail];
  // Review: Approve only when a go-ahead is asked for; work to look at gets Review.
  if (c.status === 'review') {
    const first = c.reviewKind === 'check' ? ['review'] : c.reviewKind === 'approval' ? ['approve'] : [];
    return [...first, 'reply', ...defer, ...tail];
  }
  // An update: the agent stopped with a report and asks nothing; Continue pushes it on to its next gate.
  if (c.status === 'update') return ['continue', 'reply', ...tail];
  return ['reply', ...tail];
}

// What Defer and Resume send (the server sends its own copy, lib/defer.js; a test keeps the two identical).
export const DEFER_TEXT = "Let's hold off on this for now. Please pause here and don't take any further action until I come back to it.";
export const RESUME_TEXT = "Let's pick this back up where we left off.";
// Continue: an agent that stopped with a report and asks nothing is pushed on to its next gate.
export const CONTINUE_TEXT = "Keep going. If nothing needs me right now, carry on to your next gate (a decision, an approval, or something only I can do), then stop and tell me exactly what you need.";

const isNeedsYou = (c) => (c.status === 'blocked' || c.status === 'review') && !c.closedAt;
const LAST = ['Home', 'No project'];

/**
 * The main view: `needs` = every Blocked / Review card, most recent first; `projects`
 * = every project as { name, all, cards, above }: `all` its cards (for the counts), `cards` the ones not already in
 * Needs you, `above` how many of its cards are up there. Order: something running first, then most recent activity;
 * Home and No project last.
 */
/** Most recent first (you work on several projects at once: what you touched last goes on top). */
export function newestFirst(cards) {
  const when = (c) => c.lastActivity || c.waitingSince || 0;
  return [...cards].sort((a, b) => when(b) - when(a));
}

// Recent: what else moved in the last day, so work in progress shows without opening projects.
const RECENT_MS = 24 * 3600 * 1000;

export function boardLayout(cards, now = Date.now()) {
  const needs = newestFirst(cards.filter(isNeedsYou));
  // Running first, then updates, then the quiet ones; newest first within each. A card with nothing said yet is skipped.
  const recentRank = (c) => (c.status === 'working' ? 0 : c.status === 'update' ? 1 : 2);
  // Automatic runs (Kanban, `codex exec`, `claude -p`, subagents) stay in their projects only.
  const recent = newestFirst(cards.filter((c) => !isNeedsYou(c) && !c.closedAt && !c.automated && now - (c.lastActivity || 0) < RECENT_MS
    && (c.status === 'working' || (c.lastReply || c.replyEnd || '').trim())))
    .sort((a, b) => recentRank(a) - recentRank(b));
  const groups = new Map();
  for (const c of cards) {
    if (!groups.has(c.project)) groups.set(c.project, []);
    groups.get(c.project).push(c);
  }
  const rank = (name, list) => [LAST.indexOf(name), list.some((c) => c.status === 'working') ? 0 : 1,
    -Math.max(...list.map((c) => c.lastActivity || 0))];
  const projects = [...groups.entries()]
    .sort(([an, al], [bn, bl]) => {
      const a = rank(an, al); const b = rank(bn, bl);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
      return an.localeCompare(bn);
    })
    .map(([name, all]) => ({ name, all, cards: all.filter((c) => !isNeedsYou(c)), above: all.filter(isNeedsYou).length }));
  return { needs, recent, projects };
}
