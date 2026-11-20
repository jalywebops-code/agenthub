// "Close" on the board: hide a card you are done with, without touching the agent.
// A closed card comes back by itself when its chat has new activity, so nothing slips past you.
// A *deferred* card (Defer) instead stays closed through the agent's own replies and comes back only when your own
// last message in that chat changes, or you tap Resume.
// Stored in .data/closed.json as { cardId: closedAt } or { cardId: { at, deferred: true, prompts } }.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { writeFileAtomicSync } from './atomic.js';

const FILE = path.join(config.dataDir, 'closed.json');
// Activity within this long after closing doesn't count as "new" (e.g. the agent's own write as it ends).
const GRACE_MS = 2 * 60 * 1000;

// Read on first use (not at import), so importing this module for its pure helpers touches no file.
let closed = null;
function store() {
  if (!closed) {
    try { closed = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { closed = {}; }
  }
  return closed;
}

const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * Whether a closed card stays closed. A plain close (a number) ends when the chat has activity after the grace
 * period. A deferred close ends only when your last message is no longer one of the recorded ones (your message
 * before Defer, or the Defer message itself), so the agent's own "OK, pausing" doesn't bring it back.
 */
export function keepClosed(entry, card, graceMs) {
  if (typeof entry === 'number') return (card.lastActivity || 0) <= entry + graceMs;
  if (!entry?.deferred) return false;
  const last = norm(card.lastPrompt);
  // A lane that couldn't read the chat this time reports no message: unknown is not a change.
  if (!last) return true;
  return (entry.prompts || []).some((p) => norm(p) && last === norm(p));
}

function save() {
  writeFileAtomicSync(FILE, JSON.stringify(closed, null, 2));
}

export function close(id) {
  store()[id] = Date.now();
  save();
}

/** Close a card you deferred; `prompts`: your last message before Defer and the Defer message. */
export function defer(id, prompts) {
  store()[id] = { at: Date.now(), deferred: true, prompts: prompts.filter(Boolean).map(String) };
  save();
}

export function reopen(id) {
  if (!(id in store())) return false;
  delete closed[id];
  save();
  return true;
}

/** Mark closed cards (closedAt); reopen any whose chat has moved on since it was closed. */
export function apply(cards) {
  let changed = false;
  store();
  for (const c of cards) {
    const entry = closed[c.id];
    if (!entry) continue;
    if (!keepClosed(entry, c, GRACE_MS)) {
      delete closed[c.id];
      changed = true;
      continue;
    }
    c.closedAt = typeof entry === 'number' ? entry : entry.at;
    if (entry.deferred) c.deferred = true;
  }
  if (changed) save();
  return cards;
}
