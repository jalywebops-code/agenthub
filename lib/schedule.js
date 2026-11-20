// Continue later: a Continue that the board sends at a set time, e.g. two minutes after a usage limit
// resets. The server sends it (the page can be closed); the plan is kept in .data/scheduled.json so a board restart
// keeps it, and a Mac that slept through the time sends it when it wakes.
//
// Safety: at the time, the Continue goes only if the chat is still where you left it. If the chat moved on since
// (you answered it yourself, or the agent did something), it is not sent and the card says why.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './atomic.js';

// The same words as the page's Continue (public/activity.js CONTINUE_TEXT; a test keeps the two identical).
export const CONTINUE_MESSAGE = "Keep going. If nothing needs me right now, carry on to your next gate (a decision, an approval, or something only I can do), then stop and tell me exactly what you need.";

/** How far a chat may have moved (ms of new activity) and still count as "where you left it". */
const MOVED_MS = 60 * 1000;
/** A sent or skipped plan stays on its card this long, so you see what happened. */
const SHOW_DONE_MS = 10 * 60 * 1000;

/** Why a planned Continue must not go now ('' = send it). `card` is the chat as the board sees it now. */
export function cannotSend(plan, card) {
  if (!card) return 'The chat is not on the board any more.';
  if (!card.canReply) return card.replyBlockedReason || 'The board cannot type into that chat any more.';
  if (card.status === 'working') return 'The agent was already working again.';
  if (card.pendingPrompt) return 'The chat is showing an approval; answer that first.';
  if ((card.lastActivity || 0) > (plan.cardActivity || 0) + MOVED_MS) return 'The chat moved on since you planned it.';
  return '';
}

export function createSchedule(file) {
  let plans = [];
  let loadedMtime = 0;

  async function reload() {
    const st = await fs.stat(file).catch(() => null);
    if (!st || st.mtimeMs === loadedMtime) return;
    try { plans = JSON.parse(await fs.readFile(file, 'utf8')); loadedMtime = st.mtimeMs; } catch { /* mid-write; next time */ }
  }

  async function save() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(plans, null, 2));
    loadedMtime = (await fs.stat(file)).mtimeMs;
  }

  /** Plan a Continue for `card` at `at` (ms). Replaces any plan already waiting for that chat. */
  async function plan(card, at, why = '') {
    await reload();
    plans = plans.filter((p) => !(p.cardId === card.id && p.state === 'waiting'));
    const p = { id: crypto.randomUUID(), cardId: card.id, harness: card.harness, title: card.title, at, why, state: 'waiting',
      createdAt: Date.now(), cardActivity: card.lastActivity || 0 };
    plans.push(p);
    await save();
    return p;
  }

  /** Cancel the plan waiting for this chat. True when there was one. */
  async function cancel(cardId) {
    await reload();
    const p = plans.find((x) => x.cardId === cardId && x.state === 'waiting');
    if (!p) return false;
    plans = plans.filter((x) => x !== p);
    await save();
    return true;
  }

  /** True when a plan's time has come (the board reads the agents fresh before sending). */
  async function anyDue(now = Date.now()) {
    await reload();
    return plans.some((p) => p.state === 'waiting' && p.at <= now);
  }

  /**
   * Send every plan whose time has come. `findCard(id)` gives the chat as the board sees it now; `send(card)` sends
   * the Continue (and throws if it can't); `log(plan, card, ok, why)` records the outcome.
   */
  async function runDue({ now = Date.now(), findCard, send, log = async () => {} }) {
    await reload();
    const due = plans.filter((p) => p.state === 'waiting' && p.at <= now);
    for (const p of due) {
      const card = findCard(p.cardId);
      const why = cannotSend(p, card);
      if (why) {
        Object.assign(p, { state: 'skipped', doneAt: now, reason: why });
      } else {
        try {
          await send(card);
          Object.assign(p, { state: 'sent', doneAt: now });
        } catch (e) {
          Object.assign(p, { state: 'failed', doneAt: now, reason: e.message });
        }
      }
      await log(p, card, p.state === 'sent', p.reason || '');
    }
    // Forget finished plans once they have been shown for a while.
    const before = plans.length;
    plans = plans.filter((p) => p.state === 'waiting' || now - (p.doneAt || 0) < SHOW_DONE_MS);
    if (due.length || plans.length !== before) await save();
    return due;
  }

  /** Mark each card with its plan: waiting (when), or just sent / skipped / failed (and why). */
  async function decorate(cards) {
    await reload();
    for (const p of plans) {
      const c = cards.find((x) => x.id === p.cardId);
      if (c) c.scheduled = { id: p.id, at: p.at, state: p.state, why: p.why, reason: p.reason || '', doneAt: p.doneAt || 0 };
    }
    return cards;
  }

  return { plan, cancel, anyDue, runDue, decorate };
}
