// OpenClaw lane: talks to the local gateway through the OpenClaw CLI
// (`openclaw gateway call <method>`), which handles the gateway's auth handshake.
// sessions.list to list, chat.history for prompts/replies, chat.send to reply.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.js';
import { projectFor } from '../projects.js';
import { classify, clip, clipTail, replyEnd, askOf, textOf, run, mapLimit, isSyntheticPrompt, earlierTurns, REPLY_MAX } from '../util.js';
import { gatewayHealth } from '../health.js';
import { findLinks } from '../preview.js';
import { questionFromReply } from '../choices.js';

// The board's own read-only side chat for Ask Agent. Hidden from the board itself.
const SIDE_KEY = 'agent:main:dashboard:agenthub-side-chat';

const histCache = new Map(); // session key -> { stamp, summary }

// Everything goes to OpenClaw as one command-line argument, and macOS allows about 1 MB of those in all.
const MAX_PARAMS = 900 * 1024;

/** Images as OpenClaw's own chat attachments (sent inside the call, as its app does). */
async function attachments(images) {
  if (!images.length) return {};
  const list = await Promise.all(images.map(async (i) => ({
    type: 'image', mimeType: i.mime, fileName: i.name, origin: 'file', content: (await fs.readFile(i.path)).toString('base64'),
  })));
  const size = list.reduce((n, a) => n + a.content.length, 0);
  if (size > MAX_PARAMS) throw new Error(`These images are too large for OpenClaw in one message (${Math.round(size / 1024)} KB of about ${Math.round(MAX_PARAMS / 1024)} KB). Send fewer images at a time.`);
  return { attachments: list };
}

async function call(method, params = {}, timeoutMs = 20000) {
  const out = await run(config.openclaw.bin, [
    'gateway', 'call', method,
    '--port', String(config.openclaw.port),
    '--json',
    '--timeout', String(timeoutMs - 2000),
    '--params', JSON.stringify(params),
  ], { timeoutMs });
  const data = JSON.parse(out);
  if (data && data.ok === false) throw new Error(data.error?.message || 'gateway call failed');
  return data;
}

function toMessages(raw) {
  return raw
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role === 'user' ? 'you' : 'agent', text: textOf(m.content), ts: m.timestamp || null }))
    .filter((m) => m.text.trim());
}

async function summarize(s) {
  const stamp = s.updatedAt;
  const hit = histCache.get(s.key);
  if (hit && hit.stamp === stamp) return hit.summary;
  const data = await call('chat.history', { sessionKey: s.key, limit: 100 });
  const raw = data.messages || [];
  const msgs = toMessages(raw);
  const lastPrompt = [...msgs].reverse().find((m) => m.role === 'you' && !isSyntheticPrompt(m.text));
  const lastReply = [...msgs].reverse().find((m) => m.role === 'agent');
  const lastConversational = [...raw].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
  const agentSpokeLast = !!lastConversational && lastConversational.role === 'assistant'
    && !!textOf(lastConversational.content).trim();
  const summary = {
    lastPrompt: lastPrompt?.text || '',
    lastReply: lastReply?.text || '',
    agentSpokeLast,
    pendingInputs: Array.isArray(data.pendingInputs) ? data.pendingInputs.length : 0,
    links: findLinks(lastReply?.text, lastPrompt?.text),
    earlier: earlierTurns(msgs),
  };
  histCache.set(s.key, { stamp, summary });
  return summary;
}

