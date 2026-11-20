import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

/** Run a command without a shell. Resolves stdout; rejects with a readable message. */
export function run(cmd, args, { timeoutMs = 20000, cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, cwd, env: env || process.env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || '').toString().trim().split('\n').slice(-3).join(' ');
          const why = err.killed ? `timed out after ${timeoutMs}ms` : (err.code === 'ENOENT' ? `${cmd} not found` : err.message.split('\n')[0]);
          reject(new Error(detail ? `${why}: ${detail}` : why));
          return;
        }
        resolve(stdout.toString());
      });
    child.stdin?.end(input); // always close stdin; without this some CLIs wait for it
  });
}

/** Pull the plain text out of the many message-content shapes the harnesses use. */
export function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (['text', 'output_text', 'input_text'].includes(part.type)) return part.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

// How much of the agent's last reply a card carries (the card shows its end; a tap shows all of it).
export const REPLY_MAX = 3000;

export function clip(text, max = 600) {
  const t = (text || '').replace(/\s+\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The END of a long text (where an agent's question usually is), starting at a paragraph or sentence, "…" when cut. */
export function clipTail(text, max = 600) {
  const t = (text || '').replace(/[ \t]+\n/g, '\n').trim();
  if (t.length <= max) return t;
  let tail = t.slice(t.length - (max - 1));
  // Start cleanly: at a paragraph break if one is near the front, else after the first sentence end or line break.
  const para = tail.indexOf('\n\n');
  const sentence = tail.search(/[.!?]\s|\n/);
  const cut = para !== -1 && para < tail.length * 0.4 ? para : (sentence !== -1 && sentence < tail.length * 0.4 ? sentence + 1 : -1);
  if (cut !== -1) tail = tail.slice(cut);
  return `…${tail.trim()}`;
}

const LIST_LINE = /^\s*(?:\d+[.)]|[A-Za-z][.)]|[-•*])\s+\S/;
// A one-line pointer to a file or link: a short label, a colon, then a single path, `code` or URL ("Review: `x.md`").
const POINTER = /^[^\n:]{1,30}:\s*(?:`[^`\n]+`|\S*[/.]\S*)$/;

// A sign-off: one line with no question, short, or up to ~120 chars right after a question ("Let me know if…").
const isSignOff = (p, prev) => !p.includes('\n') && !p.includes('?')
  && (p.length <= 40 || (p.length <= 120 && prev.trimEnd().endsWith('?')));

/** Normalised text with trailing code blocks and ONE closing sign-off peeled off, in any order. */
function peelTail(text) {
  let t = (text || '').replace(/[ \t]+\n/g, '\n').trim();
  let signOffDone = false;
  for (let changed = true; changed;) {
    changed = false;
    while (t.endsWith('```')) {
      const open = t.lastIndexOf('```', t.length - 4);
      if (open === -1) break;
      t = t.slice(0, open).trim();
      changed = true;
    }
    const ps = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (!signOffDone && ps.length > 1 && isSignOff(ps[ps.length - 1], ps[ps.length - 2])) {
      t = t.slice(0, t.lastIndexOf(ps[ps.length - 1])).trim();
      signOffDone = true;
      changed = true;
    }
  }
  return t;
}

/**
 * The last thing the agent said that matters: its last paragraph, skipping a trailing code block and a short
 * sign-off ("Let me know!"), with the line introducing a trailing list. Clipped from the front to `max`.
 */
export function replyEnd(text, max = 320) {
  if (!(text || '').trim()) return '';
  const t = peelTail(text);
  if (!t) return clipTail(text, max);
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // A closing "Review: `docs/x.md`" line is a pointer to a file; the message is the paragraph above it.
  while (paras.length > 1 && POINTER.test(paras[paras.length - 1])) paras.pop();
  let end = paras[paras.length - 1];
  // A list on its own: bring along the line that introduces it.
  if (paras.length > 1 && end.split('\n').every((l) => LIST_LINE.test(l))) {
    const intro = paras[paras.length - 2].split('\n').pop();
    end = `${intro}\n${end}`;
  }
  return clipTail(end, max);
}

// An attachment line agents add after their message, e.g. "Updated plan: MEDIA:/Users/you/…/plan.md".
const ATTACHMENT = /^[^\n]{0,80}\bMEDIA:\S+$/;
// Words that say a list is something to answer: after it ("Once you've answered these…") or introducing it.
const ANSWER_REF = /\b(answer(ed)?|these|decide|pick|choose|let me know|your call|confirm)\b/i;
const NEEDS = /\b(questions?|decide|decisions?|need from you|confirm|choose|pick)\b/i;

// A list of questions or decisions is kept whole on the card, up to this many characters.
const LIST_MAX = 1500;

/**
 * The separate decisions in a list the agent asks you to answer: [{ n, label, text }], where `n` is the item's
 * number or letter, `label` a short name for it (its bold lead "**Commit.**", else its opening words) and `text` the
 * whole item (lines that continue it included). Empty unless there are at least two items.
 */
