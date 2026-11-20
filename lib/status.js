// Board statuses (Hermes kanban vocabulary where it fits live chats). Lanes report "waiting" when the agent spoke
// last; the board splits that into:
//   blocked: the agent can't continue until you act (an approval, a question with options, or a reply that asks)
//   review:  the agent reported back and hands you something: a request, a choice waiting on you, work to check
//   update:  a plain status report with nothing for you to do; not in Needs you
import { asksOwner, reviewKind } from './util.js';

// plus working ("Running" on the page), idle and done.

export const STATUS_RANK = { blocked: 0, review: 1, update: 2, working: 3, idle: 4, done: 5 };

/** Turn every "waiting" card into "blocked" or "review" (in place). */
export function splitWaiting(cards) {
  for (const c of cards) {
    if (c.status !== 'waiting') continue;
    c.status = c.needsApproval || c.question || c.ask ? 'blocked' : asksOwner(c.lastReply) ? 'review' : 'update';
    // What a Review hands you decides its first button: Review (work to look at), Approve, or Reply.
    if (c.status === 'review') c.reviewKind = reviewKind(c.lastReply);
  }
  return cards;
}

/** Blocked first (approvals, then longest wait), then review (longest wait), then the rest by latest activity. */
export function sortCards(cards) {
  return cards.sort((a, b) => {
    const r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (r) return r;
    if (a.status === 'blocked' && !!a.needsApproval !== !!b.needsApproval) return a.needsApproval ? -1 : 1;
    if (a.status === 'blocked' || a.status === 'review' || a.status === 'update') return (a.waitingSince || 0) - (b.waitingSince || 0);
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
}

const AGE_DAYS = { '7d': 7, '30d': 30 };

/**
 * The cards inside your chosen time window ('today' since local midnight, '7d', '30d', 'all'; unknown → '7d').
 * Blocked, Review, Update and Running cards always show, whatever their age.
 */
export function cardsForAge(cards, age, now = Date.now()) {
  if (age === 'all') return cards;
  let start;
  if (age === 'today') {
    const d = new Date(now);
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  } else {
    start = now - (AGE_DAYS[age] || 7) * 86400000;
  }
  // Blocked, Review and Update (never older than 24 h) and Running always show.
  return cards.filter((c) => ['blocked', 'review', 'update', 'working'].includes(c.status) || (c.lastActivity || 0) >= start);
}