export async function collect() {
  let list;
  try {
    list = await call('sessions.list', { limit: 100 });
  } catch (e) {
    return {
      connected: false,
      reason: `OpenClaw gateway not reachable on port ${config.openclaw.port}: ${e.message}. Check with: openclaw gateway status`,
      cards: [],
      ...gatewayHealth('OpenClaw', e.message),
    };
  }
  const cutoff = Date.now() - config.lookbackMs;
  const sessions = (list.sessions || [])
    .filter((s) => (s.updatedAt || 0) >= cutoff && s.key !== SIDE_KEY)
    // Background subagents and cron automations are noise unless they are running right now.
    .filter((s) => !/:(subagent|cron):/.test(String(s.key)) || s.hasActiveRun || s.status === 'running')
    .slice(0, config.maxPerLane);

  const cards = await mapLimit(sessions, 4, async (s) => {
    let sum = { lastPrompt: '', lastReply: '', agentSpokeLast: false, pendingInputs: 0, links: [] };
    let note = '';
    try { sum = await summarize(s); } catch (e) { note = `Could not read history: ${e.message}`; }
    const lastActivity = s.lastActivityAt || s.updatedAt;
    const needsApproval = !!s.permissionModePending;
    const { status, waitingSince } = classify({
      running: !!s.hasActiveRun || s.status === 'running',
      // OpenClaw's endedAt / status "done" mean the last *run* finished, not that the
      // conversation closed — a finished run in a chat session is waiting on you.
      ended: !!s.archived,
      agentSpokeLast: sum.agentSpokeLast || needsApproval,
      lastActivity,
    }, config);
    const isSubagent = String(s.key).includes(':subagent:');
    return {
      id: `openclaw:${s.key}`,
      harness: 'openclaw',
      ref: s.key,
      sessionId: s.sessionId || '', // OpenClaw requires it (expectedSessionId) to archive the chat
      title: s.displayName || s.label || s.key,
      cwd: s.workspaceDir || s.spawnedCwd || '',
      project: projectFor(s.workspaceDir || s.spawnedCwd),
      status,
      waitingSince,
      lastActivity,
      lastPrompt: clip(sum.lastPrompt),
      lastReply: clipTail(sum.lastReply, REPLY_MAX),
      earlier: sum.earlier || [],
      replyEnd: replyEnd(sum.lastReply),
      ask: askOf(sum.lastReply),
      links: sum.links,
      needsApproval,
      question: needsApproval || !sum.agentSpokeLast || status === 'working' ? null : questionFromReply(sum.lastReply, replyEnd(sum.lastReply)),
      model: s.model,
      source: s.channel || s.createdVia || '',
      automated: isSubagent, // a background subagent, not a chat (kept out of Recent)
      canReply: !s.sendDisabledReason && !isSubagent,
      replyBlockedReason: s.sendDisabledReason
        ? `OpenClaw says: ${s.sendDisabledReason}`
        : (isSubagent ? 'This is a background subagent; reply to its parent session instead.' : ''),
      note,
    };
  });
  return {
    connected: true,
    reason: `Live on gateway port ${config.openclaw.port}: ${list.totalCount ?? cards.length} sessions, ${cards.length} shown`,
    cards,
    ...gatewayHealth('OpenClaw', ''),
  };
}

export async function messages(card, n = 14) {
  const data = await call('chat.history', { sessionKey: card.ref, limit: 60 });
  return toMessages(data.messages || []).slice(-n);
}

/** Send a message into an OpenClaw session. Only called after the user confirms in the UI. */
export async function send(card, { message, images = [] }) {
  const result = await call('chat.send', {
    sessionKey: card.ref,
    message,
    ...await attachments(images),
    idempotencyKey: crypto.randomUUID(),
  }, 30000);
  histCache.delete(card.ref);
  return result;
}

// ---------- slash commands ----------
// OpenClaw handles slash commands typed into any chat; the gateway lists them.
// Left out: the ones that restart, update, reset or re-run setup.
const HIDDEN_COMMANDS = new Set(['/restart', '/update', '/reset', '/login', '/openclaw', '/add_model_provider']);
let catalog = { at: 0, list: [] };

/** Defer: OpenClaw has no menus; the hold-off message is a normal reply. */
export async function defer(card, message) {
  return send(card, { message });
}

export async function commands() {
  if (Date.now() - catalog.at < 600000 && catalog.list.length) return catalog.list;
  const raw = await call('commands.list', {}, 20000);
  const list = (Array.isArray(raw) ? raw : raw.commands || [])
    .map((c) => ({ name: (c.textAliases && c.textAliases[0]) || `/${c.name}`, description: c.description || '' }))
    .filter((c) => !HIDDEN_COMMANDS.has(c.name));
  catalog = { at: Date.now(), list };
  return list;
}

