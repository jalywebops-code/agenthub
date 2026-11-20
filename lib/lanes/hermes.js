// Hermes lane: reads real sessions from the Hermes dashboard (default 127.0.0.1:9119).
// The dashboard mints a session token per start and injects it into its HTML as
// window.__HERMES_SESSION_TOKEN__; API calls send it as X-Hermes-Session-Token.
//
// Replies and approvals go through lib/hermes_bridge.py, which attaches to the running Hermes
// gateway (the same backend the desktop app uses) with Hermes's own client. Because it is the
// same process that holds the desktop's open chats, a reply joins the live session instead of
// starting a second writer.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { projectFor } from '../projects.js';
import { findLinks } from '../preview.js';
import { questionFromReply } from '../choices.js';
import { classify, clip, clipTail, replyEnd, askOf, textOf, run, mapLimit, isSyntheticPrompt, earlierTurns, REPLY_MAX } from '../util.js';
import { gatewayHealth } from '../health.js';

const AUTOMATED_SOURCES = new Set(['kanban', 'oneshot', 'cron', 'acp', 'batch']);
// Chats that live in Hermes itself. A Slack or Telegram chat answered from here would reply in the
// Hermes app, not in Slack/Telegram, so those stay read-only.
const REPLY_SOURCES = new Set(['local', 'desktop', 'tui', 'cli']);

let python = null;

/** Hermes's Python, read from its own launcher so a Hermes update that moves it is followed. */
async function hermesPython() {
  if (python) return python;
  const text = await fsp.readFile(config.hermes.launcher, 'utf8');
  const m = text.match(/^exec (\S+python3?)\s+-I\b/m);
  if (!m) throw new Error(`could not find Hermes's Python in ${config.hermes.launcher}`);
  python = m[1];
  return python;
}

async function bridge(command, params, timeoutMs) {
  let out;
  try {
    out = await run(await hermesPython(), ['-I', config.hermes.bridge, command],
      { timeoutMs, input: params ? JSON.stringify(params) : '' });
  } catch (e) {
    python = null; // re-read the launcher next time
    throw e;
  }
  const line = out.trim().split('\n').pop() || '';
  let res;
  try { res = JSON.parse(line); } catch { throw new Error(`unexpected answer from the Hermes bridge: ${clip(line, 200)}`); }
  if (!res.ok) throw new Error(res.error || 'Hermes bridge failed');
  return res;
}

function blockedReason(source, live, liveError) {
  if (AUTOMATED_SOURCES.has(source)) return 'This is an automated Hermes run (Kanban, one-shot or scheduled). There is nobody to reply to.';
  if (!REPLY_SOURCES.has(source)) {
    const app = source ? source[0].toUpperCase() + source.slice(1) : 'another app';
    return `This Hermes chat came in through ${app}. Reply there, so the answer goes back to the same place.`;
  }
  if (!live) return `Replies to Hermes are unavailable right now: ${liveError}`;
  return '';
}

let token = null;
const msgCache = new Map(); // session id -> { stamp, summary }

async function fetchToken() {
  const res = await fetch(`${config.hermes.baseUrl}/`, { signal: AbortSignal.timeout(5000) });
  const html = await res.text();
  const m = html.match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('dashboard page did not include a session token');
  token = m[1];
}

