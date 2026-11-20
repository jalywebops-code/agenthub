// tmux bridge: finds Claude Code / Codex processes running inside tmux panes, reads the
// pane's screen, and types into it. Only panes that tmux reports are ever touched.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from './util.js';
import { processTable, namesOf, envVarOf, loginShell } from './platform.js';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => fs.existsSync(p)) || 'tmux';

// tmux escapes tabs and non-ASCII (like the ❯ menu marker) unless it runs in a UTF-8 locale.
// launchd starts the board with no locale, so set one explicitly.
// A UTF-8 locale every system has: en_US.UTF-8 on macOS; C.UTF-8 on Linux, where en_US may not be installed.
const UTF8 = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
const TMUX_ENV = { ...process.env, LANG: UTF8, LC_ALL: UTF8 };
const SEP = '|#|';

// Tests swap in a recorder (_setTmux), so no test ever sends keys to a real pane.
const realTmux = (args, timeoutMs) => run(TMUX, args, { timeoutMs, env: TMUX_ENV });
let runTmux = realTmux;
export function _setTmux(fn) { runTmux = fn || realTmux; }

function tmux(args, timeoutMs = 5000) {
  return runTmux(args, timeoutMs);
}

/** All panes, or [] when no tmux server is running. */
export async function listPanes() {
  let out;
  try {
    out = await tmux(['list-panes', '-a', '-F', ['#{pane_id}', '#{pane_pid}', '#{session_name}:#{window_index}.#{pane_index}', '#{pane_current_path}'].join(SEP)]);
  } catch (e) {
    if (/no server running|error connecting|No such file/i.test(e.message)) return [];
    throw e;
  }
  return out.trim().split('\n').filter(Boolean).map((line) => {
    const [paneId, pid, target, ...rest] = line.split(SEP);
    const cwd = rest.join(SEP);
    return { paneId, pid: Number(pid), target, cwd };
  });
}

// Every process and its parent (lib/platform.js knows the macOS and Linux ways), to tell which pane a process lives in.

/**
 * Returns Map(pid -> pane) for every process that is a pane's shell or one of its descendants.
 * Lanes look up their own agent pids in it.
 */
export async function paneOwners() {
  const panes = await listPanes();
  if (!panes.length) return new Map();
  const procs = await processTable();
  const byPanePid = new Map(panes.map((p) => [p.pid, p]));
  const owners = new Map();
  for (const pid of procs.keys()) {
    let cur = pid;
    for (let hops = 0; hops < 12 && cur > 1; hops++) {
      if (byPanePid.has(cur)) { owners.set(pid, byPanePid.get(cur)); break; }
      cur = procs.get(cur)?.ppid;
      if (!cur) break;
    }
  }
  return owners;
}

/** Pids whose executable name matches (e.g. "codex"), with their command name. */
export async function pidsNamed(re) {
  const procs = await processTable();
  return [...procs.entries()].filter(([, p]) => namesOf(p).some((n) => re.test(n))).map(([pid]) => pid);
}

/**
 * Whether pressing Esc on this menu only declines it (a question tool, a plan approval, or a permission menu whose
 * "No, and tell … differently (esc)" row says so). Never when an option exits or quits: on the folder-trust menu
 * ("No, exit") Esc quits the agent.
 */
export function escSafe(prompt) {
  if (!prompt || prompt.unsupported) return false;
  const rows = prompt.labels || prompt.options || [];
  if (rows.some((o) => /\b(exit|quit)\b/i.test(o))) return false;
  return prompt.freeText !== -1 || !!prompt.planApproval || !!prompt.escTellsWhy;
}

/** The command a pane is running now (e.g. "claude", or "zsh" once the agent has quit). */
export async function paneCommand(paneId) {
  return (await tmux(['display-message', '-p', '-t', paneId, '#{pane_current_command}'])).trim();
}

/** The CLAUDE_CONFIG_DIR a process was started with ('' when unset), read from its environment (own user only). */
export async function configDirOf(pid) {
  return envVarOf(pid, 'CLAUDE_CONFIG_DIR');
}

