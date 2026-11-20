// Claude Code lanes, one per account: live sessions come from Claude Code's own registry
// (<config folder>/sessions/<pid>.json, which carries busy/idle status), transcripts
// from <config folder>/projects/<dir>/<sessionId>.jsonl. Each account in this install's setup has its own config folder
// (e.g. ~/.claude for plain `claude`) and may add read-only folders whose sessions are shown but never acted on.
// A session belongs to the account whose folder registered it. Sessions running inside tmux (start them with `ah claude <folder>`) can be
// answered from the board; the rest are read-only because there is no terminal the board can type into.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { projectFor } from '../projects.js';
import { classify, clip, clipTail, replyEnd, askOf, textOf, tailLines, parseJsonLines, pidAlive, isSyntheticPrompt, run, earlierTurns, REPLY_MAX } from '../util.js';
import { tmuxHealth, canRun } from '../health.js';
import { AGENT_NAMES } from '../names.js';
import { findLinks } from '../preview.js';
import { questionFromMenu, questionFromReply } from '../choices.js';
import { safeFirstMessage } from '../newchat.js';
import { imageNote } from '../uploads.js';
import { STATIC_COMMANDS } from '../commands.js';
import * as tmux from '../tmux.js';
import { ownsConfigDir } from '../tmux.js';

const READ_ONLY_REASON = 'Read-only: this Claude Code session is not running inside tmux, so the board cannot type into it. Start sessions with `ah claude <folder>` to answer them from here.';
const CLOSED_REASON = 'This Claude Code session has ended.';
const sumCache = new Map(); // file -> { mtime, summary }
const paneFirstSeen = new Map(); // paneId -> when an unregistered session's menu was first seen

/** Transcripts in every config folder's projects/, each tagged with the folder it came from. */
async function listTranscripts(configDirs) {
  const out = [];
  for (const configDir of configDirs) out.push(...(await listTranscriptsIn(configDir)));
  return out;
}

async function listTranscriptsIn(configDir) {
  const out = [];
  const cutoff = Date.now() - config.lookbackMs;
  const projectsDir = path.join(configDir, 'projects');
  let dirs = [];
  try { dirs = await fs.readdir(projectsDir, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let files = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      try {
        const st = await fs.stat(file);
        if (st.mtimeMs >= cutoff) out.push({ sessionId: f.slice(0, -6), file, mtime: st.mtimeMs, configDir });
      } catch { /* vanished */ }
    }
  }
  return out;
}

/** Live sessions registered in any of the config folders, each tagged with the folder that registered it. */
async function readRegistry(configDirs) {
  const live = new Map();
  for (const configDir of configDirs) {
    const registryDir = path.join(configDir, 'sessions');
    let files = [];
    try { files = await fs.readdir(registryDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(registryDir, f), 'utf8'));
        if (r.kind && r.kind !== 'interactive') continue; // skip one-shot `claude -p` runs (e.g. Ask Agent side chat)
        if (r.pid && pidAlive(r.pid) && r.sessionId) live.set(r.sessionId, { ...r, configDir });
      } catch { /* being rewritten */ }
    }
  }
  return live;
}

/** Which sub-folder of `root` a read-only session works in (the first folder under `root` in its cwd), or ''. */
function labelUnder(cwd, root) {
  if (!root || !cwd) return '';
  const rel = path.relative(root, cwd);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : '';
}

function conversational(entries) {
  return entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.isSidechain && e.message);
}

function promptText(e) {
  const c = e.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.some((p) => p.type === 'tool_result')) return '';
  return textOf(c);
}

