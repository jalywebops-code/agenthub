// Demo mode (`npm run demo`): the real board with made-up agents, so it can be tried, shown and screenshotted
// without installing an agent or showing anyone's real chats. Every project, chat and number here is invented.
// The demo agents answer like real ones would: act on a card and its agent "works" for a few seconds, then reports.
import { classify, askOf, replyEnd, earlierTurns, REPLY_MAX, clipTail } from './util.js';
import { questionFromReply } from './choices.js';
import { findLinks } from './preview.js';
import { projectFor } from './projects.js';
import { config } from './config.js';

/** The demo's project folders (made in its own temp folder, so New chat has folders to pick). */
export const DEMO_PROJECTS = ['website-redesign', 'mobile-app', 'data-pipeline', 'docs-site', 'infra'];

const MIN = 60 * 1000;
const t0 = Date.now();
const folder = (name) => `${config.projectsRoot}/${name}`;

// One entry per chat. `turns`: the conversation, oldest first ({ role: 'you' | 'agent', text }). `state`: 'waiting'
// (the agent spoke last and waits on you), 'working', 'idle' or 'done'. `approval`: a pending request to approve.
const chats = [
  { harness: 'claude', project: 'website-redesign', title: 'Ship the pricing page redesign', ago: 6, state: 'waiting',
    approval: 'npm run deploy -- --prod\nDeploy the pricing page to production',
    turns: [
      { role: 'you', text: 'Finish the pricing page redesign and get it ready to ship.' },
      { role: 'agent', text: 'Done: new plan cards, the yearly toggle and the comparison table. Lighthouse is 98 on mobile and every visual test passes against the approved mockups.' },
      { role: 'you', text: 'Great. Deploy it when the preview checks pass.' },
      { role: 'agent', text: 'The preview checks passed (build, tests, accessibility). The last step is the production deploy, which needs your approval.' },
    ] },
  { harness: 'codex', project: 'data-pipeline', title: 'Fix duplicate rows in the nightly import', ago: 14, state: 'waiting',
    turns: [
      { role: 'you', text: 'The nightly import is creating duplicate customer rows again. Find out why.' },
      { role: 'agent', text: "Found it: the vendor's export repeats a customer when their address changes mid-day, and the import treats each line as new. There are two ways to fix it. Which should I do?\n\nA) Deduplicate during the import (quick, nothing else changes)\nB) Add a unique key in the warehouse (cleaner, needs a small migration)" },
    ] },
  { harness: 'claude-work', project: 'mobile-app', title: 'Release 2.4: offline mode', ago: 22, state: 'waiting',
    turns: [
      { role: 'you', text: 'Get the offline mode branch ready for the 2.4 release.' },
      { role: 'agent', text: 'Offline mode is finished: drafts sync when the connection comes back, and conflicts keep both versions. All 412 tests pass on iOS and Android, and the release notes are drafted.\n\nI need your go-ahead before I merge the release branch.' },
    ] },
  { harness: 'hermes', project: 'docs-site', title: 'New getting-started guide', ago: 35, state: 'waiting',
    turns: [
      { role: 'you', text: 'Write a getting-started guide that takes a new user from install to their first deploy.' },
      { role: 'agent', text: 'The guide is written: install, first project, environment variables and the first deploy, with a screenshot at each step. It is in docs/start.md and the preview build is up.\n\nPlease take a look at the preview and tell me what to change.' },
    ] },
  { harness: 'openclaw', project: 'infra', title: 'Rotate the staging certificates', ago: 48, state: 'waiting',
    turns: [
      { role: 'you', text: 'The staging certificates expire this week. Rotate them.' },
      { role: 'agent', text: 'Rotated the staging certificates for all four services and restarted them one at a time. Health checks are green and nothing dropped during the switch.' },
    ] },
  { harness: 'codex', project: 'mobile-app', title: 'Upgrade the build tooling', ago: 3, state: 'waiting',
    turns: [
      { role: 'you', text: 'Upgrade the build tooling to the new major version.' },
      { role: 'agent', text: "You've hit your usage limit. Try again in 1 hour 40 minutes." },
    ] },
  { harness: 'claude', project: 'website-redesign', title: 'Speed up the image pipeline', ago: 1, state: 'working',
    turns: [{ role: 'you', text: 'The hero images are too heavy on mobile. Make them load faster without losing quality.' }] },
  { harness: 'hermes', project: 'infra', title: 'Weekly dependency check', ago: 9, state: 'working',
    turns: [{ role: 'you', text: 'Run the weekly dependency check and open pull requests for anything safe to update.' }] },
  { harness: 'claude-work', project: 'mobile-app', title: 'Crash report triage', ago: 180, state: 'idle',
    turns: [
      { role: 'you', text: 'Look through last week\'s crash reports and tell me what matters.' },
      { role: 'agent', text: 'Three crashes account for 80% of reports; all three are fixed in 2.4. Nothing else needs action.' },
    ] },
  { harness: 'codex', project: 'docs-site', title: 'Fix broken links', ago: 320, state: 'done',
    turns: [
      { role: 'you', text: 'Find and fix the broken links in the docs.' },
      { role: 'agent', text: 'Fixed 17 broken links and added a link check to CI so new ones fail the build.' },
    ] },
  { harness: 'openclaw', project: 'data-pipeline', title: 'Backfill March metrics', ago: 900, state: 'done',
    turns: [
      { role: 'you', text: 'Backfill the March metrics after the outage.' },
      { role: 'agent', text: 'Backfilled March: 31 days, 2.4M rows, totals match the billing system to the cent.' },
    ] },
];