/** True when a process's CLAUDE_CONFIG_DIR is one of a lane's folders. Unset means Claude Code's default, ~/.claude. */
export function ownsConfigDir(dirOfProcess, laneDirs, home) {
  const norm = (d) => path.resolve(String(d)).replace(/\/+$/, '');
  const dir = norm(dirOfProcess || path.join(home, '.claude'));
  return laneDirs.some((d) => norm(d) === dir);
}

export async function capture(paneId, lines = 60) {
  const out = await tmux(['capture-pane', '-p', '-J', '-t', paneId, '-S', `-${lines}`]);
  return out.replace(/\s+$/g, '');
}

/**
 * Detect a selection menu (permission, trust, command approval) near the bottom of the pane.
 * Menus look like:
 *     Do you want to create hello.txt?          ❯ No, exit
 *     ❯ 1. Yes                                    Yes, I trust this folder
 *       2. Yes, allow all edits this session      Enter to confirm · Esc to cancel
 *       3. No, and tell Claude what to do differently (esc)
 * Returns { text, options, selected, yes, escTellsWhy } or null.
 *   options:     option labels without numbers
 *   selected:    index of the highlighted option
 *   yes:         index of the first option starting with "Yes" (-1 if none)
 *   escTellsWhy: Esc means "No, and tell the agent what to do differently"
 */
export function detectPrompt(screen) {
  const parsed = parseMenu(screen);
  if (parsed) return parsed;
  // Safety net: the screen's own footer says a menu is open but its layout can't be read (e.g. the highlight is on
  // "Next", "Submit" or "Chat about this"). It still counts as a menu, so nothing is ever typed into it.
  // The footer is always the bottom line or two of a live menu.
  const tail = screen.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3);
  if (!tail.some((l) => MENU_FOOTER.test(l))) return null;
  const text = screen.split('\n').map((l) => l.trim()).filter(Boolean).slice(-15).join('\n');
  return { text, question: '', options: [], labels: [], multi: false, ticked: [], planApproval: false, review: '',
    selected: -1, yes: -1, escTellsWhy: false, unsupported: "a menu layout the board can't read", freeText: -1, request: null };
}

const FREE_TEXT_LABEL = /^(Type something|Tell Claude what to change)/i;
const MENU_FOOTER = /Enter to (select|confirm)|Press enter to (confirm|continue)|enter to submit answer/i;