async function summarize(t) {
  const hit = sumCache.get(t.file);
  if (hit && hit.mtime === t.mtime) return hit.summary;
  const entries = parseJsonLines(await tailLines(t.file));
  const conv = conversational(entries);
  let lastPrompt = '';
  let lastReply = '';
  let cwd = '';
  let title = '';
  for (const e of entries) {
    if (e.cwd) cwd = e.cwd;
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    if (e.type === 'summary' && e.summary && !title) title = e.summary;
  }
  for (const e of [...conv].reverse()) {
    if (!lastReply && e.type === 'assistant') lastReply = textOf(e.message.content);
    if (!lastPrompt && e.type === 'user') { const p = promptText(e); if (!isSyntheticPrompt(p)) lastPrompt = p; }
    if (lastPrompt && lastReply) break;
  }
  const last = conv[conv.length - 1];
  const agentSpokeLast = !!last && last.type === 'assistant'
    && Array.isArray(last.message.content) && !last.message.content.some((p) => p.type === 'tool_use')
    && !!textOf(last.message.content).trim();
  // The chat as you / agent messages (tool results are not your words), for the turns shown above the last reply.
  const msgs = conv.map((e) => (e.type === 'assistant' ? { role: 'agent', text: textOf(e.message.content) } : { role: 'you', text: promptText(e) }));
  // How the session was started: `sdk-cli` is a one-off `claude -p` run (another program or agent started it).
  const entrypoint = entries.find((e) => e.entrypoint)?.entrypoint || '';
  const summary = { lastPrompt, lastReply, agentSpokeLast, cwd, title, links: findLinks(lastReply, lastPrompt), earlier: earlierTurns(msgs), entrypoint };
  sumCache.set(t.file, { mtime: t.mtime, summary });
  return summary;
}

/**
 * One Claude Code lane for one account (see claudeAccount in lib/config.js): `id` the lane key, `dirs` the account's
 * config folders, `bin` the command that starts Claude Code on it; `readOnlyDirs` read-only folders whose sessions are
 * shown in this lane, labelled by their sub-folder under `readOnlyRoot` and tagged `readOnlyTag`.
 */