async function api(pathname) {
  if (!token) await fetchToken();
  const go = () => fetch(`${config.hermes.baseUrl}${pathname}`, {
    headers: { 'X-Hermes-Session-Token': token },
    signal: AbortSignal.timeout(10000),
  });
  let res = await go();
  if (res.status === 401 || res.status === 403) { // token rotates on every dashboard restart
    await fetchToken();
    res = await go();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${pathname}`);
  return res.json();
}

function toMessages(raw) {
  return raw
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role === 'user' ? 'you' : 'agent', text: textOf(m.content), ts: m.timestamp ? m.timestamp * 1000 : null, toolOnly: m.role === 'assistant' && !textOf(m.content).trim() }));
}

async function summarize(session) {
  const stamp = session.last_active;
  const hit = msgCache.get(session.id);
  if (hit && hit.stamp === stamp) return hit.summary;
  const data = await api(`/api/sessions/${encodeURIComponent(session.id)}/messages?order=latest&limit=120`);
  const raw = data.messages || [];
  const msgs = toMessages(raw);
  const lastPrompt = [...msgs].reverse().find((m) => m.role === 'you' && !isSyntheticPrompt(m.text));
  const lastReply = [...msgs].reverse().find((m) => m.role === 'agent' && !m.toolOnly);
  const lastRaw = raw[raw.length - 1];
  const agentSpokeLast = !!lastRaw && lastRaw.role === 'assistant' && !(lastRaw.tool_calls && lastRaw.tool_calls.length);
  const summary = { lastPrompt: lastPrompt?.text || '', lastReply: lastReply?.text || '', agentSpokeLast,
    links: findLinks(lastReply?.text, lastPrompt?.text), earlier: earlierTurns(msgs) };
  msgCache.set(session.id, { stamp, summary });
  return summary;
}

export async function collect() {
  let list;
  const cutoff = Date.now() - config.lookbackMs;
  try {
    // The dashboard returns at most 100 per page: page through, newest first, until past the lookback or the cap.
    list = { sessions: [], total: 0 };
    for (let offset = 0; offset < config.maxPerLane; offset += 100) {
      const page = await api(`/api/sessions?limit=100&offset=${offset}&order=recent&exclude_sources=cron&min_messages=1`);
      list.total = page.total ?? list.total;
      const got = page.sessions || [];
      list.sessions.push(...got);
      if (got.length < 100 || got[got.length - 1].last_active * 1000 < cutoff) break;
    }
  } catch (e) {
    token = null;
    const reason = /ECONNREFUSED|fetch failed/.test(String(e.cause?.code || e.message))
      ? 'Hermes dashboard is not running on 127.0.0.1:9119. Start it with: hermes dashboard --no-open --skip-build'
      : `Hermes dashboard error: ${e.message}`;
    return { connected: false, reason, cards: [], health: 'down', why: `The board can't reach Hermes: ${reason}` };
  }
  const sessions = (list.sessions || [])
    .filter((s) => s.last_active * 1000 >= cutoff && s.id !== sideKey)
    .slice(0, config.maxPerLane);

  // Live sessions and pending approvals from the gateway. If it cannot be reached, cards stay read-only.
  let live = null;
  let liveError = '';
  try { live = await bridge('live', null, 15000); } catch (e) { liveError = e.message; }
  const liveByKey = new Map((live?.sessions || []).map((r) => [r.session_key, r]));

  const cards = await mapLimit(sessions, 4, async (s) => {
    let sum = { lastPrompt: '', lastReply: '', agentSpokeLast: false, links: [] };
    let note = '';
    try { sum = await summarize(s); } catch (e) { note = `Could not read messages: ${e.message}`; }
    const lastActivity = Math.round(s.last_active * 1000);
    const recent = Date.now() - lastActivity < config.workingWindowMs;
    // Automation sources (kanban workers, one-shot runs, ACP calls) never wait on a human.
    const automated = AUTOMATED_SOURCES.has(s.source);
    // Only the oldest pending approval is shown; it is the one Hermes is blocked on.
    const approval = liveByKey.get(s.id)?.approvals?.[0];
    const needsApproval = !!approval;
    // A multiple-choice question from Hermes's clarify tool: Hermes is blocked on your answer.
    const clarify = approval ? null : liveByKey.get(s.id)?.clarify?.[0];
    const { status, waitingSince } = classify({
      running: !needsApproval && !clarify && !s.ended_at && recent && !sum.agentSpokeLast,
      ended: !needsApproval && !clarify && (!!s.ended_at || (automated && sum.agentSpokeLast)),
      agentSpokeLast: sum.agentSpokeLast || needsApproval || !!clarify,
      lastActivity,
    }, config);
    const replyBlockedReason = blockedReason(s.source, live, liveError);
    return {
      id: `hermes:${s.id}`,
      harness: 'hermes',
      ref: s.id,
      title: s.title || clip(s.preview, 80) || s.id,
      cwd: s.cwd || '',
      project: projectFor(s.cwd),
      status,
      waitingSince,
      lastActivity,
      lastPrompt: clip(sum.lastPrompt),
      lastReply: clipTail(sum.lastReply, REPLY_MAX),
      earlier: sum.earlier || [],
      replyEnd: replyEnd(sum.lastReply),
      ask: askOf(sum.lastReply),
      links: sum.links,
      source: s.source,
      automated, // Kanban, one-shot, cron, batch, ACP: a run, not a chat (kept out of Recent)
      model: s.model,
      needsApproval,
      pendingPrompt: approval?.text || '',
      question: approval ? approvalQuestion(approval)
        : (clarify ? clarifyQuestion(clarify)
          : (!sum.agentSpokeLast || status === 'working' ? null : questionFromReply(sum.lastReply, replyEnd(sum.lastReply)))),
      // A Hermes approval is a structured request whose full text is on the card (not a terminal menu).
      approvalStyle: 'request',
      hermesProfile: s.is_default_profile === false ? (s.profile_name || s.profile || '') : '',
      canReply: !replyBlockedReason,
      replyBlockedReason,
      note,
    };
  });
  const replies = live ? 'replies live through the Hermes gateway' : `replies unavailable: ${liveError}`;
  // The light follows the gateway (Hermes itself), not the dashboard: the dashboard stays up when Hermes is closed.
  return { connected: true, reason: `Live: ${list.total} sessions in Hermes, ${cards.length} active in the last ${Math.round(config.lookbackMs / 86400000)} days; ${replies}`, cards,
    ...gatewayHealth('Hermes', live ? '' : liveError || 'no answer from the Hermes gateway') };
}