function parseMenu(screen) {
  const lines = screen.split('\n').map((l) => l.replace(/[│╭╮╰╯]/g, ' ').replace(/\s+$/, '')).slice(-60);
  let sel = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[❯›]\s+\S/.test(lines[i])) { sel = i; break; }
  }
  if (sel === -1) return null;
  const textCol = lines[sel].search(/[❯›]\s+\S/) + lines[sel].slice(lines[sel].search(/[❯›]/) + 1).search(/\S/) + 1;
  const FOOTER = /^\s*(Enter to|Esc to|Press enter|Press esc|↑|←)/i;
  const isOption = (l) => l.trim() && !FOOTER.test(l)
    && (/^\s*[❯›]\s/.test(l) || (l.search(/\S/) === textCol));
  // A line indented deeper than the options is the description of the option above it (Claude's question menus).
  const isDescription = (l) => l.trim() && !FOOTER.test(l) && !/^\s*[─╌]+\s*$/.test(l) && l.search(/\S/) > textCol;
  let first = sel;
  for (let i = sel - 1; i >= 0; i--) {
    if (isOption(lines[i])) first = i;
    else if (!isDescription(lines[i])) break;
  }
  let last = sel;
  for (let i = sel + 1; i < lines.length; i++) {
    if (isOption(lines[i]) || isDescription(lines[i])) last = i;
    else break;
  }
  // A live menu sits at the bottom of the screen: at most a few lines (footer, "Chat about this") below its last row
  // and never the agent's input box. Older menu-looking lines (your own numbered prompt, a menu an agent printed
  // in its reply, an answered menu in scrollback) are not a live menu.
  const below = lines.slice(last + 1).filter((l) => l.trim());
  if (below.length > 6 || below.some((l) => /^\s*[❯›]\s*$/.test(l))) return null;
  const block = lines.slice(first, last + 1);
  const optionRows = [];
  for (let i = first; i <= last; i++) if (isOption(lines[i])) optionRows.push(i);
  const raw = optionRows.map((i) => lines[i]);
  const options = raw.map((l) => l.replace(/^\s*[❯›]?\s*/, '').replace(/^\d+[.)]\s+/, '').trim());
  if (options.length < 2) return null; // a lone "❯" is the normal input prompt, not a menu
  const yes = options.findIndex((o) => /^yes\b/i.test(o));
  const no = options.findIndex((o) => /^no\b/i.test(o));
  // Any numbered list with a highlight is a menu too (e.g. Codex's "Update now / Skip" screen).
  // Treating it as an input box would type text and press Enter on whatever option is highlighted.
  const numbered = raw.filter((l) => /^\s*[❯›]?\s*\d+[.)]\s+\S/.test(l)).length >= 2;
  if (yes === -1 && no === -1 && !numbered) return null;
  const aboveStart = Math.max(0, first - 10);
  const above = lines.slice(aboveStart, first).filter((l) => l.trim() && !/^\s*[─╌]+\s*$/.test(l));
  const cut = lines.slice(0, aboveStart).some((l) => l.trim());
  const footer = lines.slice(last + 1, last + 3).filter((l) => FOOTER.test(l) || /Enter to|Esc to/.test(l));
  const question = (above[above.length - 1] || '').trim();
  // Esc safely means "no, and let me say what to do instead" when the menu says so outright
  // (older style), or on a "Do you want to…?" permission question whose footer offers Esc.
  // Never on menus where Esc/No would quit (e.g. the folder-trust menu's "No, exit").
  const escTellsWhy = options.some((o) => /^no\b.*(differently|tell)/i.test(o) && /\(esc\)/i.test(o))
    || (/^(Do you want|Would you like)/i.test(question) && footer.some((l) => /Esc to cancel/i.test(l))
      && !options.some((o) => /\bexit\b/i.test(o)));
  const text = [cut ? '… (earlier lines cut — the full screen is shown before you confirm)' : '', ...above, ...block, ...footer]
    .map((l) => l.trim()).filter(Boolean).join('\n');
  // Update screens (e.g. Codex's "Update now (runs npm install -g …)") are never answered from the board.
  const updateMenu = /update available/i.test(text) || options.some((o) => /^(update|upgrade) now\b|npm install -g|brew upgrade/i.test(o));
  let unsupported = updateMenu ? 'update menu; updates are never run from the board' : '';
  // Pick-several rows start with a tick box; labels drop the box and any same-line description (Codex: 2+ spaces).
  const BOX = /^\[[ x✔✓×]\]\s*/i;
  const multi = options.some((o) => BOX.test(o));
  const ticked = options.map((o) => /^\[[x✔✓]\]/i.test(o));
  const labels = options.map((o) => o.replace(BOX, '').split(/\s{2,}/)[0].trim());
  // Rows that take your own words, typed into the row itself: Claude's "Type something." and, on its plan
  // approval, "Tell Claude what to change".
  // Only a row literally labelled as one; never guessed by position.
  const freeText = labels.findIndex((o) => FREE_TEXT_LABEL.test(o));
  // A question menu (Claude's tool, "Chat about this" below it) or Claude's plan approval whose answer row shows
  // something else has text already typed into that row: don't guess, answer it in the terminal.
  const claudePlan = labels.some((o) => /use auto mode|manually approve edits/i.test(o));
  if (!unsupported && freeText === -1 && (claudePlan || /Chat about this/.test(lines.slice(last + 1, last + 4).join('\n')))) {
    unsupported = "something is already typed into this menu's answer row";
  }
  // Plan approvals (Claude: "ready to execute… proceed?"; Codex: "Implement this plan?"): every choice matters, so
  // they are answered with their own buttons and never by Approve.
  const planApproval = /ready to execute|implement this plan\?/i.test(question)
    || labels.some((o) => /use auto mode|manually approve edits|stay in plan mode/i.test(o));
  // The review screen at the end of a question set: its question shows the answers given.
  const reviewAt = above.findIndex((l) => /Review your answers/i.test(l));
  const review = reviewAt === -1 ? '' : above.slice(reviewAt).map((l) => l.trim()).join('\n');
  const request = approvalRequest(lines, first);
  return { text, question, options, labels, multi, ticked, planApproval, review, selected: optionRows.indexOf(sel), yes,
    escTellsWhy, unsupported, freeText, request };
}