export function createClaudeLane(acct) {
  const { id: key, bin, dirs, readOnlyDirs = [], readOnlyRoot = '', readOnlyTag = '', readOnlyName = '' } = acct;
  const name = AGENT_NAMES[key] || acct.label || key;
  const allDirs = [...dirs, ...readOnlyDirs];
  const isReadOnly = (dir) => readOnlyDirs.includes(dir);
  const account = key;

  async function collect() {
    let transcripts;
    let live;
    try {
      [transcripts, live] = await Promise.all([listTranscripts(allDirs), readRegistry(allDirs)]);
    } catch (e) {
      return { connected: false, reason: `Could not read Claude Code logs: ${e.message}`, cards: [], health: 'down',
        why: `The board can't read ${name}'s logs: ${e.message}` };
    }
    transcripts.sort((a, b) => b.mtime - a.mtime);
    const byId = new Map(transcripts.map((t) => [t.sessionId, t]));
    // Always include every live session, then fill with the most recent closed ones.
    const picked = [...live.keys()].map((id) => byId.get(id)).filter(Boolean);
    for (const t of transcripts) {
      if (picked.length >= config.maxPerLane) break;
      if (!live.has(t.sessionId)) picked.push(t);
    }

    let owners = new Map();
    let tmuxNote = '';
    try { owners = await tmux.paneOwners(); } catch (e) { tmuxNote = ` (tmux check failed: ${e.message})`; }

    const cards = [];
    let inTmux = 0;
    for (const t of picked) {
      const reg = live.get(t.sessionId);
      let sum;
      try { sum = await summarize(t); } catch (e) { continue; }
      const cwd = reg?.cwd || sum.cwd;
      const regStatus = reg?.status || '';
      const pane = reg ? owners.get(reg.pid) : null;
      let prompt = null;
      if (pane) {
        inTmux++;
        try { prompt = tmux.detectPrompt(await tmux.capture(pane.paneId)); } catch { /* pane closed mid-read */ }
      }
      const needsApproval = !!prompt || /permission|approv|input|waiting/i.test(regStatus);
      const { status, waitingSince } = classify({
        running: !!reg && regStatus === 'busy' && !prompt,
        ended: !reg,
        agentSpokeLast: sum.agentSpokeLast || needsApproval,
        lastActivity: reg?.statusUpdatedAt || t.mtime,
      }, config);
      cards.push({
        id: `${key}:${t.sessionId}`,
        harness: key,
        account,
        // Read-only sessions name their sub-folder; ones that ran in the read-only root itself use its name.
      // A read-only session: labelled by its sub-folder (else the folder it is under) and the setup's tag ("Tools").
      readOnly: isReadOnly(reg?.configDir || t.configDir) ? (labelUnder(cwd, readOnlyRoot) || readOnlyName || path.basename(readOnlyRoot) || name) : '',
      readOnlyTag: isReadOnly(reg?.configDir || t.configDir) ? readOnlyTag : '',
      // A one-off `claude -p` run, or a read-only session another agent runs: not a chat (kept out of Recent).
      automated: sum.entrypoint === 'sdk-cli' || isReadOnly(reg?.configDir || t.configDir),
        ref: t.sessionId,
        file: t.file,
        title: reg?.name && reg.nameSource !== 'derived' ? reg.name : (sum.title || clip(sum.lastPrompt, 80) || reg?.name || t.sessionId),
        cwd,
        project: projectFor(cwd),
        status,
        waitingSince,
        lastActivity: Math.round(Math.max(t.mtime, reg?.statusUpdatedAt || 0)),
        lastPrompt: clip(sum.lastPrompt),
        lastReply: clipTail(sum.lastReply, REPLY_MAX),
        earlier: sum.earlier || [],
        replyEnd: replyEnd(sum.lastReply),
        ask: askOf(sum.lastReply),
        links: sum.links,
        needsApproval,
        pendingPrompt: prompt?.text || '',
      menuEscSafe: prompt ? tmux.escSafe(prompt) : true,
        request: prompt?.request || null,
        question: questionFromMenu(prompt)
          || (prompt || !sum.agentSpokeLast || status === 'working' ? null : questionFromReply(sum.lastReply, replyEnd(sum.lastReply))),
        paneId: pane?.paneId || '',
        source: reg
          ? `live pid ${reg.pid} (${regStatus || 'unknown'})${pane ? ` in tmux ${pane.target}` : ', not in tmux'}`
          : 'closed (process exited)',
        canReply: !!pane,
        replyBlockedReason: pane ? '' : (reg ? READ_ONLY_REASON : CLOSED_REASON),
        note: '',
      });
    }
    // Claude Code only registers a session after its first-run menus (e.g. "trust this folder?")
    // are answered. Show tmux panes running an unregistered Claude so those menus reach you too.
    if (owners.size) {
      // Pids that already have a card. A registered session with no transcript yet (started, nothing typed)
      // has no card above, so it is shown here like a session that is still starting.
      const transcriptIds = new Set(picked.map((t) => t.sessionId));
      const registeredPids = new Set([...live.values()].filter((r) => transcriptIds.has(r.sessionId)).map((r) => r.pid));
      const seenPanes = new Set(cards.map((c) => c.paneId).filter(Boolean));
      let claudePids = [];
      try { claudePids = await tmux.pidsNamed(/^claude(\.exe)?$/); } catch { /* ps failed */ }
      for (const pid of claudePids) {
        const pane = owners.get(pid);
        if (!pane || registeredPids.has(pid) || seenPanes.has(pane.paneId)) continue;
        // Not registered yet: it belongs to this account only if the process was started with one of its folders.
        let procDir = '';
        try { procDir = await tmux.configDirOf(pid); } catch { continue; }
        if (!ownsConfigDir(procDir, allDirs, os.homedir())) continue;
        seenPanes.add(pane.paneId);
        inTmux++;
        let prompt = null;
        try { prompt = tmux.detectPrompt(await tmux.capture(pane.paneId)); } catch { continue; }
        if (!paneFirstSeen.has(pane.paneId)) paneFirstSeen.set(pane.paneId, Date.now());
        const since = paneFirstSeen.get(pane.paneId);
        cards.push({
          id: `${key}:pane:${pane.paneId}`,
          harness: key,
          account,
          readOnly: '',
          ref: `tmux ${pane.target}`,
          file: '',
          title: `New Claude Code session in ${path.basename(pane.cwd)}`,
          cwd: pane.cwd,
          project: projectFor(pane.cwd),
          // Registered but nothing typed yet: Claude Code reports idle, so say so instead of "working".
          status: prompt ? 'waiting' : ([...live.values()].find((r) => r.pid === pid)?.status === 'idle' ? 'idle' : 'working'),
          waitingSince: prompt ? since : null,
          lastActivity: since,
          lastPrompt: '',
          lastReply: '',
          replyEnd: '',
          ask: '',
          needsApproval: !!prompt,
          pendingPrompt: prompt?.text || '',
      menuEscSafe: prompt ? tmux.escSafe(prompt) : true,
          request: prompt?.request || null,
          question: questionFromMenu(prompt),
          paneId: pane.paneId,
          source: `starting up, in tmux ${pane.target}`,
          canReply: true,
          replyBlockedReason: '',
          note: '',
        });
      }
    }
    return {
      connected: true,
      reason: `Live: ${live.size} running Claude Code session(s), ${inTmux} in tmux (answerable), ${cards.length} shown${tmuxNote}`,
      cards,
      ...tmuxHealth(name, { binOk: await canRun(bin), bin, running: live.size, inTmux }),
    };
  }

  return {
    collect,
    send: sendCard,
    choose: chooseCard,
    screen: screenOf,
    messages: messagesOf,
    commands: commandList,
    endSession: (card) => endCard(card, bin),
    defer: deferCard,
    sideAsk: (opts) => askAside(bin, opts),
    startSession: (opts) => startIn(acct, opts),
  };
}