// The board's demo state: each chat as a live record the demo agents change when you act.
let next = 1;
const live = chats.map((c) => ({ ...c, id: `${c.harness}:demo-${next++}`, turns: [...c.turns], at: t0 - c.ago * MIN }));

/** What the agent "does" after a message from you: a short report that fits what you asked. */
function reportFor(chat, message) {
  const m = String(message || '').toLowerCase();
  if (/approved|go ahead|yes|merge|ok\b/.test(m)) return 'Done. It is live, and the checks after it are green.';
  if (/^a\)|deduplicate|\ba\b/.test(m)) return 'Done: duplicates are now merged during the import. Last night\'s run would have produced zero duplicates.';
  if (/^b\)|unique key|\bb\b/.test(m)) return 'Done: added the unique key with a small migration; the import now updates existing rows instead of adding new ones.';
  if (/hold off|pause/.test(m)) return 'Understood. I will wait until you come back to this.';
  if (/keep going|carry on|continue/.test(m)) return 'Carried on to the next step: everything that was left is done, and nothing else needs you right now.';
  return `Done: ${String(message).replace(/\s+/g, ' ').slice(0, 120)}${String(message).length > 120 ? '…' : ''}`;
}

// The board's refresh, called when a demo agent changes on its own (as file watchers do for real agents).
let changed = () => {};
/** Tell the demo what to call when one of its agents finishes, so the board shows it at once. */
export function onDemoChange(fn) { changed = fn; }

/** You did something on a card: the agent works for a few seconds, then reports. */
function act(chat, message) {
  chat.turns.push({ role: 'you', text: message });
  chat.state = 'working';
  chat.approval = '';
  chat.at = Date.now();
  setTimeout(() => {
    chat.turns.push({ role: 'agent', text: reportFor(chat, message) });
    chat.state = 'waiting';
    chat.at = Date.now();
    changed();
  }, 6000 + Math.floor(Math.random() * 3000)).unref();
}

/** A chat as a board card (the same fields a real lane gives). */
function cardOf(c) {
  const msgs = c.turns.map((t) => ({ role: t.role, text: t.text }));
  const lastReply = [...msgs].reverse().find((m) => m.role === 'agent')?.text || '';
  const lastPrompt = [...msgs].reverse().find((m) => m.role === 'you')?.text || '';
  const agentSpokeLast = msgs.at(-1)?.role === 'agent' || !!c.approval;
  const { status, waitingSince } = classify({ running: c.state === 'working', ended: c.state === 'done', agentSpokeLast: c.state === 'waiting' && agentSpokeLast, lastActivity: c.state === 'idle' ? t0 - 3 * 24 * 60 * MIN : c.at }, config);
  const end = replyEnd(lastReply);
  const cwd = folder(c.project);
  return {
    id: c.id, harness: c.harness, ref: c.id.split(':')[1], title: c.title, cwd, project: projectFor(cwd),
    status, waitingSince, lastActivity: c.at,
    lastPrompt, lastReply: clipTail(lastReply, REPLY_MAX), earlier: earlierTurns(msgs), replyEnd: end, ask: c.approval ? '' : askOf(lastReply),
    links: findLinks(lastReply, lastPrompt),
    needsApproval: !!c.approval, pendingPrompt: c.approval || '', approvalStyle: c.approval ? 'request' : undefined,
    request: c.approval ? { ask: 'Do you want to proceed?', detail: `Bash command\n${c.approval}` } : null,
    question: c.approval || status !== 'waiting' ? null : questionFromReply(lastReply, end),
    paneId: '', canReply: c.state !== 'done', replyBlockedReason: c.state === 'done' ? 'This demo chat has ended.' : '',
    source: 'demo', note: '',
  };
}

