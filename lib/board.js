// Board store: polls every lane in the background and keeps the latest snapshot.
import path from 'node:path';
import { config } from './config.js';
import { projectLabels, projectFolders } from './projects.js';
import { decorate } from './handoff.js';
import { createDelegations } from './delegate.js';
import { createSchedule } from './schedule.js';
import { limitOf, RESET_MARGIN_MS } from './limits.js';
import { claudeUsage, codexUsage } from './usage.js';
import { createDemoLane, demoUsage, onDemoChange } from './demo.js';
import { splitWaiting, sortCards } from './status.js';
import { apply as applyClosed } from './closed.js';
import { cached as cachedPreview, findLinks } from './preview.js';
import { askContext, decisionsOf, clipTail } from './util.js';
import { AGENT_NAMES } from './names.js';
import * as hermes from './lanes/hermes.js';
import * as openclaw from './lanes/openclaw.js';
import { claudeLanes } from './lanes/claude.js';
import * as codex from './lanes/codex.js';

/**
 * The lanes this install reads, in board order: Hermes, OpenClaw, one per Claude Code account, Codex (an agent that
 * is switched off in the setup is skipped). `kind` tells the page what a lane is ('claude' for every Claude account);
 * `accent` and `tag` are a Claude account's colour preset and card label from the setup.
 */
function buildLanes() {
  if (config.demo) return demoLanes();
  const out = {};
  if (config.enabled.hermes) out.hermes = { name: AGENT_NAMES.hermes, kind: 'hermes', mod: hermes };
  if (config.enabled.openclaw) out.openclaw = { name: AGENT_NAMES.openclaw, kind: 'openclaw', mod: openclaw };
  for (const { account, mod } of claudeLanes()) {
    out[account.id] = { name: AGENT_NAMES[account.id], kind: 'claude', accent: account.accent, tag: account.tag, command: account.bin, mod };
  }
  if (config.enabled.codex) out.codex = { name: AGENT_NAMES.codex, kind: 'codex', mod: codex };
  return out;
}
/** Demo mode: the same lanes, each a made-up agent (lib/demo.js). */
function demoLanes() {
  const out = { hermes: { name: AGENT_NAMES.hermes, kind: 'hermes' }, openclaw: { name: AGENT_NAMES.openclaw, kind: 'openclaw' } };
  for (const a of config.claudeAccounts) out[a.id] = { name: AGENT_NAMES[a.id], kind: 'claude', accent: a.accent, tag: a.tag, command: 'claude' };
  out.codex = { name: AGENT_NAMES.codex, kind: 'codex' };
  for (const [key, lane] of Object.entries(out)) lane.mod = createDemoLane(key, lane.name);
  onDemoChange(() => refresh().catch((e) => console.error('[board] refresh failed', e)));
  return out;
}
export const LANES = buildLanes();

/** Tasks you had another agent do for a chat (lib/delegate.js). */
export const delegations = createDelegations(path.join(config.dataDir, 'delegations.json'));

/** Continues the board sends later, e.g. after a usage limit resets (lib/schedule.js). */
export const schedule = createSchedule(path.join(config.dataDir, 'scheduled.json'));

// Lanes with a gateway service the board can restart from the agent's long-press menu.
export const RESTARTABLE = new Set(['hermes', 'openclaw']);
// When "End chat" can reach a session (each lane's endSession does the agent's own close).
const CAN_END = {
  hermes: (c) => c.canReply && c.status !== 'done',
  openclaw: (c) => !String(c.ref).includes(':subagent:') && c.status !== 'done',
  claude: (c) => !!c.paneId, // every Claude Code account
  codex: (c) => !!c.paneId,
};

let snapshot = { generatedAt: 0, lanes: {}, cards: [], projects: projectLabels(), folders: [] };
let refreshing = null;
let polling = false;
let pollTimer = null;

/** What the page needs to know about a lane besides its cards (name, kind, a Claude account's accent, tag, command). */
function laneFacts(key) {
  const { name, kind, accent = '', tag = '', command = '' } = LANES[key];
  return { name, kind, accent, tag, command: command ? command.split('/').pop() : '' };
}

async function collectLane(key) {
  const started = Date.now();
  try {
    const res = await LANES[key].mod.collect();
    // health / why: the agent's light (lib/health.js); a lane that doesn't say is green only when it connected.
    return { ...laneFacts(key), connected: res.connected, reason: res.reason, ms: Date.now() - started, cards: res.cards,
      health: res.health || (res.connected ? 'ok' : 'down'), why: res.why || res.reason };
  } catch (e) {
    return { ...laneFacts(key), connected: false, reason: `Unexpected error: ${e.message}`, ms: Date.now() - started, cards: [],
      health: 'down', why: `The board hit an error reading ${LANES[key].name}: ${e.message}` };
  }
}

/** Every project label to show: the known projects in order, then any other a card belongs to, "No project" last. */
function boardProjects(cards) {
  const known = projectLabels();
  const extra = [...new Set(cards.map((c) => c.project))].filter((l) => l && !known.includes(l)).sort((a, b) => a.localeCompare(b));
  return [...known.slice(0, -1), ...extra, known[known.length - 1]];
}