/**
 * Act on a Hermes session. Only called after the user confirms in the UI.
 * An approval is answered only if Hermes's oldest pending request is still exactly the text the user saw.
 * Messages are queued: a busy session finishes its current turn first and is never interrupted.
 */
export async function send(card, { kind, message, images = [], expectPrompt, expectText }) {
  if (!card.canReply) throw new Error(card.replyBlockedReason);
  const target = { key: card.ref, ...(card.hermesProfile ? { profile: card.hermesProfile } : {}) };
  // Images: Hermes attaches the files itself (its own image.attach), so only their paths go to the bridge.
  const files = images.length ? { images: images.map((i) => i.path) } : {};
  let res;
  if (kind === 'reply' && !expectPrompt && !images.length && await isCommand(message)) {
    // One of Hermes's own slash commands: run it as Hermes would, and hand back what it printed.
    res = await bridge('slash', { ...target, text: message }, 90000);
    msgCache.delete(card.ref);
    return { output: commandOutput(res.result) };
  }
  if (expectPrompt && kind === 'approve') res = await bridge('approve', { ...target, expect: expectText }, 45000);
  else if (expectPrompt && kind === 'changes') res = await bridge('changes', { ...target, expect: expectText, text: message, ...files }, 90000);
  else res = await bridge('reply', { ...target, text: message, ...files }, 90000);
  msgCache.delete(card.ref);
  return res;
}

const APPROVAL_LABELS = { once: 'Allow once', session: 'Allow for this session', always: 'Always allow', deny: 'Deny' };

/** Hermes's own approval choices (once / session / always / deny) as a card question; null if Hermes sent none. */
function approvalQuestion(approval) {
  const values = (approval.choices || []).filter((c) => typeof c === 'string');
  if (!values.length) return null;
  return { kind: 'approval', text: approval.text, options: values.map((v) => APPROVAL_LABELS[v] || v), values,
    multi: false, freeText: -1, unsupported: '', expect: approval.text };
}

/** The next unanswered question from Hermes's clarify tool as a card question. */
function clarifyQuestion(q) {
  return { kind: 'clarify', text: q.question, options: q.choices, multi: !!q.multi_select, freeText: -1, unsupported: '',
    expect: q.question, clarifyId: q.id, qid: q.qid };
}

/** Answer the card's question in Hermes: an approval choice, or a clarify answer. Only after you confirm. */
export async function choose(card, { pick }) {
  if (!card.canReply) throw new Error(card.replyBlockedReason);
  const q = card.question;
  const target = { key: card.ref, ...(card.hermesProfile ? { profile: card.hermesProfile } : {}) };
  let res;
  if (q.kind === 'approval') {
    res = await bridge('approve', { ...target, expect: q.expect, choice: q.values[pick] }, 45000);
  } else if (q.kind === 'clarify') {
    const answer = q.multi ? pick.map((i) => q.options[i]) : q.options[pick];
    res = await bridge('clarify', { ...target, id: q.clarifyId, qid: q.qid, expect: q.expect, answer }, 45000);
  } else {
    throw new Error('This question cannot be answered here.');
  }
  msgCache.delete(card.ref);
  return res;
}

/**
 * Defer. A clarify question: the message is the answer (Hermes's question UI always takes a typed "Other" answer).
 * An approval: deny it, then send the message. Otherwise: a normal reply.
 */
export async function defer(card, message) {
  if (!card.canReply) throw new Error(card.replyBlockedReason);
  const target = { key: card.ref, ...(card.hermesProfile ? { profile: card.hermesProfile } : {}) };
  const q = card.question;
  let res;
  if (q?.kind === 'clarify') res = await bridge('clarify', { ...target, id: q.clarifyId, qid: q.qid, expect: q.expect, text: message }, 45000);
  else if (card.needsApproval && card.pendingPrompt) res = await bridge('changes', { ...target, expect: card.pendingPrompt, text: message }, 90000);
  else res = await bridge('reply', { ...target, text: message }, 90000);
  msgCache.delete(card.ref);
  return res;
}