/** Answer a tmux-hosted session. Only called after the user confirms in the UI. */
async function sendCard(card, { kind, message, images = [], expectPrompt, expectText }) {
  if (!card.paneId) throw new Error(card.replyBlockedReason || READ_ONLY_REASON);
  // Images: Claude Code opens them from their file paths (its Read tool shows it the picture).
  await tmux.act(card.paneId, { kind, message: message + imageNote(images), expectPrompt, expectText });
  sumCache.delete(card.file);
}

/** Answer the terminal menu on the card: one option, ticked options, or your own words in its free-text row. tmux re-checks the screen first. */
async function chooseCard(card, { pick, text }) {
  if (!card.paneId) throw new Error(card.replyBlockedReason || READ_ONLY_REASON);
  const q = card.question;
  const base = { expectPrompt: true, expectText: q.expect };
  if (q.multi) await tmux.act(card.paneId, { ...base, kind: 'multi', indexes: pick });
  else if (pick === q.freeText) await tmux.act(card.paneId, { ...base, kind: 'type', index: pick, message: text });
  else await tmux.act(card.paneId, { ...base, kind: 'choose', index: pick });
  sumCache.delete(card.file);
}

/** Defer: leave a menu on screen with Esc (only the one you saw), then send the hold-off message. */
async function deferCard(card, message) {
  if (!card.paneId) throw new Error(card.replyBlockedReason || READ_ONLY_REASON);
  await tmux.act(card.paneId, { kind: 'defer', message, expectPrompt: !!card.pendingPrompt, expectText: card.question?.expect || card.pendingPrompt });
  sumCache.delete(card.file);
}

async function screenOf(card) {
  return card.paneId ? tmux.capture(card.paneId, 80) : '';
}

async function messagesOf(card, n = 14) {
  if (!card.file) return [];
  const entries = conversational(parseJsonLines(await tailLines(card.file, 3_000_000)));
  return entries
    .map((e) => ({ role: e.type === 'user' ? 'you' : 'agent', text: e.type === 'user' ? promptText(e) : textOf(e.message.content), ts: Date.parse(e.timestamp) || null }))
    .filter((m) => m.text.trim() && !(m.role === 'you' && isSyntheticPrompt(m.text)))
    .slice(-n);
}