const ASK_LINE = /^(would you like|do you want)\b/i;
const BOUNDARY = /^\s*([─╌]{3,}|[•⏺])/;
const tidyLines = (arr) => arr.map((l) => l.trim()).filter((l) => l && !/^[─╌]+$/.test(l));

/**
 * For a permission menu (Claude Code's dialog or Codex's "Would you like to run the following command?"): the
 * question and the details (the command, the reason), for the card. The command comes from the agent, so nothing it
 * could steer is trusted as structure (see claudeRequest and codexRequest). Anything unexpected returns null and the
 * card shows the raw screen (the confirm sheet always shows the full screen before anything is pressed).
 */
function approvalRequest(lines, first) {
  return claudeRequest(lines, first) || codexRequest(lines, first);
}

/**
 * Claude Code's permission dialog: a separator at the left edge, a header ("Bash command", "Edit file", …), the
 * command or file indented under it, then "Do you want to …?" just above the options. Everything the agent supplies
 * is indented deeper than the header, so it can't plant the separator, the header or the question; a separator or
 * question line anywhere in between means the screen isn't what it seems, and the card shows the raw screen.
 */
function claudeRequest(lines, first) {
  let qAt = first - 1;
  while (qAt >= 0 && !lines[qAt].trim()) qAt--;
  if (qAt < 0 || !ASK_LINE.test(lines[qAt].trim()) || indent(lines[qAt]) > 2) return null;
  let sepAt = -1;
  for (let i = qAt - 1; i >= Math.max(0, qAt - 60); i--) {
    if (/^\s{0,1}[─╌]{20,}\s*$/.test(lines[i])) { sepAt = i; break; }
  }
  if (sepAt === -1) return null;
  let headAt = sepAt + 1;
  while (headAt < qAt && !lines[headAt].trim()) headAt++;
  const header = (lines[headAt] || '').trim();
  if (headAt >= qAt || indent(lines[headAt]) > 2 || header.length > 60 || ASK_LINE.test(header)) return null;
  const between = lines.slice(headAt + 1, qAt);
  if (between.some((l) => l.trim() && (indent(l) <= indent(lines[headAt]) || BOUNDARY.test(l) || ASK_LINE.test(l.trim())))) return null;
  const detail = tidyLines(between);
  return { ask: lines[qAt].trim(), detail: [header, ...detail].join('\n').slice(0, 2000) };
}
const indent = (l) => l.search(/\S/);

/**
 * Codex's approval menu: exactly one question line in the whole 40-line window, anchored to Codex's own "• Running"
 * header, and no tool, separator or question lines between it and the options.
 */
function codexRequest(lines, first) {
  const top = Math.max(0, first - 40);
  const asks = [];
  for (let i = top; i < first; i++) if (ASK_LINE.test(lines[i].trim())) asks.push(i);
  if (asks.length !== 1) return null;
  const askAt = asks[0];
  // Anchor to Codex's own header: the nearest line above the question is its "• Running …" line at column 0.
  // Agent text (the command, the reason) is always indented, so it can't fake this.
  let prev = askAt - 1;
  while (prev >= 0 && !lines[prev].trim()) prev--;
  if (prev < 0 || !/^•/.test(lines[prev])) return null;
  const between = lines.slice(askAt + 1, first);
  if (between.some((l) => BOUNDARY.test(l))) return null;
  const detail = tidyLines(between);
  if (!detail.length) return null;
  return { ask: lines[askAt].trim(), detail: detail.join('\n').slice(0, 2000) };
}