// ---------- Ask Agent side chat ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the agent's answer to a message sent at `since` in `sessionKey`. */
async function awaitReply(sessionKey, since, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const data = await call('chat.history', { sessionKey, limit: 10 });
    const raw = data.messages || [];
    const last = raw[raw.length - 1];
    const answer = [...raw].reverse().find((m) => m.role === 'assistant' && (m.timestamp || 0) >= since && textOf(m.content).trim());
    if (answer && last?.role === 'assistant' && !data.hasActiveRun) return textOf(answer.content).trim();
  }
  throw new Error('OpenClaw did not answer in time. Try again in a minute.');
}

/**
 * Every MCP server OpenClaw has configured, switched off (side chat only). Fails closed: if the list
 * can't be read, the side question is refused rather than asked with MCP servers left on.
 */
async function allMcpOff() {
  let conf;
  try {
    conf = JSON.parse(await fs.readFile(path.join(os.homedir(), '.openclaw/openclaw.json'), 'utf8'));
  } catch (e) {
    throw new Error(`could not read OpenClaw's MCP server list, so the side chat was not asked (${e.message})`);
  }
  return Object.fromEntries(Object.keys(conf.mcp?.servers || {}).map((name) => [name, false]));
}

/**
 * A side question in the board's own OpenClaw chat: OpenClaw's read-only permission mode, with web
 * search and all MCP servers switched off. It never touches the card's own session.
 */
export async function sideAsk({ context }) {
  await call('sessions.create', { key: SIDE_KEY, displayName: 'AgentHub side chat', permissionMode: 'read-only' }, 30000);
  // Read-only mode stops writes; also switch off web search and every MCP server, so text quoted from
  // another session can't make the side chat fetch or send anything. Re-applied on every ask.
  const overrides = { webSearch: false, mcpServers: await allMcpOff() };
  const patched = await call('sessions.patch', { key: SIDE_KEY, toolOverrides: overrides }, 30000);
  const applied = patched.entry?.toolOverrides || {};
  const allOff = applied.webSearch === false && Object.keys(overrides.mcpServers).every((n) => applied.mcpServers?.[n] === false);
  // Fail closed: only ask once OpenClaw itself confirms read-only mode with web search and MCP off.
  if (patched.entry?.permissionMode !== 'read-only') throw new Error('OpenClaw did not confirm the side chat is read-only, so it was not asked');
  if (!allOff) throw new Error('OpenClaw did not confirm web search and MCP are off, so the side chat was not asked');
  const since = Date.now() - 2000;
  await call('chat.send', { sessionKey: SIDE_KEY, message: context, idempotencyKey: crypto.randomUUID() }, 30000);
  return awaitReply(SIDE_KEY, since, 170000);
}

// ---------- handoff + gateway ----------
/** Start a new OpenClaw chat with a first message. Returns its session key. */
export async function startSession({ title, message, images = [], cwd }) {
  const res = await call('sessions.create', {
    displayName: title,
    message,
    ...await attachments(images),
    // No idempotencyKey: OpenClaw only accepts one on create from an authenticated device identity.
    ...(cwd ? { cwd } : {}),
  }, 60000);
  const ref = res.key || res.sessionKey || res.session?.key;
  if (!ref) throw new Error('OpenClaw did not report the new chat key.');
  return { ref, title };
}

/** End an OpenClaw chat by archiving it (OpenClaw's own close). It can be unarchived in OpenClaw. */
export async function endSession(card) {
  if (String(card.ref).includes(':subagent:')) throw new Error('This is a background subagent; end its parent session instead.');
  if (card.status === 'working') throw new Error('OpenClaw is working in that chat right now. Wait for it to finish, then end it.');
  if (!card.sessionId) throw new Error('OpenClaw did not report this chat\'s session id, so it was not archived. Refresh and try again.');
  // expectedSessionId: only archive the chat the card shows, not a newer one that replaced it.
  await call('sessions.patch', { key: card.ref, archived: true, expectedSessionId: card.sessionId }, 30000);
  histCache.delete(card.ref);
  return 'Archived in OpenClaw. You can unarchive it there.';
}

/** Restart the OpenClaw gateway service. Running OpenClaw chats are interrupted. */
export async function restartGateway() {
  const out = await run(config.openclaw.bin, ['gateway', 'restart'], { timeoutMs: 120000 });
  return clip(out.trim() || 'OpenClaw gateway restarted.', 600);
}