async function commandList() { return STATIC_COMMANDS.claude; }

/**
 * Ask Agent side chat: a one-shot `claude -p` with no tools, no MCP servers, no hooks and no saved
 * session. It can only answer; it cannot look at or change anything.
 */
async function askAside(bin, { context, model }) {
  // Run in an empty folder of its own, never AgentHub's data folder.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenthub-ask-'));
  const out = await run(bin, [
    '-p',
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    // Don't fire the user's hooks (e.g. the episodic-memory sync): the memory system stays untouched.
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--model', model || config.ask.claudeModel,
    '--output-format', 'json',
    context,
  ], { timeoutMs: config.ask.timeoutMs, cwd: dir }).finally(() => fs.rm(dir, { recursive: true, force: true }));
  const envelope = JSON.parse(out);
  if (envelope.is_error) throw new Error(envelope.result || 'Claude Code could not answer');
  return String(envelope.result || '').trim();
}

/**
 * The command a new chat runs in tmux for an account, always pinned to that account (a CLAUDE_CONFIG_DIR inherited
 * from the tmux server would otherwise decide it):
 *   a wrapper that takes the folder (`folderArg`): `<command> <folder> <message>`, the folder given explicitly so a
 *     message that names a folder can't move it (and never any other option, e.g. a wrapper's `--workspace`);
 *   the default config folder (~/.claude): `claude <message>` with CLAUDE_CONFIG_DIR removed;
 *   any other config folder: `claude <message>` with CLAUDE_CONFIG_DIR set to it.
 */
export function startArgv({ bin, dirs = [], folderArg = false, defaultDir = false, model = '' }, cwd, message) {
  const first = safeFirstMessage(message);
  // The account's default model for New chat (Settings), after the folder for a wrapper that takes the folder first.
  const m = model ? ['--model', model] : [];
  if (folderArg) return [bin, cwd, ...m, first];
  if (defaultDir || !dirs[0]) return ['/usr/bin/env', '-u', 'CLAUDE_CONFIG_DIR', bin, ...m, first];
  return ['/usr/bin/env', `CLAUDE_CONFIG_DIR=${dirs[0]}`, bin, ...m, first];
}

/** Handoff: start interactive Claude Code in tmux (like `ah claude`) with the handoff as its first prompt. */
async function startIn(acct, { title, message, images = [], cwd }) {
  if (!cwd) throw new Error('Pick a project folder for Claude Code to work in.');
  const name = await tmux.freeSessionName(`claude-${path.basename(cwd)}`);
  const pane = await tmux.newSession(name, cwd, startArgv(acct, cwd, message + imageNote(images)));
  return { ref: '', paneId: pane.paneId, target: pane.target, title };
}

/**
 * End a tmux-hosted Claude Code session by typing /exit, as you would. Refused while a menu is showing or a turn
 * is running. The session is saved and can be resumed later with `claude --resume`.
 */
async function endCard(card, bin) {
  if (!card.paneId) throw new Error(card.replyBlockedReason || READ_ONLY_REASON);
  // A just-started session with no log yet shows as working but is sitting at its prompt; that one may be ended.
  if (card.status === 'working' && !String(card.ref).startsWith('tmux ')) throw new Error('Claude Code is working right now. Wait for it to finish, then end it.');
  await tmux.act(card.paneId, { kind: 'reply', message: '/exit', expectPrompt: false, expectText: '' });
  if (card.file) sumCache.delete(card.file);
  return `Typed /exit. The session is saved; resume it later with \`${path.basename(bin)} --resume\`.`;
}

/** One lane per Claude Code account in this install's setup, in board order. */
export const claudeLanes = () => config.claudeAccounts.map((a) => ({ account: a, mod: createClaudeLane(a) }));