/** The text of the currently highlighted row: the bottom-most line that starts with the cursor (❯ / ›). */
export function cursorRow(screen) {
  const rows = String(screen).split('\n').filter((l) => /^\s*[❯›]/.test(l));
  return rows.length ? rows[rows.length - 1].replace(/^\s*[❯›]\s*/, '').trim() : '';
}

/**
 * Paste text into a pane as one bracketed paste, through a buffer of its own (two sends at once never swap texts).
 * Control characters other than line breaks and tabs are dropped: an escape sequence could end the paste early and
 * turn the rest into keystrokes.
 */
async function paste(paneId, text) {
  const buffer = `agenthub-${randomUUID()}`;
  await tmux(['set-buffer', '-b', buffer, '--', String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')]);
  await tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', paneId]);
}

/** Type text into the pane as one paste (multi-line safe), then press Enter. */
export async function typeAndSubmit(paneId, text) {
  await paste(paneId, text);
  await new Promise((r) => setTimeout(r, 400));
  await tmux(['send-keys', '-t', paneId, 'Enter']);
}

const SHELLS = /^-?(zsh|bash|sh|dash|fish|ksh|tcsh|csh|login)$/;
/** Refuse to type when the pane is back at a shell (the agent quit): the text would run as a command. */
async function agentStillThere(paneId) {
  if (SHELLS.test(await paneCommand(paneId))) {
    throw new Error('The agent is no longer running in that terminal (it is back at a shell), so nothing was typed. Check the terminal.');
  }
}

export async function pressKey(paneId, key) {
  await tmux(['send-keys', '-t', paneId, key]);
}

/**
 * Carry out a board action on a pane, re-reading the screen first so we never type into a
 * menu we didn't show the user (or press menu keys when there's no menu).
 *  approve: on a menu → move the highlight to the "Yes" option, then Enter; otherwise type the approval text
 *  changes: on a menu → only if it offers "No, and tell … what to do differently (esc)": Esc, then type
 *  reply:   refused while a menu is up; otherwise type the text
 */
const normalize = (t) => String(t || '').replace(/\s+/g, ' ').trim();

// Tests swap in a fake screen reader; the board always uses capture().
let readScreen = capture;
export function _setCapture(fn) { readScreen = fn || capture; }

/** Move the highlight from the selected option to `target`, re-read, and return true only if it landed there. */
async function moveTo(paneId, prompt, target) {
  const steps = target - prompt.selected;
  for (let i = 0; i < Math.abs(steps); i++) {
    await pressKey(paneId, steps > 0 ? 'Down' : 'Up');
    await new Promise((r) => setTimeout(r, 120));
  }
  const check = detectPrompt(await readScreen(paneId));
  return !!check && check.selected === target;
}

// One action at a time per pane: two at once could interleave their keys.
const paneQueues = new Map();
export function act(paneId, request) {
  const next = (paneQueues.get(paneId) || Promise.resolve()).catch(() => {}).then(() => actNow(paneId, request));
  paneQueues.set(paneId, next);
  next.catch(() => {}).finally(() => { if (paneQueues.get(paneId) === next) paneQueues.delete(paneId); });
  return next;
}

async function actNow(paneId, { kind, message, expectPrompt, expectText, index, indexes }) {
  const prompt = detectPrompt(await readScreen(paneId));
  if (!!prompt !== !!expectPrompt) {
    throw new Error(prompt
      ? 'An approval menu just appeared on that session. Refresh and look at it before acting.'
      : 'The approval menu is gone (answered or timed out). Refresh first.');
  }
  // Only answer the exact menu the user was shown; if the agent swapped in a different
  // request since then, do nothing.
  if (prompt && normalize(prompt.text) !== normalize(expectText)) {
    throw new Error('The menu on screen changed since you looked. Nothing was pressed. Refresh and check it again.');
  }
  if (!prompt) {
    await agentStillThere(paneId);
    return typeAndSubmit(paneId, message);
  }
  if (kind === 'defer') {
    // Leave the menu with Esc (it declines the question or the request), wait until it is really gone, then say why.
    if (prompt.unsupported) throw new Error(`This menu can't be answered from the board (${prompt.unsupported}). Answer it in the terminal.`);
    if (!escSafe(prompt)) throw new Error("This menu can't be left safely from the board (Esc could quit the agent). Answer it in the terminal.");
    await pressKey(paneId, 'Escape');
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (!detectPrompt(await readScreen(paneId))) {
        // The agent must still be the one running, so the message goes into its input box and never into a shell.
        if (SHELLS.test(await paneCommand(paneId))) throw new Error('The agent quit when the menu closed, so nothing was typed. Check the terminal.');
        return typeAndSubmit(paneId, message);
      }
    }
    throw new Error('Could not leave the menu, so nothing was sent. Answer it in the terminal.');
  }
  if ((kind === 'approve' || kind === 'changes') && prompt.unsupported) {
    throw new Error(`This menu can't be answered from the board (${prompt.unsupported}). Answer it in the terminal.`);
  }
  if (kind === 'approve') {
    if (prompt.planApproval) throw new Error('This is a plan approval: pick one of the plan options on the card.');
    if (prompt.freeText !== -1) throw new Error('This is a question, not a permission prompt. Use the option buttons on the card.');
    if (prompt.yes === -1) throw new Error('This menu has no "Yes" option. Answer it in the terminal.');
    if (!(await moveTo(paneId, prompt, prompt.yes))) {
      throw new Error('Could not move the highlight to "Yes" safely. Nothing was confirmed; answer it in the terminal.');
    }
    return pressKey(paneId, 'Enter');
  }
  if (kind === 'choose' && prompt.multi) throw new Error('This is a pick-several question: use the tick boxes on the card.');
  if (kind === 'type') {
    if (prompt.unsupported) throw new Error(`This menu can't be answered from the board (${prompt.unsupported}).`);
    if (index !== prompt.freeText || prompt.freeText === -1) throw new Error('Typed answers only go into the free-text row.');
    if (!(await moveTo(paneId, prompt, index))) throw new Error('Could not reach the free-text row safely. Nothing was sent; answer it in the terminal.');
    // Fresh read: the highlighted row must still be the labelled free-text row before anything is pasted.
    const here = detectPrompt(await readScreen(paneId));
    if (!here || here.selected !== index || here.freeText !== index || here.unsupported) {
      throw new Error('The free-text row is not highlighted as expected. Nothing was typed; answer it in the terminal.');
    }
    // One line of plain text: no control characters or line breaks (Enter would submit early).
    message = String(message || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!message) throw new Error('Type your answer first.');
    await paste(paneId, message);
    await new Promise((r) => setTimeout(r, 500));
    // The text shows inside the row before Enter; check it landed there and nowhere else.
    const typed = detectPrompt(await readScreen(paneId));
    const start = normalize(message).slice(0, 24);
    if (!typed || typed.selected !== index || !normalize(typed.labels[index]).startsWith(start)) {
      throw new Error('The answer did not appear in the menu row as expected, so Enter was not pressed. Check the terminal.');
    }
    return pressKey(paneId, 'Enter');
  }
  if (kind === 'multi') {
    if (prompt.unsupported || !prompt.multi) throw new Error('This is not a pick-several question. Refresh.');
    const want = new Set(indexes || []);
    if (!want.size || [...want].some((i) => !Number.isInteger(i) || i < 0 || i >= prompt.labels.length)) throw new Error('That choice is not on the menu any more. Refresh.');
    if (want.has(prompt.freeText)) throw new Error('The free-text row is not on the menu for ticking from the board.');
    let state = prompt;
    for (let i = 0; i < prompt.labels.length; i++) {
      if (i === prompt.freeText || state.ticked[i] === want.has(i)) continue;
      if (!(await moveTo(paneId, state, i))) throw new Error('Could not move to that choice safely. Answer it in the terminal.');
      await pressKey(paneId, 'Enter');
      await new Promise((r) => setTimeout(r, 300));
      state = detectPrompt(await readScreen(paneId));
      if (!state || state.ticked[i] !== want.has(i)) throw new Error('A tick box did not change as expected. Check the terminal before going on.');
    }
    // The unnumbered "Submit" row sits right below the last row; Enter there opens the review screen.
    const steps = state.labels.length - state.selected;
    for (let n = 0; n < steps; n++) { await pressKey(paneId, 'Down'); await new Promise((r) => setTimeout(r, 120)); }
    // "Submit" for a single question, "Next" inside a question set.
    // Only the current highlight counts (an old "❯ Next" higher up in the scrollback must not).
    if (!/^(Submit|Next)$/.test(cursorRow(await readScreen(paneId)))) throw new Error('Could not reach Submit safely. Your ticks are set; submit in the terminal.');
    return pressKey(paneId, 'Enter');
  }
  if (kind === 'choose') {
    const why = prompt.unsupported
      || (index === prompt.freeText ? 'it asks you to type an answer' : '')
      || (Number.isInteger(index) && index >= 0 && index < prompt.options.length ? '' : 'no option with that number');
    if (why) throw new Error(`This menu can't be answered from the board (${why}). Answer it in the terminal.`);
    if (!(await moveTo(paneId, prompt, index))) {
      throw new Error('Could not move the highlight to that option safely. Nothing was chosen; answer it in the terminal.');
    }
    return pressKey(paneId, 'Enter');
  }
  if (kind === 'changes') {
    if (!prompt.escTellsWhy) throw new Error('This menu has no "tell it what to do differently" option. Answer it in the terminal.');
    await pressKey(paneId, 'Escape');
    await new Promise((r) => setTimeout(r, 800));
    return typeAndSubmit(paneId, message);
  }
  throw new Error('This session is showing an approval menu. Use Approve or Request changes.');
}

/** A tmux session name that is free, based on `base` (tmux names can't contain '.' or ':'). */
export async function freeSessionName(base) {
  const clean = base.replace(/[.:\s]+/g, '-').replace(/[^\w-]/g, '').slice(0, 40) || 'agent';
  const taken = new Set((await listPanes()).map((p) => p.target.split(':')[0]));
  let name = clean;
  for (let n = 2; taken.has(name); n++) name = `${clean}-${n}`;
  return name;
}

/**
 * The login shell for new sessions, only when it quotes the POSIX way (the first message is quoted for it, and may
 * hold agent-written text): sh, bash, zsh, dash or ksh. Any other (fish, csh…) reads the quoting differently, so
 * /bin/sh is used instead.
 */
export function posixShell(shell = loginShell()) {
  return /^\/[\w./-]*\/(sh|bash|zsh|dash|ksh)$/.test(shell) ? shell : '/bin/sh';
}

/**
 * Start a detached tmux session in `cwd` running `argv` through a login shell (so PATH matches
 * the user's terminal, like `ah`). Returns the new pane's id and target.
 */
export async function newSession(name, cwd, argv) {
  const quoted = argv.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  // Shell and script as separate arguments: tmux (3.0+) starts them directly, so no other shell parses the quoting.
  await tmux(['new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', cwd, posixShell(), '-lc', quoted]);
  const out = await tmux(['list-panes', '-t', `=${name}`, '-F', '#{pane_id}|#{session_name}:#{window_index}.#{pane_index}']);
  const [paneId, target] = out.trim().split('\n')[0].split('|');
  return { paneId, target, name };
}
