// Codex lane: reads rollout logs from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Interactive Codex running inside tmux (start with `ah codex <folder>`) can be answered
// from the board; one-shot `codex exec` runs and sessions outside tmux are read-only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { projectFor } from '../projects.js';
import { classify, clip, clipTail, replyEnd, askOf, textOf, tailLines, parseJsonLines, isSyntheticPrompt, run, earlierTurns, REPLY_MAX } from '../util.js';
import { tmuxHealth } from '../health.js';
import { findLinks } from '../preview.js';
import { questionFromMenu, questionFromReply } from '../choices.js';
import { safeFirstMessage } from '../newchat.js';
import { imageNote } from '../uploads.js';
import { STATIC_COMMANDS } from '../commands.js';
import * as tmux from '../tmux.js';
import { openFiles } from '../platform.js';

const READ_ONLY_REASON = 'Read-only: this Codex session is not running inside tmux, so the board cannot type into it. Start sessions with `ah codex <folder>` to answer them from here.';
const ONE_SHOT_REASON = 'This was a one-shot `codex exec` run; there is no conversation to reply to.';
const ROLLOUT_RE = /\/\.codex\/sessions\/.*rollout-[^/]*\.jsonl$/;

/**
 * Map rollout file -> tmux pane for every interactive Codex process inside tmux.
 * First choice: the rollout file the process has open. Fallback: the newest interactive
 * rollout whose folder matches the pane's folder.
 */
async function tmuxRollouts(rollouts, summaries) {
  const owners = await tmux.paneOwners();
  if (!owners.size) return new Map();
  const codexPids = (await tmux.pidsNamed(/^codex$/)).filter((pid) => owners.has(pid));
  const result = new Map();
  const panesDone = new Set();
  for (const pid of codexPids) {
    const pane = owners.get(pid);
    if (panesDone.has(pane.paneId)) continue;
    // The session log it has open (lsof on macOS, /proc on Linux).
    let file = (await openFiles(pid)).find((f) => ROLLOUT_RE.test(f)) || '';
    if (!file) {
      const match = rollouts.find((r) => {
        const s = summaries.get(r.file);
        return s && !s.oneShot && s.cwd === pane.cwd;
      });
      file = match?.file || '';
    }
    if (file) { result.set(file, pane); panesDone.add(pane.paneId); }
  }
  return result;
}
const sumCache = new Map(); // file -> { mtime, summary }
const paneFirstSeen = new Map(); // paneId -> when a not-yet-logged session was first seen

async function headEntries(file, bytes = 400_000) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (bytesRead === bytes) lines.pop();
    return parseJsonLines(lines);
  } finally {
    await fh.close();
  }
}