let again = null;
export async function refresh() {
  // A read already running may have started before what the caller just did (an approval, a reply): queue one more
  // read after it, shared by everyone who asks meanwhile, so the board never shows the old state as the new one.
  if (refreshing) {
    again ||= refreshing.catch(() => {}).then(() => { again = null; return refresh(); });
    return again;
  }
  refreshing = (async () => {
    const keys = Object.keys(LANES);
    const results = await Promise.all(keys.map(collectLane));
    const lanes = {};
    const cards = [];
    keys.forEach((k, i) => {
      const { cards: laneCards, ...info } = results[i];
      lanes[k] = { ...info, count: laneCards.length, checkedAt: Date.now(), canRestart: RESTARTABLE.has(k), usage: usage[k] || null };
      cards.push(...laneCards);
    });
    // Before handoff marks switch replies off: a handed-off original can still be ended.
    for (const c of cards) {
      c.canEnd = !!CAN_END[LANES[c.harness]?.kind]?.(c);
      c.askContext = askContext(c.lastReply, c.ask);
      // A list of decisions ("1. Commit? 2. Delete the folder?") is answered one at a time from Answer.
      c.decisions = c.question ? [] : decisionsOf(c.ask);
    }
    await decorate(cards);
    splitWaiting(cards);
    // After the split: a helper's result is ready only once it stopped and isn't blocked on an approval.
    await delegations.decorate(cards, AGENT_NAMES);
    // A chat that stopped on a usage limit: when it resets, and when Continue would go (lib/limits.js).
    for (const c of cards) {
      if (!['blocked', 'review', 'update'].includes(c.status)) continue;
      const limit = limitOf(c.lastReply, c.lastActivity || Date.now());
      if (limit) c.limit = { ...limit, continueAt: limit.resetsAt ? limit.resetsAt + RESET_MARGIN_MS : 0 };
    }
    await schedule.decorate(cards);
    // Only cards that need you or moved in the last day (the Active section) carry the long reply and the turns
    // before it (the page checks for changes every 5 s, and a phone shouldn't download whole conversations for old chats).
    const recentSince = Date.now() - 24 * 3600 * 1000;
    for (const c of cards) {
      if (c.status === 'blocked' || c.status === 'review' || (c.lastActivity || 0) >= recentSince) {
        // The page to review is often linked a few messages back ("Preview: http://localhost:4321"), not in the
        // last reply: look there too, newest first, so Review can show it.
        if (!c.links?.length) c.links = findLinks(...(c.earlier || []).filter((t) => t.role === 'agent').map((t) => t.text).reverse());
        continue;
      }
      c.earlier = [];
      c.lastReply = clipTail(c.lastReply, 600);
    }
    applyClosed(cards);
    // Screenshots already taken for links on a card (so the card can show the thumbnail).
    for (const c of cards) {
      const previews = {};
      for (const link of c.links || []) {
        const meta = await cachedPreview(link);
        if (meta) previews[link] = { key: meta.key, takenAt: meta.takenAt };
      }
      c.previews = previews;
    }
    snapshot = { generatedAt: Date.now(), lanes, cards: sortCards(cards), projects: boardProjects(cards), folders: projectFolders() };
    return snapshot;
  })();
  try { return await refreshing; } finally { refreshing = null; scheduleNext(); }
}

/** The next background read comes a full wait after the latest read, whatever started that one. */
function scheduleNext() {
  if (!polling) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => refresh().catch((e) => console.error('[board] refresh failed', e)), config.refreshMs);
}

/** Read every agent now (a page that just opened: pull to refresh), unless the board is under `minAgeMs` old. */
export async function readNow(minAgeMs = 5000) {
  if (refreshing || Date.now() - snapshot.generatedAt >= minAgeMs) return refresh();
  return snapshot;
}

export function getSnapshot() { return snapshot; }

/** True when a page that last got `since` ("<generatedAt>:<age>") already has this board for `age`. */
export function pageIsCurrent(snap, since, age) {
  return !!snap.generatedAt && since === `${snap.generatedAt}:${age}`;
}

export function findCard(id) { return snapshot.cards.find((c) => c.id === id); }

// ---------- plan usage (lib/usage.js): the draining ring on Claude and Codex buttons ----------
// Kept apart from the 30 s board read: Claude's numbers come from Anthropic (asked every 5 minutes per account),
// Codex's from its own logs (every minute). Each refresh hands the page the latest reading.
const usage = {}; // lane key -> { windows, why, checkedAt }
const CLAUDE_USAGE_MS = 5 * 60 * 1000;
const CODEX_USAGE_MS = 60 * 1000;
async function readClaudeUsage() {
  for (const a of config.claudeAccounts) {
    if (LANES[a.id] && a.dirs[0]) usage[a.id] = { ...(await claudeUsage(a.dirs[0])), checkedAt: Date.now() };
  }
}
async function readCodexUsage() {
  if (LANES.codex) usage.codex = { ...(await codexUsage(config.codex.sessionsDir)), checkedAt: Date.now() };
}
function startUsage() {
  if (config.demo) { Object.assign(usage, Object.fromEntries(Object.entries(demoUsage()).map(([k, u]) => [k, { ...u, checkedAt: Date.now() }]))); return; }
  const loop = (read, ms) => { const go = () => read().catch((e) => console.error('[usage] failed', e.message)).finally(() => setTimeout(go, ms)); go(); };
  loop(readClaudeUsage, CLAUDE_USAGE_MS);
  loop(readCodexUsage, CODEX_USAGE_MS);
}

export function startPolling() {
  polling = true;
  if (config.usage.rings) startUsage(); // switched off in Settings: no readings, no rings
  refresh().catch((e) => console.error('[board] refresh failed', e)); // each read schedules the next (scheduleNext)
}

/** Public view of a card: strip local-only fields. */
export function publicCard(c) {
  const { file, ...rest } = c;
  return rest;
}