export async function messages(card, n = 14) {
  const data = await api(`/api/sessions/${encodeURIComponent(card.ref)}/messages?order=latest&limit=60`);
  return toMessages(data.messages || []).filter((m) => !m.toolOnly && m.text.trim()).slice(-n);
}

// ---------- slash commands ----------
// Commands that quit, update, log in, top up or only change Hermes's own terminal look.
const HIDDEN_COMMANDS = new Set(['/quit', '/update', '/topup', '/login', '/subscription', '/redraw', '/mouse', '/density',
  '/skin', '/paste', '/image', '/copy', '/palette', '/pet', '/hatch', '/battery', '/statusbar', '/footer', '/indicator',
  '/timestamps', '/clear', '/voice', '/wake', '/logs', '/debug']);
let catalog = { at: 0, list: [] };

/** Hermes's own slash commands (live from the gateway, cached for 10 minutes). */
export async function commands() {
  if (Date.now() - catalog.at < 600000 && catalog.list.length) return catalog.list;
  const res = await bridge('commands', null, 20000);
  const pairs = res.catalog?.pairs || [];
  const list = pairs.filter(([name]) => !HIDDEN_COMMANDS.has(name)).map(([name, description]) => ({ name, description }));
  catalog = { at: Date.now(), list };
  return list;
}

async function isCommand(text) {
  const m = /^\/([\w:-]+)(\s|$)/.exec(text.trim());
  if (!m) return false;
  const list = await commands().catch(() => []);
  return list.some((c) => c.name === `/${m[1]}`);
}

function commandOutput(result) {
  if (!result) return 'Done.';
  if (typeof result === 'string') return result;
  return String(result.output ?? result.text ?? result.message ?? JSON.stringify(result));
}

// ---------- Ask Agent side chat ----------
const SIDE_FILE = path.join(config.dataDir, 'side-chats.json');
let sideKey = '';
try { sideKey = JSON.parse(await fsp.readFile(SIDE_FILE, 'utf8')).hermes || ''; } catch { /* first run */ }

async function saveSideKey(key) {
  if (!key || key === sideKey) return;
  sideKey = key;
  let all = {};
  try { all = JSON.parse(await fsp.readFile(SIDE_FILE, 'utf8')); } catch { /* new file */ }
  await fsp.writeFile(SIDE_FILE, JSON.stringify({ ...all, hermes: key }, null, 2), { mode: 0o600 });
}

/**
 * A read-only side question. On a Hermes card Hermes answers from that chat's own history
 * (its /btw); for any other card it answers from the context the board passes in. Hermes denies
 * every tool for /btw, so nothing is done, only answered.
 */
export async function sideAsk({ card, question, context }) {
  if (card?.harness === 'hermes' && card.canReply) {
    const target = { key: card.ref, ...(card.hermesProfile ? { profile: card.hermesProfile } : {}) };
    const res = await bridge('btw', { ...target, text: question }, 180000);
    return res.answer;
  }
  const res = await bridge('side', { key: sideKey, text: context }, 180000);
  await saveSideKey(res.key);
  return res.answer;
}

// ---------- handoff + gateway ----------
/** Start a new Hermes chat with a first message. Returns its key (the board's session ref). */
export async function startSession({ title, message, images = [], cwd }) {
  const res = await bridge('create', { title, text: message, ...(cwd ? { cwd } : {}), ...(images.length ? { images: images.map((i) => i.path) } : {}) }, 90000);
  if (!res.session_key) throw new Error('Hermes started the chat but did not report its key yet. Check the Hermes app.');
  return { ref: res.session_key, title };
}

/** End (close) a Hermes chat. It stays in Hermes's history and can be reopened there. */
export async function endSession(card) {
  if (!card.canReply) throw new Error(card.replyBlockedReason || 'The board cannot reach that Hermes chat.');
  await bridge('end', { key: card.ref, ...(card.hermesProfile ? { profile: card.hermesProfile } : {}) }, 45000);
  msgCache.delete(card.ref);
  return 'Ended in Hermes. It stays in Hermes\'s history; if the Hermes app has it open, it closes when you leave it there.';
}

/** Restart the Hermes gateway service. Running Hermes chats are interrupted. */
export async function restartGateway() {
  const out = await run(config.hermes.launcher, ['gateway', 'restart'], { timeoutMs: 120000 });
  python = null;
  return clip(out.trim() || 'Hermes gateway restarted.', 600);
}