async function listRollouts() {
  const out = [];
  const cutoff = Date.now() - config.lookbackMs;
  const days = Math.ceil(config.lookbackMs / 86400000) + 1;
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dir = path.join(config.codex.sessionsDir, String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let files = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      try {
        const st = await fs.stat(file);
        if (st.mtimeMs >= cutoff) out.push({ file, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }
  return out;
}

function chatMessages(entries) {
  return entries
    .filter((e) => e.type === 'response_item' && e.payload?.type === 'message' && ['user', 'assistant'].includes(e.payload.role))
    .map((e) => ({ role: e.payload.role === 'user' ? 'you' : 'agent', text: textOf(e.payload.content), ts: Date.parse(e.timestamp) || null }))
    .filter((m) => m.text.trim() && !(m.role === 'you' && isSyntheticPrompt(m.text)));
}

async function summarize(r) {
  const hit = sumCache.get(r.file);
  if (hit && hit.mtime === r.mtime) return hit.summary;
  const head = await headEntries(r.file);
  const meta = head.find((e) => e.type === 'session_meta')?.payload || {};
  const firstPrompt = chatMessages(head).find((m) => m.role === 'you')?.text || '';
  const tail = parseJsonLines(await tailLines(r.file));
  const msgs = chatMessages(tail);
  const lastPrompt = [...msgs].reverse().find((m) => m.role === 'you')?.text || firstPrompt;
  const lastReply = [...msgs].reverse().find((m) => m.role === 'agent')?.text || '';
  const taskEvents = tail.filter((e) => e.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(e.payload?.type));
  const lastTask = taskEvents[taskEvents.length - 1]?.payload?.type || '';
  const summary = {
    id: meta.id || meta.session_id || path.basename(r.file, '.jsonl'),
    cwd: meta.cwd || '',
    source: typeof meta.source === 'string' ? meta.source : (meta.source?.subagent ? 'subagent' : ''),
    // codex_exec = a one-shot `codex exec` run (on this computer, mostly dispatched by Hermes kanban).
    oneShot: meta.originator === 'codex_exec' || meta.source === 'exec' || !!meta.source?.subagent,
    title: clip(firstPrompt.split('\n')[0], 90),
    lastPrompt,
    lastReply,
    lastTask,
    links: findLinks(lastReply, lastPrompt),
    earlier: earlierTurns(msgs),
  };
  sumCache.set(r.file, { mtime: r.mtime, summary });
  return summary;
}

export async function collect() {
  let rollouts;
  try {
    rollouts = await listRollouts();
  } catch (e) {
    return { connected: false, reason: `Could not read Codex logs: ${e.message}`, cards: [], health: 'down', why: `The board can't read Codex's logs: ${e.message}` };
  }
  rollouts.sort((a, b) => b.mtime - a.mtime);
  const shown = rollouts.slice(0, config.maxPerLane);
  const summaries = new Map();
  for (const r of shown) {
    try { summaries.set(r.file, await summarize(r)); } catch { /* unreadable log */ }
  }
  let panes = new Map();
  let tmuxNote = '';
  try { panes = await tmuxRollouts(shown, summaries); } catch (e) { tmuxNote = ` (tmux check failed: ${e.message})`; }

  const cards = [];
  for (const r of shown) {
    const s = summaries.get(r.file);
    if (!s) continue;
    const pane = panes.get(r.file);
    let prompt = null;
    if (pane) {
      try { prompt = tmux.detectPrompt(await tmux.capture(pane.paneId)); } catch { /* pane closed mid-read */ }
    }
    const recent = Date.now() - r.mtime < config.workingWindowMs;
    const oneShot = s.oneShot && !pane;
    const turnDone = s.lastTask === 'task_complete' || s.lastTask === 'turn_aborted';
    const { status, waitingSince } = classify({
      running: s.lastTask === 'task_started' && recent && !prompt,
      ended: oneShot && turnDone,
      agentSpokeLast: (turnDone && !!s.lastReply) || !!prompt,
      lastActivity: r.mtime,
    }, config);
    cards.push({
      id: `codex:${s.id}`,
      harness: 'codex',
      ref: s.id,
      file: r.file,
      title: s.title || `Codex run in ${path.basename(s.cwd || '') || 'unknown folder'}`,
      cwd: s.cwd,
      project: projectFor(s.cwd),
      status,
      waitingSince,
      lastActivity: Math.round(r.mtime),
      lastPrompt: clip(s.lastPrompt),
      lastReply: clipTail(s.lastReply, REPLY_MAX),
      earlier: s.earlier || [],
      replyEnd: replyEnd(s.lastReply),
      ask: askOf(s.lastReply),
      links: s.links,
      needsApproval: !!prompt,
      pendingPrompt: prompt?.text || '',
      menuEscSafe: prompt ? tmux.escSafe(prompt) : true,
      request: prompt?.request || null,
      question: questionFromMenu(prompt)
        || (prompt || !turnDone || status === 'working' ? null : questionFromReply(s.lastReply, replyEnd(s.lastReply))),
      paneId: pane?.paneId || '',
      automated: oneShot, // a `codex exec` run or a subagent, not a chat (kept out of Recent)
      source: pane
        ? `interactive, in tmux ${pane.target}`
        : (s.oneShot ? `codex exec one-shot run${s.source === 'subagent' ? ' (subagent)' : ''}` : (s.source || 'interactive, not in tmux')),
      canReply: !!pane,
      replyBlockedReason: pane ? '' : (s.oneShot ? ONE_SHOT_REASON : READ_ONLY_REASON),
      note: '',
    });
  }
  // Codex writes no session log until its first-run menus (e.g. "trust this directory?") are
  // answered. Show tmux panes running Codex without a log yet, so those menus reach you too.
  let starting = 0;
  let running = 0; // every Codex process, in tmux or not
  try {
    const owners = await tmux.paneOwners();
    const mappedPanes = new Set([...panes.values()].map((p) => p.paneId));
    const codexPids = await tmux.pidsNamed(/^codex$/);
    running = codexPids.length;
    for (const pid of codexPids) {
      const pane = owners.get(pid);
      if (!pane || mappedPanes.has(pane.paneId)) continue;
      mappedPanes.add(pane.paneId);
      let prompt = null;
      try { prompt = tmux.detectPrompt(await tmux.capture(pane.paneId)); } catch { continue; }
      if (!paneFirstSeen.has(pane.paneId)) paneFirstSeen.set(pane.paneId, Date.now());
      const since = paneFirstSeen.get(pane.paneId);
      starting++;
      cards.push({
        id: `codex:pane:${pane.paneId}`,
        harness: 'codex',
        ref: `tmux ${pane.target}`,
        file: '',
        title: `New Codex session in ${path.basename(pane.cwd)}`,
        cwd: pane.cwd,
        project: projectFor(pane.cwd),
        status: prompt ? 'waiting' : 'working',
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
  } catch (e) { tmuxNote = tmuxNote || ` (tmux check failed: ${e.message})`; }
  return {
    connected: true,
    reason: `Live: ${rollouts.length} Codex session log(s) in the last ${Math.round(config.lookbackMs / 86400000)} days, ${panes.size + starting} in tmux (answerable), ${cards.length} shown${tmuxNote}`,
    cards,
    // The Codex command itself isn't checked here: a wrong one shows when New chat starts a session.
    ...tmuxHealth('Codex', { binOk: true, running: Math.max(running, panes.size + starting), inTmux: panes.size + starting }),
  };
}

/** Answer a tmux-hosted Codex session. Only called after the user confirms in the UI. */
export async function send(card, { kind, message, images = [], expectPrompt, expectText }) {
  if (!card.paneId) throw new Error(card.replyBlockedReason || READ_ONLY_REASON);
  // Images in a running chat: Codex opens them from their file paths (its view_image tool).
  await tmux.act(card.paneId, { kind, message: message + imageNote(images), expectPrompt, expectText });
  sumCache.delete(card.file);
}

/** Answer the terminal menu on the card: one option, ticked options, or your own words in its free-text row. tmux re-checks the screen first. */
export async function choose(card, { pick, text }) {
  if (!card.paneId) throw new Error(card.replyBlockedReason || READ_ONLY_REASON);
  const q = card.question;
  const base = { expectPrompt: true, expectText: q.expect };
  if (q.multi) await tmux.act(card.paneId, { ...base, kind: 'multi', indexes: pick });
  else if (pick === q.freeText) await tmux.act(card.paneId, { ...base, kind: 'type', index: pick, message: text });
  else await tmux.act(card.paneId, { ...base, kind: 'choose', index: pick });
  sumCache.delete(card.file);
}

/** Defer: leave a menu on screen with Esc (only the one you saw), then send the hold-off message. */
export async function defer(card, message) {
  if (!card.paneId) throw new Error(card.replyBlockedReason || READ_ONLY_REASON);
  await tmux.act(card.paneId, { kind: 'defer', message, expectPrompt: !!card.pendingPrompt, expectText: card.question?.expect || card.pendingPrompt });
  sumCache.delete(card.file);
}

export async function screen(card) {
  return card.paneId ? tmux.capture(card.paneId, 80) : '';
}

export async function messages(card, n = 14) {
  if (!card.file) return [];
  return chatMessages(parseJsonLines(await tailLines(card.file, 3_000_000))).slice(-n);
}

export async function commands() { return STATIC_COMMANDS.codex; }

/**
 * Ask Agent side chat: a one-shot `codex exec` in a read-only sandbox (no writes, no network)
 * that is not saved as a session. It can only answer.
 */
export async function sideAsk({ context }) {
  // Its own empty folder, never AgentHub's data folder (the read-only sandbox can still read where it runs).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenthub-ask-'));
  const outFile = path.join(dir, 'answer.txt');
  try {
    await run(config.codex.bin, [
      'exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
      // A board run must never stop at Codex's update menu; this only skips the check for this run.
      '-c', 'check_for_update_on_startup=false',
      '-C', dir, '--output-last-message', outFile, context,
    ], { timeoutMs: config.ask.timeoutMs, cwd: dir });
    return (await fs.readFile(outFile, 'utf8')).trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Handoff: start interactive Codex in tmux (like `ah codex`) with the handoff as its first prompt.
 * The update check is skipped for this run only, so the new session can't stall at the update menu.
 */
export async function startSession({ title, message, images = [], cwd }) {
  if (!cwd) throw new Error('Pick a project folder for Codex to work in.');
  const name = await tmux.freeSessionName(`codex-${path.basename(cwd)}`);
  // A new chat attaches its images to the first message itself. `--image=a,b` as one argument: the spaced form takes
  // any number of files and would read the message as one more.
  const attach = images.length ? [`--image=${images.map((i) => i.path).join(',')}`] : [];
  // The default model for New chat from Settings ('' = Codex's own default).
  const model = config.codex.model ? ['-m', config.codex.model] : [];
  const pane = await tmux.newSession(name, cwd, [config.codex.bin, '-c', 'check_for_update_on_startup=false', ...model, ...attach, safeFirstMessage(message)]);
  return { ref: '', paneId: pane.paneId, target: pane.target, title };
}

/**
 * End a tmux-hosted Codex session by typing /exit, as you would. Refused while a menu is showing or a turn
 * is running. The session is saved and can be resumed later with `codex resume`.
 */
export async function endSession(card) {
  if (!card.paneId) throw new Error(card.replyBlockedReason || READ_ONLY_REASON);
  // A just-started session with no log yet shows as working but is sitting at its prompt; that one may be ended.
  if (card.status === 'working' && !String(card.ref).startsWith('tmux ')) throw new Error('Codex is working right now. Wait for it to finish, then end it.');
  await tmux.act(card.paneId, { kind: 'reply', message: '/exit', expectPrompt: false, expectText: '' });
  if (card.file) sumCache.delete(card.file);
  return 'Typed /exit. The session is saved; resume it later with `codex resume`.';
}