export function decisionsOf(ask) {
  const items = [];
  for (const line of String(ask || '').split('\n')) {
    const m = /^\s*(\d+|[A-Za-z])[.)]\s+(\S.*)$/.exec(line);
    if (m) items.push({ n: m[1], text: m[2].trim() });
    else if (items.length && line.trim()) items[items.length - 1].text += `\n${line.trim()}`;
  }
  if (items.length < 2) return [];
  return items.map(({ n, text }) => ({ n, label: decisionLabel(text), text }));
}

function decisionLabel(text) {
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  if (bold) return bold[1].replace(/[.:]$/, '').trim();
  const first = text.split('\n')[0].replace(/[`*_]/g, '');
  const words = first.split(/\s+/);
  return words.length <= 6 ? first : `${words.slice(0, 6).join(' ')}…`;
}

/** True when the text has a sentence ending in "?" outside links and inline code. */
function asksQuestion(text) {
  const plain = String(text).replace(/https?:\/\/\S+/g, ' ').replace(/`[^`]*`/g, ' ');
  return /\?(?=$|[\s"'”’*)\]])/.test(plain);
}

/** A long paragraph with a question, starting at the sentence before its first question so the ask is visible. */
function questionFocus(p, max) {
  if (p.length <= 200) return clipTail(p, max);
  const sentences = p.match(/[^.!?]+[.!?]+["”’*)\]]*\s*|[^.!?]+$/g) || [p];
  const first = sentences.findIndex((x) => x.includes('?'));
  const start = Math.max(0, first - 1);
  const out = sentences.slice(start).join('').trim();
  return clipTail(start > 0 ? `…${out}` : out, max);
}

/**
 * What the agent is asking you, if anything, from near the end of its reply (last 3 paragraphs, after peeling
 * code, sign-offs and attachment lines): the last paragraph with a "?", or a list of points it asks you to answer.
 * Empty when the reply asks nothing.
 */
export function askOf(text, max = 420) {
  const paras = peelTail(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  while (paras.length && ATTACHMENT.test(paras[paras.length - 1])) paras.pop();
  const n = paras.length;
  for (let i = n - 1; i >= Math.max(0, n - 3); i--) {
    const p = paras[i];
    if (p.startsWith('```')) continue;
    // A real question: a sentence ending in "?" once links and inline code are set aside (a "?" in a URL or in
    // `foo?.bar` is not one), in the last paragraph, or the one before a short closing line.
    const lines = p.split('\n');
    const isList = lines.filter((l) => LIST_LINE.test(l)).length >= 2;
    // A list keeps its intro line ("Two things to decide:") and every item, so no decision is cut off.
    const intro = LIST_LINE.test(lines[0]) ? (i > 0 ? paras[i - 1].split('\n').pop() : '') : lines[0];
    const wholeList = () => clip(LIST_LINE.test(lines[0]) && intro ? `${intro}\n${p}` : p, LIST_MAX);
    if (asksQuestion(p)) {
      const closing = paras.slice(i + 1);
      // A closing line counts only when it talks to you or looks ahead ("Once you approve, I'll…"), not when it
      // reports more work done ("I fixed it and pushed."), which means the question above was rhetorical.
      const talksToYou = (l) => l.length <= 160 && /\b(you|your|once|when|until|I'll|I will|let me know)\b/i.test(l);
      if (!closing.length || (closing.length === 1 && talksToYou(closing[0]))) return isList ? wholeList() : questionFocus(p, max);
      continue;
    }
    if (isList) {
      const after = i + 1 < n ? paras[i + 1] : '';
      if (ANSWER_REF.test(after) || NEEDS.test(intro)) return wholeList();
    }
  }
  return '';
}

/**
 * The paragraph that a short question points back to ("Are you comfortable with that approach?" after a
 * recommendation): the paragraph before the question, skipping code blocks. Empty when the question is long
 * enough to stand on its own (over 120 chars) or nothing comes before it.
 */
export function askContext(text, ask, max = 400) {
  const q = (ask || '').trim();
  if (!q || q.length > 120 || q.includes('\n')) return '';
  const paras = peelTail(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const at = paras.findLastIndex((p) => p.includes(q));
  for (let i = at - 1; i >= 0; i--) {
    if (paras[i].startsWith('```') || paras[i].endsWith('```')) continue;
    return clip(paras[i], max);
  }
  return '';
}

/**
 * The conversation BEFORE the agent's last reply, oldest first, for a card that needs you: [{ role, text }] with
 * role 'you' or 'agent'. `msgs` is the chat oldest first in the same shape. The agent's in-between notes within a
 * turn ("Let me look.") shrink to its last message of that turn; empty and system-injected messages are skipped.
 * The most recent turns win, within `budget` characters; a long agent turn keeps its end, a long message of yours
 * its start.
 */
export function earlierTurns(msgs, budget = 2400) {
  const turns = [];
  for (const m of msgs || []) {
    const text = (m.text || '').trim();
    if (!text || (m.role === 'you' && isSyntheticPrompt(text))) continue;
    if (m.role === 'agent' && turns.at(-1)?.role === 'agent') turns[turns.length - 1] = { role: 'agent', text };
    else turns.push({ role: m.role, text });
  }
  const last = turns.findLastIndex((t) => t.role === 'agent');
  const out = [];
  let left = budget;
  for (let i = last - 1; i >= 0 && left > 40; i--) {
    const room = Math.min(left, TURN_MAX);
    const text = turns[i].role === 'agent' ? clipTail(turns[i].text, room) : clip(turns[i].text, room);
    out.unshift({ role: turns[i].role, text });
    left -= text.length;
  }
  return out;
}
const TURN_MAX = 700;

// Words that hand something to you: a request, a choice or approval waiting on you, or work ready for you to check.
const REQUEST = /\b(please|can you|could you|would you|will you|let me know|tell me|(?:we|i) (?:still )?need (?:the|a|an|your)|(?:holding|waiting|paused|parked)\b[^.]{0,60}\bfor your|your (call|choice|decision|approval|go-ahead|review|answer|input|ok|okay|sign-off)|(awaiting|waiting (on|for)) (you|your)|needs? (you|your)|once you|when you(?:'re| are)? ready|if you (want|approve|agree|prefer|'d like)|you (need|have) to|you should|you'll need|ready for (?:\w+ ){0,2}review|for you to|approve|confirm|decide|pick one|choose)\b/i;

/**
 * True when the end of the agent's reply (its last three paragraphs, after code blocks and a sign-off) asks you to
 * do, decide or check something. False for a plain status report ("Started the release candidate. It is running.").
 * Errs toward true: a request missed would hide work that needs you.
 */
export function asksOwner(text) {
  const paras = peelTail(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const end = paras.slice(-3).join('\n\n');
  // A request, work handed over to look at ("Review this local file"), or a go-ahead asked for.
  return REQUEST.test(end) || CHECK.test(end) || APPROVAL.test(end);
}

// Work handed over to look at: a page, a draft, a build.
const CHECK = /\b(ready for (?:\w+ ){0,2}review|for your (?:\w+ ){0,1}(?:feedback|review|look)|(?:take|have) a look|(?:can|could|would) you (?:review|check|look)|please (?:review|check|look)|review (?:it|this|the \w+)|(?:visual|design|final) review|preview (?:is )?(?:ready|up|live))\b/i;
// A go-ahead asked for (not "publishing remains a separate approval", which is about later). Also a question that
// starts with Approve ("Approve enabling the proxy and restarting the gateway?"), "Approve running …", "do you
// approve", "this needs / requires approval" and "next gate: approval".
const APPROVAL = /\b(your (?:go-ahead|approval|sign-off|ok|okay)|approve (?:it|this|the \w+|\w+ing)|(?:ok|okay) to (?:proceed|go|ship|deploy|push|merge|run)|shall i (?:proceed|go ahead)|should i (?:proceed|go ahead)|(?:do|would|will|can) you approve|(?:needs?|requires?|requesting) (?:your |explicit )?approval|gate: approval)\b|(?:^|[.!?]\s+)approve\b[^.?!]*\?/im;

/**
 * What a Review card hands you, from the end of the agent's reply: 'check' (work to look at), 'approval' (a go-ahead
 * asked for) or 'request' (anything else asked of you). Decides the card's first button: Review, Approve or Reply.
 * Work to look at wins: "ready for visual review; publishing remains a separate approval" is a check.
 */
export function reviewKind(text) {
  const end = peelTail(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).slice(-3).join('\n\n');
  if (CHECK.test(end)) return 'check';
  if (APPROVAL.test(end)) return 'approval';
  return 'request';
}

/** True for injected/system text that is not something the human actually typed. */
export function isSyntheticPrompt(text) {
  const t = (text || '').trimStart();
  return !t || t.startsWith('<') || t.startsWith('# AGENTS.md') || t.startsWith('Caveat:');
}

/** Read roughly the last `bytes` of a file and return its complete lines. */
export async function tailLines(file, bytes = 1_500_000) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } finally {
    await fh.close();
  }
}

export async function headLine(file, bytes = 64_000) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8').split('\n')[0];
  } finally {
    await fh.close();
  }
}

export function parseJsonLines(lines) {
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Map with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One status rule for every lane.
 *  working: a turn is running right now
 *  done:    the session ended / finished one-shot run
 *  waiting: the agent spoke last, recently — the ball is in your court
 *  idle:    open but quiet
 */
export function classify({ running, ended, agentSpokeLast, lastActivity }, cfg) {
  if (running) return { status: 'working', waitingSince: null };
  if (ended) return { status: 'done', waitingSince: null };
  if (agentSpokeLast && Date.now() - lastActivity < cfg.waitWindowMs) return { status: 'waiting', waitingSince: lastActivity };
  return { status: 'idle', waitingSince: null };
}