const find = (card) => live.find((c) => c.id === card.id);
const later = (ms, value) => new Promise((resolve) => { setTimeout(() => resolve(value), ms); });

/** One demo agent, with the same functions a real lane has. */
export function createDemoLane(key, name) {
  return {
    async collect() {
      return { connected: true, health: 'ok', why: `${name} (demo): the board can reply and approve.`, reason: 'Demo agent.',
        cards: live.filter((c) => c.harness === key).map(cardOf) };
    },
    async send(card, { kind, message }) {
      const chat = find(card);
      if (!chat) throw new Error('That demo chat is gone.');
      act(chat, kind === 'approve' ? 'Approved. Go ahead.' : message);
      return {};
    },
    async choose(card, { pick, text }) {
      const chat = find(card);
      act(chat, text || `Option ${Number(pick) + 1}`);
    },
    async defer(card, message) { act(find(card), message); },
    async messages(card) { return (find(card)?.turns || []).map((t) => ({ role: t.role, text: t.text, ts: find(card).at })); },
    async commands() { return []; },
    async sideAsk({ question }) {
      return later(900, question
        ? `(Demo) In a real board, ${name} would answer this from the chat's history, read-only. For example: the last step was a successful build, and nothing is blocked.`
        : 'Looks good, go ahead.');
    },
    async startSession({ title, message, cwd }) {
      const project = DEMO_PROJECTS.find((p) => cwd && cwd.endsWith(`/${p}`)) || 'website-redesign';
      const chat = { harness: key, project, title: title || String(message).slice(0, 60), state: 'working', turns: [], id: `${key}:demo-${next++}`, at: Date.now() };
      live.push(chat);
      act(chat, message);
      return { ref: chat.id.split(':')[1], title: chat.title };
    },
    async endSession(card) { const chat = find(card); if (chat) chat.state = 'done'; return 'Ended (demo).'; },
  };
}

// What the demo answers. It has no PIN, so instead: it only answers when addressed as this computer (a site whose
// name was pointed at 127.0.0.1 can't reach it), it acts only for its own page, and it never runs anything that
// touches the real computer (installing the service, Detect, setup, PIN, link previews, uploads).
const DEMO_ROUTES = new Set([
  'GET /api/hello', 'GET /api/board', 'GET /api/settings', 'GET /api/setup', 'GET /api/versions', 'GET /api/messages',
  'GET /api/commands', 'POST /api/settings', 'POST /api/refresh', 'POST /api/ask', 'POST /api/handoff', 'POST /api/delegate',
  'POST /api/schedule', 'POST /api/close', 'POST /api/reopen', 'POST /api/suggest', 'POST /api/defer', 'POST /api/resume',
  'POST /api/action', 'POST /api/new-chat', 'POST /api/choose',
]);

/** Why the demo refuses a request (an error to send), or '' to go ahead. */
export function demoRefusal({ method, path: p, host, origin, port }) {
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'The demo only answers on this computer (localhost).';
  if (!p.startsWith('/api/')) return '';
  if (!DEMO_ROUTES.has(`${method} ${p}`)) return 'Not in the demo: this part of AgentHub works on a real install.';
  if (method !== 'GET' && origin !== `http://${host}`) return 'cross-origin request refused';
  return '';
}

/** Made-up agent versions for Settings (the demo never runs the real programs). */
export function demoVersions() {
  const v = (version) => ({ version, updateAvailable: false, updateCommand: '', note: '' });
  return { claude: v('2.1.0'), 'claude-work': v('2.1.0'), codex: v('0.50.0'), hermes: v('1.4.2'), openclaw: v('2026.11.1') };
}

/** Plan usage for the demo's rings: one account comfortable, one getting close, Codex halfway through its week. */
export function demoUsage(now = Date.now()) {
  const h = 3600 * 1000;
  return {
    claude: { windows: [{ name: 'Session', used: 34, resetsAt: now + 2.5 * h }, { name: 'Week', used: 21, resetsAt: now + 4 * 24 * h }], why: '' },
    'claude-work': { windows: [{ name: 'Session', used: 81, resetsAt: now + 1.2 * h }, { name: 'Week', used: 47, resetsAt: now + 2 * 24 * h }], why: '' },
    codex: { windows: [{ name: 'Week', used: 52, resetsAt: now + 3 * 24 * h }], why: '' },
  };
}
