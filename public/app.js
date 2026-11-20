// AgentHub board UI. Vanilla JS, no build step. All data rendered with textContent.
import { activity, foldApplies, pickAge, cardActions, boardLayout, newestFirst, DEFER_TEXT, RESUME_TEXT, CONTINUE_TEXT } from './activity.js';

// Until the first board data arrives; then each agent's name comes from this install's setup (load()).
const HARNESS = { hermes: 'Hermes', openclaw: 'OpenClaw', claude: 'Claude Code', codex: 'Codex' };
// What each lane is, from the board data: 'claude' for every Claude Code account (they share Claude's mark, and are
// told apart by their accent colours and tag), else the agent itself.
const kindOf = (harness) => state.data?.lanes?.[harness]?.kind || harness;
const laneOf = (harness) => state.data?.lanes?.[harness] || {};
const runsInFolder = (harness) => ['claude', 'codex'].includes(kindOf(harness));
const STATUS_LABEL = { blocked: 'Blocked', review: 'Review', update: 'Update', working: 'Running', idle: 'Idle', done: 'Done' };
const needsYou = (c) => (c.status === 'blocked' || c.status === 'review') && !c.closedAt;
const LONG_PRESS_MS = 500;

const state = {
  data: null,
  needs: false,
  status: 'all',
  harness: 'all',
  q: '',
  openDone: new Set(),
  collapsed: new Set(), // projects you folded away (kept across refreshes)
  // This device's own time window ('' until it picks one), then the board default from Settings.
  deviceAge: (() => { try { return localStorage.getItem('agenthub_age') || ''; } catch { return ''; } })(),
  age: '7d',
  settings: null,
  opened: new Set(), // quiet projects you opened although Settings folds them
  mainOpen: new Set(), // projects you opened in the main view (they start folded there)
  commands: {}, // harness -> [{ name, description }]
  pillsKey: '',
  restarting: new Set(), // agents whose gateway the board is restarting right now (orange light)
  boardRestartUntil: 0, // while AgentHub itself restarts, a lost connection is a restart, not an outage
};

const $ = (id) => document.getElementById(id);
const sheet = $('sheet');
const sheetBody = $('sheetBody');

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ${m % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}
const ago = (t) => (t ? (fmtDur(Date.now() - t) === 'just now' ? 'just now' : `${fmtDur(Date.now() - t)} ago`) : '');
/** Compact age for the status pill: "4m", "2h", "3d". */
const short = (t) => fmtDur(Date.now() - t).split(' ')[0].replace('just', 'now');
const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const folderName = (p) => (p ? p.replace(/\/+$/, '').split('/').pop() : '');

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

/**
 * A Claude account's short tag (its setup's `tag`, e.g. "WORK") as a small badge in the account's colour, on its button
 * and its cards; null for an agent without one.
 */
function acctBadge(k) {
  const tag = laneOf(k).tag;
  return tag ? h('span', { class: 'acct', 'aria-hidden': 'true' }, tag) : null;
}
/**
 * The agent's name where its tag badge is shown beside it. Claude Code: the default account (the plain `claude`
 * command, id "claude") is just "Claude", and so is any account with a tag (its badge says which one); an extra
 * account without a tag keeps its own name, so two accounts never look the same.
 */
function nameBesideTag(k) {
  const lane = laneOf(k);
  if ((lane.kind || kindOf(k)) === 'claude' && (k === 'claude' || lane.tag)) return 'Claude';
  return lane.name || HARNESS[k] || k;
}

/** The agent's official mark (from the app installed on the computer), or a brand-colour dot if missing. */
// Icons that failed to load: drawn as the stand-in straight away after that, never requested again on each redraw.
const missingIcons = new Set();
function agentIcon(harness, cls = 'agent-icon') {
  const icon = kindOf(harness) === 'claude' ? 'claude' : harness;
  // The stand-in carries the agent's initial, so a dark brand colour (Hermes) never reads as an empty square.
  const standIn = () => h('span', { class: `${cls} mark mark-${icon}`, 'aria-hidden': 'true' }, icon[0].toUpperCase());
  if (missingIcons.has(icon)) return standIn();
  const img = h('img', { class: cls, src: `/icons/${icon}.png`, alt: '', width: '20', height: '20', 'aria-hidden': 'true' });
  img.addEventListener('error', () => { missingIcons.add(icon); img.replaceWith(standIn()); }, { once: true });
  return img;
}

// ---------- API ----------
// The token every action carries. The server hands it out only in the login answer; it is kept in this page's own
// storage (separate for each port), never in a cookie, so a cookie that leaks elsewhere can't be used to act.
const TOKEN_KEY = 'agenthub_action_token';
function storedToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function storeToken(token) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

async function api(path, opts = {}) {
  const acting = opts.method === 'POST' && path !== '/api/login' && path !== '/api/first-pin' && !state.demo;
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  if (acting) {
    const token = state.token || storedToken();
    if (!token) { showLogin('Enter your PIN once more to act from this device.'); throw new Error('PIN required'); }
    headers['X-AgentHub-Token'] = token;
  }
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 401 && path !== '/api/login') { state.token = ''; storeToken(''); showLogin(); throw new Error('PIN required'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.relogin) {
    state.token = '';
    storeToken('');
    showLogin('Enter your PIN once more to act from this device.');
    throw new Error('PIN required');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

/**
 * How current the board is, shown as the ring around the settings gear (teal current, amber stale, red offline).
 * The words appear next to it only when something is wrong; the gear's label always carries them.
 */
/** Current (green) until two refreshes are missed; then amber, saying how long it has been. */
function showHealth() {
  if (!state.data?.generatedAt) return;
  const age = Date.now() - state.data.generatedAt;
  const staleAfter = (state.data.refreshMs || 30000) * 2 + 15000;
  if (age < staleAfter) setHealth('ok', `Updated ${ago(state.data.generatedAt) || 'just now'}`);
  else setHealth('stale', age < 300000 ? `No new data for ${Math.round(age / 1000)} s` : `Updated ${ago(state.data.generatedAt)}`);
}

function setHealth(kind, text) {
  const gear = $('settingsBtn');
  gear.dataset.health = kind;
  gear.title = `Settings · ${text}`;
  gear.setAttribute('aria-label', `Settings. ${text}`);
  $('updated').textContent = kind === 'ok' ? '' : text;
}

/**
 * A new version of the page (its files changed on the computer): reload once it is safe, never while you are typing,
 * have a sheet or card open, or are touching the board. An installed app keeps running the page it loaded, so without
 * this it would only update when you reload it yourself.
 */
function noticeNewVersion(version) {
  if (!version) return;
  if (!state.pageVersion) { state.pageVersion = version; return; }
  if (version === state.pageVersion || state.reloadWaiting) return;
  state.reloadWaiting = true;
  const tryReload = () => {
    const busy = sheet.open || $('login').open || touching || document.activeElement?.matches('textarea, input, select');
    if (busy) { setTimeout(tryReload, 5000); return; }
    location.reload();
  };
  tryReload();
}

/** `readNow`: have the server read every agent first (the page just opened, e.g. pulled to refresh). */
async function load({ readNow = false } = {}) {
  if (document.hidden || $('login').open) return;
  try {
    // "since": the board this page already shows. When nothing changed the server answers with no body (204), so
    // checking every 5 seconds costs almost nothing while the board itself only changes every 30.
    const have = !readNow && state.data?.generatedAt && state.data.age === state.age ? `&since=${state.data.generatedAt}:${state.age}` : '';
    const fresh = await api(`/api/board?age=${encodeURIComponent(state.age)}${have}${readNow ? '&fresh=1' : ''}`)
      .finally(() => { if (readNow) state.readingNow = false; });
    if (!fresh.generatedAt) { showHealth(); return; } // nothing new: keep the board, just recheck how current it is
    const before = state.data?.generatedAt;
    noticeNewVersion(fresh.version);
    state.data = fresh;
    if (fresh.welcome && !state.welcomeShown && !sheet.open) { state.welcomeShown = true; setTimeout(openWelcome, 300); }
    state.allCards = fresh.cards || [];
    applyHidden();
    // Agent names come from this install's setup (e.g. each Claude account's own label).
    for (const [k, lane] of Object.entries(fresh.lanes || {})) if (lane.name) HARNESS[k] = lane.name;
    renderSoon(); // new data: never redraw under a finger
    if (fresh.generatedAt !== before) {
      // The server waits 30 s after it finishes reading the agents, so one round is 30 s plus the reading time: the
      // gap between two boards measures it. A gap far off (a restart, a sleeping laptop) is ignored.
      const gap = before ? fresh.generatedAt - before : 0;
      const cycle = fresh.refreshMs || 30000;
      if (gap > cycle && gap < cycle * 2) state.roundMs = gap;
      startClock(!!before); // the server read every agent again: pulse (not on the first load) and go round again
    }
  } catch (e) {
    if (e.message === 'PIN required') return;
    if (Date.now() < state.boardRestartUntil) setHealth('restarting', 'Restarting AgentHub…');
    else setHealth('offline', `Offline: ${e.message}`);
  }
}

/**
 * The settings gear as a clock: a light green spark goes once round the ring, clockwise from 12 o'clock,
 * over one board round (30 s plus the time the server takes to read the agents, as measured), starting from when the
 * server last read them. As it reaches 12 the page asks for the new board at once, so new data lands with the spark
 * at 12; the ring then gives one faint pulse and the spark sets off again. If the server is late the spark waits at 12.
 */
let clockCheck = 0;
function startClock(pulse = false) {
  const gear = $('settingsBtn');
  const round = state.roundMs || (state.data?.refreshMs || 30000) + 2000;
  const elapsed = Math.min(round, Math.max(0, Date.now() - (state.data?.generatedAt || Date.now())));
  gear.style.setProperty('--cycle', `${round}ms`);
  gear.style.setProperty('--elapsed', `${-elapsed}ms`);
  gear.classList.remove('clock', 'pulse', 'reading');
  void gear.offsetWidth; // restart the animations
  gear.classList.add('clock');
  if (state.readingNow) gear.classList.add('reading'); // still waiting for the read the page asked for: no pulse yet
  else if (pulse) gear.classList.add('pulse');
  clearTimeout(clockCheck);
  clockCheck = setTimeout(load, round - elapsed + 300); // look for the new board as the spark reaches 12
}

// ---------- login ----------
function showLogin(why = '') {
  $('loginError').textContent = why;
  if (!$('login').open) $('login').showModal();
  $('pin').focus();
  // A brand-new board has no PIN yet: on the computer itself you create it here (the welcome's first step).
  fetch('/api/hello').then((r) => r.json()).then((hello) => { if (hello.needsPin) createPinMode(hello.here); }).catch(() => {});
}
let creatingPin = false;
function createPinMode(here) {
  creatingPin = here;
  $('loginTitle').textContent = here ? 'Welcome to AgentHub' : 'AgentHub has no PIN yet';
  $('loginNote').textContent = here
    ? 'First, choose the PIN every device will log in with: 8 to 12 digits. It is kept only as a scrambled copy on this computer.'
    : 'Open AgentHub on the computer it runs on (http://localhost:4400) to create its PIN, then log in here.';
  $('pin').hidden = !here;
  $('pin2').hidden = !here;
  $('loginGo').hidden = !here;
  $('pin').placeholder = 'New PIN (8–12 digits)';
  $('pin').setAttribute('autocomplete', 'new-password');
  $('loginGo').textContent = 'Create PIN';
}
$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('loginError').textContent = '';
  try {
    if (creatingPin) {
      const pin = $('pin').value.trim();
      if (!/^\d{8,12}$/.test(pin)) { $('loginError').textContent = 'A PIN is 8 to 12 digits.'; return; }
      if (pin !== $('pin2').value.trim()) { $('loginError').textContent = 'The two PINs differ.'; return; }
      const made = await post('/api/first-pin', { pin });
      state.token = made.token || '';
      storeToken(state.token);
      creatingPin = false;
      $('login').close();
      await loadSettings();
      load();
      return;
    }
    const res = await post('/api/login', { pin: $('pin').value.trim() });
    state.token = res.token || '';
    storeToken(state.token);
    $('login').close();
    await loadSettings();
    load();
  } catch (e) {
    $('loginError').textContent = e.message;
  }
});
$('login').addEventListener('cancel', (ev) => ev.preventDefault());

// ---------- filters ----------
function filtered() {
  const q = state.q.toLowerCase();
  return (state.data?.cards || []).filter((c) => {
    // Closed cards only show under the "Closed" filter.
    if (state.status === 'closed') return !!c.closedAt;
    if (c.closedAt) return false;
    if (state.needs && !needsYou(c)) return false;
    if (state.status !== 'all' && c.status !== state.status) return false;
    if (state.harness !== 'all' && c.harness !== state.harness) return false;
    if (q) {
      const hay = `${c.title} ${c.project} ${HARNESS[c.harness]} ${c.lastPrompt} ${c.lastReply} ${c.cwd}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

$('statusChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  state.status = b.dataset.status;
  for (const x of $('statusChips').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.status === state.status));
  render();
});
$('search').addEventListener('input', (ev) => { state.q = ev.target.value; render(); });

// Computers (1100px+): search sits in the top bar, between the logo and the buttons (the agent row then holds only
// agents and can wrap onto a second row). Below that it stays in the filter row. One element, moved: what you typed
// stays, and Tab follows it.
const WIDE_HEADER = window.matchMedia('(min-width: 1100px)');
function placeSearch() {
  const box = document.querySelector('label.search');
  if (WIDE_HEADER.matches) $('updated').after(box);
  else $('glance').after(box);
}
WIDE_HEADER.addEventListener('change', placeSearch);
placeSearch();
// "/" jumps to search (when not typing somewhere already).
document.addEventListener('keydown', (ev) => {
  if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target.closest?.('input, textarea, select, [contenteditable], dialog')) return;
  ev.preventDefault();
  $('search').focus();
});

// At a glance: how many chats are blocked, to review, running and updates in the time window (for the chosen agent),
// each a button that shows only those; pressed again it shows everything.
const GLANCE = [['blocked', 'blocked'], ['review', 'to review'], ['working', 'running'], ['update', 'updates']];
function drawGlance() {
  const cards = (state.data?.cards || []).filter((c) => !c.closedAt && (state.harness === 'all' || c.harness === state.harness)
    && !isHidden(c.harness));
  $('glance').replaceChildren(...GLANCE.map(([status, word]) => {
    const n = cards.filter((c) => c.status === status).length;
    const on = state.status === status;
    return h('button', { type: 'button', class: `glance-item ${status}`, 'aria-pressed': String(on), disabled: !n && !on,
      title: on ? 'Show every status again' : `Show only ${word}`,
      onclick: () => $('statusChips').querySelector(`[data-status="${on ? 'all' : status}"]`)?.click() },
    h('span', { class: 'glance-dot', 'aria-hidden': 'true' }), h('b', {}, String(n)), ` ${word}`);
  }));
}

// Phones: the status and time dropdowns press the same chips a computer shows, so both always agree.
$('statusSelect').addEventListener('change', (ev) => $('statusChips').querySelector(`[data-status="${ev.target.value}"]`)?.click());
$('ageSelect').addEventListener('change', (ev) => $('ageChips').querySelector(`[data-age="${ev.target.value}"]`)?.click());
/** The dropdowns show the current choice; a status other than All gets an outline so a filter on is easy to see. */
function syncSelects() {
  $('statusSelect').value = state.status;
  $('statusSelect').classList.toggle('on', state.status !== 'all');
  $('ageSelect').value = state.age;
}

// How far back the board looks (Blocked and Running always show). Kept on this device; the server filters.
function showAge() {
  for (const b of $('ageChips').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.age === state.age));
  syncSelects();
}
$('ageChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  state.age = b.dataset.age;
  state.deviceAge = state.age;
  try { localStorage.setItem('agenthub_age', state.age); } catch { /* private mode */ }
  showAge();
  load();
});
showAge();
$('newChat').addEventListener('click', () => openNewChat());
$('settingsBtn').addEventListener('click', () => openSettings());

// ---------- agent pills: filter + status light; press and hold for the agent's menu ----------
function setHarness(key) {
  state.harness = key;
  render();
}

// ---------- agents hidden on this device ----------
// For screenshots: an agent hidden here loses its button, its cards and its place in New chat, Ask, Hand off and
// Have Hermes do it, on this device only. It keeps running and nothing is sent to it; other devices still show it.
// Hidden from its press-and-hold menu; shown again from Settings → On this device.
state.hidden = (() => { try { return new Set(JSON.parse(localStorage.getItem('agenthub_hidden') || '[]')); } catch { return new Set(); } })();
const isHidden = (key) => state.hidden.has(key);
/** The board's cards without those of agents hidden here (all of them stay in state.allCards). */
function applyHidden() {
  if (state.data) state.data.cards = (state.allCards || []).filter((c) => !isHidden(c.harness));
}
/** One "Show <agent>" switch per agent (the All button's menu and Settings → On this device). */
/** Settings → Board → On this device: System (follows the device), Light or Dark. */
function themeChoice() {
  const sel = h('select', { 'aria-label': 'Appearance' },
    ...[['system', 'Match this device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, label]) => h('option', { value: v }, label)));
  sel.value = window.agenthubTheme?.choice() || 'system';
  sel.addEventListener('change', () => window.agenthubTheme?.set(sel.value));
  // Classic, or the embossed "tactile" look (public/tactile.css). Also this device only.
  const style = h('select', { 'aria-label': 'Style' },
    ...[['classic', 'Classic'], ['tactile', 'Tactile']].map(([v, label]) => h('option', { value: v }, label)));
  style.value = window.agenthubTheme?.style?.() || 'classic';
  style.addEventListener('change', () => window.agenthubTheme?.setStyle?.(style.value));
  window.addEventListener('agenthub-theme', (ev) => { sel.value = ev.detail.choice; style.value = ev.detail.style || 'classic'; });
  return [h('label', { class: 'nc-field' }, h('span', {}, 'Appearance'), sel), h('label', { class: 'nc-field' }, h('span', {}, 'Style'), style)];
}

function agentToggles() {
  return Object.keys(state.data?.lanes || {}).map((k) => h('label', { class: 'set-toggle' },
    h('input', { type: 'checkbox', checked: !isHidden(k), onchange: (ev) => setHidden(k, !ev.target.checked) }), h('span', {}, `Show ${HARNESS[k]}`)));
}

/** Press and hold (or right-click) the All button: choose which agents this board shows on this device. */
function openAllMenu() {
  openSheet('Agents on this board',
    h('p', { class: 'note' }, 'On this device only. A hidden agent keeps running; nothing is sent to it.'),
    h('div', { class: 'set-section' }, ...agentToggles()),
    h('button', { type: 'button', onclick: () => sheet.close() }, 'Done'));
}

function setHidden(key, hide) {
  if (hide) state.hidden.add(key); else state.hidden.delete(key);
  try { localStorage.setItem('agenthub_hidden', JSON.stringify([...state.hidden])); } catch { /* private mode: this visit only */ }
  if (hide && state.harness === key) state.harness = 'all';
  applyHidden();
  render();
}

/** Tap runs `onTap`; holding ~500 ms (touch, pen or mouse) runs `onHold` instead. Right-click and the menu key also open it. */
function pressable(el, onTap, onHold) {
  let timer = null;
  let held = false;
  let start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    held = false;
    start = { x: ev.clientX, y: ev.clientY };
    timer = setTimeout(() => { held = true; timer = null; navigator.vibrate?.(15); onHold(); }, LONG_PRESS_MS);
  });
  el.addEventListener('pointermove', (ev) => {
    if (timer && start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10) cancel(); // scrolling, not holding
  });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(t, cancel);
  el.addEventListener('click', (ev) => {
    if (held) { ev.preventDefault(); held = false; return; }
    onTap();
  });
  el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); cancel(); held = false; onHold(); });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) { ev.preventDefault(); onHold(); }
  });
}

const HEALTH_WORD = { ok: 'ready', idle: 'nothing running', down: 'down', restarting: 'restarting' };
/** An agent's light: orange while the board restarts it, else what the server says (lib/health.js). */
const laneHealth = (key, lane) => (state.restarting.has(key) ? 'restarting' : lane?.health || (lane?.connected ? 'ok' : 'down'));

function renderAgentPills() {
  const lanes = state.data.lanes || {};
  // Only rebuild when something visible changed, so a press in progress is never cut off by a refresh.
  const key = JSON.stringify([state.harness, [...state.hidden], Object.entries(lanes).map(([k, l]) => [k, l.connected, laneHealth(k, l), l.why, l.usage?.windows])]);
  if (key === state.pillsKey) { glowPills(); return; }
  state.pillsKey = key;
  const hiddenNote = state.hidden.size ? ' Some agents are hidden on this device; press and hold to show them.' : '';
  const all = h('button', { type: 'button', class: 'agent-pill', 'aria-pressed': String(state.harness === 'all'), 'aria-label': `All agents. Press and hold to choose which agents this board shows.${hiddenNote}` }, 'All');
  pressable(all, () => setHarness('all'), openAllMenu);
  const pills = Object.entries(lanes).filter(([k]) => !isHidden(k)).map(([k, lane]) => {
    const on = state.harness === k;
    // The light: can the board act on this agent right now (lib/health.js)? Hover or hold says why.
    const health = laneHealth(k, lane);
    const used = usageText(lane.usage);
    const label = `${lane.name}: ${HEALTH_WORD[health]}. ${lane.why || lane.reason}${used ? ` ${used}.` : ''} Tap to ${on ? 'show all agents' : `show only ${lane.name}`}; press and hold for options.`;
    const b = h('button', { type: 'button', class: `agent-pill${health === 'down' ? ' off' : ''}`, 'data-agent': k, 'data-kind': lane.kind, 'data-accent': lane.accent || null, 'aria-pressed': String(on), 'aria-label': label, title: [lane.why || lane.reason, used].filter(Boolean).join('\n') },
      agentIcon(k, 'pill-icon'), h('span', { class: `light ${health}`, 'aria-hidden': 'true' }), h('span', { class: 'pill-name' }, nameBesideTag(k)), acctBadge(k));
    usageRing(b, lane.usage);
    pressable(b, () => setHarness(on ? 'all' : k), () => openAgentMenu(k));
    return b;
  });
  ringSizer.disconnect(); // the old buttons go; the new ones with a usage ring are watched for their size
  $('agentPills').replaceChildren(all, ...pills);
  for (const b of pills) if (b.classList.contains('has-usage')) ringSizer.observe(b);
  glowPills();
}

/** The working glow on agent buttons: switched on the existing buttons, never by rebuilding them mid-press. */
function glowPills() {
  const { working } = activity(state.data.cards);
  for (const b of $('agentPills').querySelectorAll('[data-agent]')) {
    const on = working.has(b.dataset.agent);
    b.classList.toggle('glow', on);
    b.dataset.working = on ? 'yes' : '';
  }
}

// ---------- cards ----------
function statusPill(c) {
  if (c.deferred) return h('span', { class: 'pill deferred', title: `Deferred ${ago(c.closedAt)}` }, 'Deferred');
  if (c.needsApproval) return h('span', { class: 'pill approval' }, `Approval ${short(c.waitingSince || c.lastActivity)}`);
  if (c.status === 'blocked') return h('span', { class: 'pill blocked' }, `Blocked ${short(c.waitingSince)}`);
  if (c.status === 'review') return h('span', { class: 'pill review' }, `Review ${short(c.waitingSince)}`);
  // A status report with nothing for you to do: shown in its project, not in Needs you.
  if (c.status === 'update') return h('span', { class: 'pill update' }, `Update ${short(c.waitingSince)}`);
  return h('span', { class: `pill ${c.status}`, title: ago(c.lastActivity) }, STATUS_LABEL[c.status]);
}

/**
 * A piece of card text that is cut short on the board. Tapping it opens the whole card over the board (openCard), where
 * it shows in full; the card on the board never grows. `key` is "<card id>:<part>"; `onChange(true, el)` swaps in the
 * long text where there is one.
 */
function keepOpen(el, key, onChange = () => {}) {
  el.dataset.expandable = '';
  el.showAll = () => { el.classList.add('open'); onChange(true, el); };
  el.addEventListener('click', (ev) => {
    if (el.closest('.card.full')) return;
    ev.stopPropagation();
    openCardById(key.slice(0, key.lastIndexOf(':')));
  });
  return el;
}

/** One card over the board, everything in full, with its usual buttons. Closes with ✕ / Esc / a tap outside. */
function openCard(c) {
  const el = cardEl(c);
  el.classList.add('full');
  for (const part of el.querySelectorAll('[data-expandable]')) part.showAll?.();
  openSheet(`${HARNESS[c.harness]}${c.project ? ` · ${c.project}` : ''}`, el);
  sheet.classList.add('card-sheet');
}
function openCardById(id) {
  const c = (state.data?.cards || []).find((x) => x.id === id);
  if (c) openCard(c);
}

/** Card text is clamped; tapping it shows the rest. */
function clampable(el, key) {
  el.setAttribute('title', 'Tap to show more');
  return keepOpen(el, key);
}

/** The end of the agent's last message (where its question is); tap to see more of it. */
function replyBlock(c) {
  const end = c.replyEnd || c.lastReply;
  if (!end) return null;
  const expandable = (cls, text) => keepOpen(h('p', { class: cls, title: 'Tap to show more' }, text), `${c.id}:reply`,
    (open, el) => { el.textContent = open ? plain(c.lastReply) || text : text; });
  // The turns before the last reply, dimmed, so a big card shows how the chat got here (only cards that need you
  // carry them). The card opens scrolled to its end, so the newest words are always in view.
  const earlier = (c.earlier || []).map((t) => h('p', { class: `turn ${t.role}` }, t.role === 'you' ? `You: ${plain(t.text)}` : plain(t.text)));
  // What the agent is asking, found near the end of its reply, comes last in bold; its closing line (a file it
  // attached, "Next step: …") follows in grey. Option questions show their own text in the question block instead.
  if (c.ask && !c.question) {
    // The closing line is shown only when it is a different paragraph from the question (e.g. an attached file).
    const askEnd = c.ask.slice(-40);
    const tail = !end.includes(askEnd) && !c.ask.includes(end.replace(/^…/, '')) ? h('p', { class: 'msg after' }, plain(end)) : null;
    // Above the question: the rest of the reply before it, or (when the question can't be found in the reply)
    // the paragraph a short question points back to.
    const lead = beforeAsk(c.lastReply, c.ask) || c.askContext;
    const context = lead ? clampable(h('p', { class: 'msg ask-context' }, plain(lead)), `${c.id}:context`) : null;
    return h('div', { class: 'card-text' }, earlier, context, expandable('msg reply asks', plain(c.ask)), tail);
  }
  return h('div', { class: 'card-text' }, earlier, earlier.length ? null : youLine(c, end),
    expandable('msg reply', plain(upToEnd(c.lastReply, end))));
}

/** The agent's reply before its question (the question itself is shown in bold under it); '' when not found. */
function beforeAsk(full, ask) {
  const head = ask.replace(/^…/, '').trim().slice(0, 40);
  const at = (full || '').lastIndexOf(head);
  return at > 0 ? full.slice(0, at).trim() : '';
}

/**
 * The agent's message up to the paragraph the card is about (`end`), so a big card shows what led up to it.
 * Anything after it (a trailing code block, a sign-off, a "Review: file" line) stays for the tap.
 */
function upToEnd(full, end) {
  const core = end.replace(/^…/, '').trim().slice(-60);
  const at = (full || '').lastIndexOf(core);
  return at === -1 ? end : full.slice(0, at + core.length);
}

/** Card text fills the card and shows its END (where the agent's point is); the top fades when there is more above. */
function showTextEnds(root) {
  for (const el of root.querySelectorAll('.card-text')) {
    el.scrollTop = el.scrollHeight;
    el.classList.toggle('clipped', el.scrollTop > 0);
    // Tapping the text opens the whole card over the board (openCard); so do Enter and Space when it has focus.
    const full = !!el.closest('.card.full');
    const open = () => openCardById(el.closest('article.card')?.dataset.id);
    el.onclick = full ? null : open;
    el.onkeydown = full ? null : (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    if (full) { el.removeAttribute('tabindex'); el.removeAttribute('role'); } else {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `Open “${el.closest('article.card')?.querySelector('.title-text')?.textContent || 'this chat'}” in full`);
    }
  }
}
window.addEventListener('resize', () => showTextEnds($('board')));

/** A short reply ("Cat selected.") only makes sense next to what you sent: show your last message on one grey line. */
function youLine(c, end) {
  if (c.question || end.length > 80 || !(c.lastPrompt || '').trim()) return null;
  return h('p', { class: 'msg you' }, `You: ${plain(c.lastPrompt).replace(/\s+/g, ' ').trim()}`);
}

/**
 * An approval waiting on you: what it asks, in bold, and what it would do (the command or file) in a box that wraps.
 * Falls back to the raw menu text when the question can't be picked out.
 */
function approvalBlock(c) {
  if (c.request?.ask) {
    const detail = c.request.detail ? h('pre', { class: 'request-detail', title: 'Tap to show all' }, c.request.detail) : null;
    if (detail) keepOpen(detail, `${c.id}:request`);
    const long = (c.request.detail || '').split('\n').length > 8;
    return [h('p', { class: 'msg asks' }, c.request.ask), detail,
      long ? h('p', { class: 'note' }, 'Long: tap the box to see all of it. The full screen is shown before you approve.') : null];
  }
  // A screen that can't be summarised: its last lines (the question and the options sit at the bottom), all of it
  // when the card is opened.
  const lines = String(c.pendingPrompt || '').split('\n').filter((l) => !/^… \(earlier lines cut/.test(l));
  let from = lines.findLastIndex((l) => /\?\s*$/.test(l));
  if (from === -1) from = Math.max(0, lines.length - 4);
  const tail = `${from > 0 ? '…\n' : ''}${lines.slice(from).join('\n')}`;
  const label = isMenu(c) ? 'On screen: ' : 'Asks to: ';
  const text = h('span', {}, tail);
  return keepOpen(h('p', { class: 'msg menu', title: 'Tap to show more' }, h('b', {}, label), text), `${c.id}:prompt`,
    (open) => { text.textContent = open ? c.pendingPrompt : tail; });
}

const plain = (t) => String(t || '').replace(/\*\*|__|`/g, '');

/** A multiple-choice question as option buttons. Every tap goes through a confirm sheet; nothing is sent on the tap. */
function questionBlock(c) {
  const q = c.question;
  if (!q) return null;
  if (q.unsupported) {
    return h('div', { class: 'question' },
      q.text ? h('p', { class: 'q-text' }, plain(q.text)) : null,
      h('p', { class: 'note' }, `This menu can't be answered from the board (${q.unsupported}). Answer it in the terminal.`),
      h('button', { type: 'button', class: 'ghost', onclick: () => openSheet(`Screen · ${c.title}`, fullScreen(c)) }, 'Show screen'));
  }
  const blocked = !c.canReply;
  const why = blocked ? c.replyBlockedReason : '';
  const showText = q.text && !(c.replyEnd || '').includes(q.text);
  const items = q.options.map((label, i) => ({ label, i })).filter(({ i }) => i !== q.freeText);
  const keyOf = (i, n) => (q.kind === 'reply' && q.keys[i] ? q.keys[i] : String(n + 1));
  const head = showText ? h('p', { class: 'q-text' }, plain(q.text)) : null;
  if (q.multi) {
    // Ticks live in state (per card and question), so the board's refresh every few seconds never clears them.
    state.ticks ||= new Map();
    const tkey = `${c.id}|${q.expect}`;
    const ticked = state.ticks.get(tkey) || new Set();
    const boxes = items.map(({ label, i }) => h('label', { class: 'opt multi' },
      h('input', { type: 'checkbox', value: String(i), disabled: blocked, checked: ticked.has(i),
        onchange: (ev) => {
          const set = state.ticks.get(tkey) || new Set();
          if (ev.target.checked) set.add(i); else set.delete(i);
          state.ticks.set(tkey, set);
        } }),
      h('span', { class: 'opt-label' }, plain(label))));
    const send = h('button', { type: 'button', class: 'opt-send', disabled: blocked, title: why || 'Send the ticked choices',
      onclick: () => {
        const picks = boxes.map((b) => b.querySelector('input')).filter((x) => x.checked).map((x) => Number(x.value));
        if (!picks.length) { toast('Tick at least one choice'); return; }
        openChoose(c, picks);
      } }, 'Send choices');
    return h('div', { class: 'question', role: 'group', 'aria-label': plain(q.text) || 'Question' }, head, ...boxes, send);
  }
  return h('div', { class: 'question', role: 'group', 'aria-label': plain(q.text) || 'Question' },
    head,
    ...items.map(({ label, i }, n) => h('button', { type: 'button', class: 'opt', disabled: blocked, title: why || `Answer: ${plain(label)}`, onclick: () => openChoose(c, i) },
      h('span', { class: 'opt-n', 'aria-hidden': 'true' }, `${keyOf(i, n)}`), h('span', { class: 'opt-label' }, plain(label)))),
    q.kind === 'reply' ? h('button', { type: 'button', class: 'opt other', disabled: blocked, onclick: () => openCompose(c, 'reply') }, 'Something else…') : null,
    q.kind === 'menu' && q.freeText !== -1
      ? h('button', { type: 'button', class: 'opt other', disabled: blocked, onclick: () => openTypeAnswer(c) },
        /^Tell /i.test(q.options[q.freeText]) ? `${q.options[q.freeText]}…` : 'Type my own answer…')
      : null);
}

/** Your own words into a terminal menu's free-text row ("Type something", "Tell Claude what to change"). */
function openTypeAnswer(c) {
  const q = c.question;
  const ta = h('textarea', { rows: '4', maxlength: '2000', 'aria-label': 'Your answer', placeholder: 'Your answer…' });
  const next = h('button', { type: 'button', class: 'primary' }, 'Next');
  next.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) { toast('Type your answer first'); return; }
    openSheet(`Answer · ${c.title}`,
      confirmStep({
        intro: `This types your answer into ${HARNESS[c.harness]}'s question in “${c.title}” and submits it. The agent will act on it.`,
        preview: `Question: ${(q.text || '').split('\n').pop()}\n\nYour answer: ${text}`,
        label: 'Send answer',
        back: () => openTypeAnswer(c),
        act: async () => {
          await post('/api/choose', { id: c.id, pick: q.freeText, text, expect: q.expect, confirm: true });
          sheet.close();
          toast(`Answered in ${HARNESS[c.harness]}`);
          setTimeout(load, 1500);
        },
      }),
      fullScreen(c));
  });
  openSheet(`Your answer · ${c.title}`, h('p', { class: 'q-text' }, plain(q.text)), ta,
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => sheet.close() }, 'Cancel'), next));
  setTimeout(() => ta.focus(), 50);
}

/** Answer a question: its choices when the agent gave some, otherwise a reply box. Nothing is sent from here. */
function openAnswer(c) {
  if (c.question && !c.question.unsupported) {
    const showsOwnText = c.question.text && !(c.replyEnd || '').includes(c.question.text);
    openSheet(`Answer · ${c.title}`, showsOwnText ? null : h('p', { class: 'q-text' }, plain(c.question.text || c.ask || '')), questionBlock(c));
    return;
  }
  if (c.decisions?.length >= 2 && c.canReply) { openDecisions(c, []); return; }
  openCompose(c, 'reply');
}

/**
 * A list of decisions ("1. Commit? 2. Delete the folder?"), one at a time: Yes, No, Skip or a typed answer, with Back.
 * After the last one, every answer goes as ONE reply, through the usual confirm step. Nothing is sent before that.
 */
function openDecisions(c, answers, at = 0) {
  const list = c.decisions;
  const d = list[at];
  const choose = (answer) => {
    const next = [...answers];
    next[at] = answer;
    if (at + 1 < list.length) openDecisions(c, next, at + 1);
    else reviewDecisions(c, next);
  };
  const ta = h('textarea', { rows: '3', maxlength: '2000', 'aria-label': `Your answer to ${d.label}`, placeholder: 'Or type your answer…' });
  ta.value = answers[at] && !['Yes', 'No'].includes(answers[at]) ? answers[at] : '';
  const err = h('p', { class: 'error', role: 'alert' });
  const pick = (label) => h('button', { type: 'button', class: `opt${answers[at] === label ? ' picked' : ''}`, onclick: () => choose(label) },
    h('span', { class: 'opt-label' }, label));
  openSheet(`Answer · ${c.title}`,
    h('p', { class: 'step-count' }, `Decision ${at + 1} of ${list.length}`),
    h('p', { class: 'decision-text' }, plain(`${d.n}. ${d.text}`)),
    h('div', { class: 'question' }, pick('Yes'), pick('No')),
    ta,
    err,
    h('div', { class: 'row' },
      at > 0 ? h('button', { type: 'button', onclick: () => openDecisions(c, answers, at - 1) }, 'Back') : h('button', { type: 'button', onclick: () => sheet.close() }, 'Cancel'),
      h('button', { type: 'button', onclick: () => choose('') }, 'Skip'),
      h('button', { type: 'button', class: 'primary', onclick: () => {
        const text = ta.value.trim();
        if (!text) { err.textContent = 'Pick Yes or No, type an answer, or Skip.'; return; }
        choose(text);
      } }, 'Next')));
}

/** All the decisions answered: one reply, shown in full before it is sent. */
function reviewDecisions(c, answers) {
  const lines = c.decisions.map((d, k) => (answers[k] ? `${d.n}. ${d.label}: ${answers[k]}` : null)).filter(Boolean);
  if (!lines.length) { toast('Every decision was skipped, so there is nothing to send'); openDecisions(c, answers, c.decisions.length - 1); return; }
  const text = lines.join('\n');
  openSheet(`Answer · ${c.title}`, confirmBlock(c, 'reply', text, text, () => openDecisions(c, answers, c.decisions.length - 1)));
}

/** Confirm sheet for an answer: shows exactly what will be pressed or sent. */
function openChoose(c, pick) {
  const q = c.question;
  const picks = Array.isArray(pick) ? pick : [pick];
  const labels = picks.map((i) => q.options[i]);
  // Always name what is being answered: the approval request, the question, or the menu.
  const asked = q.kind === 'approval' ? (c.pendingPrompt || q.text) : q.text;
  const action = q.kind === 'reply' ? `Send: ${q.keys[pick]}) ${q.options[pick]}`
    : q.kind === 'menu' && q.multi ? `Tick: ${labels.join(', ')}, then Submit (you'll confirm the review screen next)`
      : q.kind === 'menu' ? `Press “${labels[0]}” on the menu` : `Answer: ${labels.join(', ')}`;
  const preview = asked ? `${q.kind === 'approval' ? 'Request' : 'Question'}: ${asked}\n\n${action}` : action;
  openSheet(`Answer · ${c.title}`,
    confirmStep({
      intro: `This answers ${HARNESS[c.harness]}'s question in “${c.title}”. The agent will act on it.`,
      preview,
      label: 'Send answer',
      act: async () => {
        await post('/api/choose', { id: c.id, pick, expect: q.expect, confirm: true });
        state.ticks?.delete(`${c.id}|${q.expect}`);
        sheet.close();
        toast(`Answered in ${HARNESS[c.harness]}`);
        setTimeout(load, 1500);
      },
    }),
    q.kind === 'menu' ? fullScreen(c) : null);
}

function linksRow(c) {
  if (!c.links?.length) return null;
  return h('div', { class: 'links' }, c.links.map((link) => {
    const shot = c.previews?.[link];
    return h('button', { type: 'button', class: 'link', onclick: () => openPreview(c, link), title: `Preview ${link}` },
      shot ? h('img', { class: 'thumb', src: `/api/preview-img?k=${shot.key}&t=${shot.takenAt}`, alt: '', loading: 'lazy', width: '48', height: '34' }) : h('span', { class: 'link-icon', 'aria-hidden': 'true' }, '↗'),
      h('span', { class: 'link-text' }, link.replace(/^https?:\/\//, '').replace(/^\/Users\/[^/]+/, '~')),
      h('span', { class: 'link-action' }, shot ? 'View' : 'Preview'));
  }));
}

function handoffLine(c) {
  if (!c.handoff) return null;
  if (c.handoff.role === 'from') return h('p', { class: 'handoff' }, `Handed off to ${HARNESS[c.handoff.to.harness]} · ${when(c.handoff.at)}`);
  return h('p', { class: 'handoff to' }, `From ${HARNESS[c.handoff.from.harness]} · ${when(c.handoff.at)}`);
}

/** "3:12 PM", with the day when it isn't today ("Fri 9:02 AM"). */
function clockTime(t) {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** A usage limit, and the Continue planned for it: paused until when, or what happened at the planned time. */
function limitLine(c) {
  const s = c.scheduled;
  if (s?.state === 'waiting') return h('p', { class: 'limit-line planned' }, `Continues at ${clockTime(s.at)}${s.why ? `, ${s.why}` : ''}`);
  if (s?.state === 'sent') return h('p', { class: 'limit-line' }, `Continued at ${clockTime(s.doneAt)} ✓`);
  if (s && (s.state === 'skipped' || s.state === 'failed')) return h('p', { class: 'limit-line problem' }, `Didn't continue at ${clockTime(s.doneAt)}: ${s.reason}`);
  if (!c.limit) return null;
  const reset = c.limit.resetsAt ? (c.limit.resetsAt > Date.now() ? `resets ${clockTime(c.limit.resetsAt)}` : `reset at ${clockTime(c.limit.resetsAt)}`) : 'no reset time given';
  return h('p', { class: 'limit-line' }, `Paused · ${c.limit.label} · ${reset}`);
}

/** One tap: the board will send Continue at the reset (the server does it, so the page can be closed). */
async function planContinue(c, btn) {
  btn.disabled = true;
  try {
    await post('/api/schedule', { id: c.id, confirm: true });
    load();
  } catch (e) {
    btn.disabled = false;
    toast(e.message);
  }
}

async function cancelPlan(c, btn) {
  btn.disabled = true;
  try {
    await post('/api/schedule/cancel', { id: c.id });
    load();
  } catch (e) {
    btn.disabled = false;
    toast(e.message);
  }
}

/** A task another agent does for this chat: who is on it, or who it is for, and whether the result went back. */
function delegationLine(c) {
  const d = c.delegation;
  if (!d) return null;
  const done = d.state === 'done' ? ` · result sent ${when(d.sentAt)}` : '';
  if (d.role === 'from') return h('p', { class: 'handoff' }, d.state === 'done' ? `${HARNESS[d.to.harness]} did a task for this${done}` : `${HARNESS[d.to.harness]} is on it · ${when(d.at)}`);
  return h('p', { class: 'handoff to' }, `Task from ${HARNESS[d.from.harness]} · ${d.from.title}${done}`);
}

function cardEl(c) {
  // Read-only sessions (an account's read-only folders in the setup) show their tag and sub-folder instead.
  const where = c.readOnly ? `${c.readOnlyTag || 'Read-only'} · ${c.readOnly}` : folderName(c.cwd) || c.project;
  return h('article', { class: `card ${c.needsApproval ? 'approval' : c.status}${c.status === 'working' && !c.closedAt ? ' glow' : ''}`, 'data-id': c.id, 'data-agent': c.harness, 'data-kind': kindOf(c.harness), 'data-accent': laneOf(c.harness).accent || null, 'aria-label': `${c.title}, ${HARNESS[c.harness]}, ${c.needsApproval ? 'needs approval' : STATUS_LABEL[c.status]}` },
    h('header', { class: 'card-head' },
      agentIcon(c.harness),
      h('div', { class: 'head-text' },
        // The folder rides on the title line (saves a row on phones).
        h('h3', { class: 'title', title: c.title }, h('span', { class: 'title-text' }, c.title))),
      // Right column: status on top, folder under it (no separate folder row under the title).
      h('div', { class: 'head-right' }, statusPill(c),
        h('span', { class: 'where', title: c.cwd || where },
          laneOf(c.harness).tag ? h('span', { class: 'acct', 'aria-hidden': 'true' }, laneOf(c.harness).tag) : null,
          where, h('span', { class: 'sr-only' }, ` · ${HARNESS[c.harness]}`))),
      c.deferred ? null : c.closedAt
        ? h('button', { type: 'button', class: 'x', 'aria-label': `Reopen ${c.title} on the board`, title: 'Reopen on the board', onclick: () => reopen(c) }, '↺')
        : h('button', { type: 'button', class: 'x', 'aria-label': `Close or end ${c.title}`, title: 'Close or end this chat', onclick: () => openClose(c) }, '×')),
    c.status === 'working' && !c.closedAt ? workingLine(c) : null,
    replyBlock(c),
    // What it asks you to approve comes last, in a callout right above the buttons: the chat leads up to it.
    c.pendingPrompt && !c.question ? h('div', { class: 'ask-callout' }, approvalBlock(c)) : null,
    c.question?.kind === 'approval' ? h('div', { class: 'ask-callout' }, clampable(h('p', { class: 'msg menu' }, h('b', {}, 'Asks to: '), c.pendingPrompt), `${c.id}:prompt`)) : null,
    questionBlock(c),
    linksRow(c),
    handoffLine(c),
    delegationLine(c),
    limitLine(c),
    c.note ? h('p', { class: 'note' }, c.note) : null,
    // Read-only session that is waiting on you: say why there is no Answer here.
    !c.canReply && ['blocked', 'review'].includes(c.status) && c.replyBlockedReason ? h('p', { class: 'note' }, c.replyBlockedReason) : null,
    // A deferred card (in Closed) is picked back up with Resume; everything else gets its usual buttons.
    actionsRow(c, c.deferred ? ['resume', 'details'] : cardActions(c)),
  );
}

// The buttons that lead a card when they come first (filled in their colour); the rest stay quiet.
const PRIMARY_ACTIONS = new Set(['approve', 'answer', 'review', 'continue', 'continue-at', 'result', 'resume']);
// Kept behind "⋯": rarely the next step, and phones need the room for bigger buttons.
const OVERFLOW_ACTIONS = new Set(['defer', 'details']);

/** A card's buttons: its main action first (filled), the others quiet, Defer and Details in the "⋯" menu. */
function actionsRow(c, keys) {
  const shown = keys.filter((k) => !OVERFLOW_ACTIONS.has(k));
  const more = keys.filter((k) => OVERFLOW_ACTIONS.has(k));
  const buttons = shown.map((k, i) => {
    const b = actionButton(c, k);
    if (i === 0 && PRIMARY_ACTIONS.has(k)) b.classList.add('primary-action');
    return b;
  });
  if (more.length) buttons.push(moreButton(c, more));
  return h('div', { class: 'actions' }, buttons);
}

/** The "⋯" button: opens a small menu of the card's other actions. */
function moreButton(c, keys) {
  const btn = h('button', { type: 'button', class: 'more-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'aria-label': `More actions for ${c.title}`, title: 'More actions' }, '⋯');
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleMoreMenu(btn, c, keys); });
  return btn;
}

// The one open "⋯" menu. While it is open the board doesn't redraw (that would close it under you); a redraw that
// comes in meanwhile happens when it closes.
let openMenu = null;
function toggleMoreMenu(btn, c, keys) {
  if (openMenu?.btn === btn) { closeMoreMenu(true); return; }
  closeMoreMenu(false);
  const items = keys.map((k) => {
    const item = actionButton(c, k);
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => closeMoreMenu(false));
    return item;
  });
  const menu = h('div', { class: 'more-menu', role: 'menu', 'aria-label': `More actions for ${c.title}` }, items);
  btn.after(menu);
  btn.setAttribute('aria-expanded', 'true');
  openMenu = { menu, btn };
  items[0]?.focus();
}
function closeMoreMenu(focusButton) {
  if (!openMenu) return;
  const { menu, btn } = openMenu;
  openMenu = null;
  menu.remove();
  btn.setAttribute('aria-expanded', 'false');
  if (focusButton) btn.focus();
  if (redrawWaiting) { redrawWaiting = false; render(); }
}
document.addEventListener('click', (ev) => {
  if (openMenu && !openMenu.menu.contains(ev.target) && ev.target !== openMenu.btn) closeMoreMenu(false);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && openMenu) { ev.preventDefault(); ev.stopPropagation(); closeMoreMenu(true); }
}, true);

/** A running card's body: how long it has been at it, and what you last asked. */
function workingLine(c) {
  const asked = plain(c.lastPrompt).replace(/\s+/g, ' ').trim();
  return h('p', { class: 'working-line' }, h('span', { class: 'working-dot', 'aria-hidden': 'true' }),
    h('span', {}, `Working${c.lastActivity ? ` · ${fmtDur(Date.now() - c.lastActivity)}` : ''}`),
    asked && !c.lastReply ? h('span', { class: 'working-ask' }, ` · ${asked}`) : null);
}

/** One card button (which ones a card gets: `cardActions`). */
function actionButton(c, key) {
  const pending = !!c.pendingPrompt;
  switch (key) {
    case 'answer': return h('button', { type: 'button', class: 'answer', title: 'Answer the question', onclick: () => openAnswer(c) }, 'Answer');
    case 'approve': return h('button', { type: 'button', class: 'approve', title: 'Tell the agent to go ahead', onclick: () => openConfirmApprove(c) }, 'Approve');
    case 'continue': return continueButton(c);
    case 'continue-at': return h('button', { type: 'button', class: 'continue-btn', title: `Send Continue two minutes after the ${c.limit.label} resets (you can cancel until then)`,
      onclick: (ev) => planContinue(c, ev.currentTarget) }, `Continue at ${clockTime(c.limit.continueAt)}`);
    case 'unschedule': return h('button', { type: 'button', title: 'Do not send the planned Continue', onclick: (ev) => cancelPlan(c, ev.currentTarget) }, 'Cancel');
    case 'review': return h('button', { type: 'button', class: 'review-btn', title: 'Look at what the agent made, then say if it is good', onclick: () => openReview(c) }, 'Review');
    case 'changes': return h('button', { type: 'button', title: 'Ask for changes', onclick: () => openCompose(c, 'changes') }, 'Changes');
    case 'reply': return h('button', { type: 'button', disabled: pending, title: pending ? 'Answer the approval first' : 'Reply (mic and / commands available)', onclick: () => openCompose(c, 'reply') }, 'Reply');
    case 'ask': return h('button', { type: 'button', class: 'ask', title: 'Ask any agent about this, without acting', onclick: () => openAsk(c) }, 'Ask');
    case 'defer': return h('button', { type: 'button', class: 'defer', title: 'Not now: tell the agent to hold off and move this card to Closed', onclick: () => openDefer(c) }, 'Defer');
    case 'result': return h('button', { type: 'button', class: 'approve', title: `Send what ${HARNESS[c.harness]} did back to the chat that asked`, onclick: () => openSendResult(c) }, `Send result to ${HARNESS[c.delegation.from.harness]}`);
    case 'resume': return h('button', { type: 'button', class: 'approve', disabled: !c.canReply, title: c.canReply ? 'Tell the agent to pick this back up' : c.replyBlockedReason, onclick: () => openResume(c) }, 'Resume');
    default: return h('button', { type: 'button', onclick: () => openDetails(c) }, 'Details');
  }
}

// Never rebuild the cards under a finger: a redraw between touching and lifting can move the cards,
// and the tap then lands on another card's text (opening it) instead of the button that was pressed. A redraw that
// comes in while the board is being touched waits until 400 ms after the finger lifts (a scroll counts as lifting).
// Only redraws for new data wait (renderSoon); a redraw you asked for (open a project, Show more) happens at once.
let touching = false;
let redrawWaiting = false;
$('board').addEventListener('pointerdown', () => { touching = true; });
const lifted = () => {
  if (!touching) return;
  setTimeout(() => {
    touching = false;
    if (redrawWaiting) { redrawWaiting = false; render(); }
  }, 400);
};
function renderSoon() {
  if (touching || openMenu) { redrawWaiting = true; return; }
  render();
}
document.addEventListener('pointerup', lifted);
document.addEventListener('pointercancel', lifted);

function render() {
  const focus = focusSpot();
  drawBoard();
  showTextEnds($('board'));
  restoreFocus(focus);
}

/** Where keyboard focus is on the board (its card and the button's label), so a redraw can put it back. */
function focusSpot() {
  const el = document.activeElement;
  const card = el?.closest?.('#board article.card');
  if (!card) return null;
  return { id: card.dataset.id, label: el.getAttribute('aria-label') || el.textContent, tag: el.tagName };
}
function restoreFocus(spot) {
  if (!spot || document.activeElement?.closest?.('#board article.card')) return;
  const card = [...$('board').querySelectorAll('article.card')].find((a) => a.dataset.id === spot.id);
  const target = card && [...card.querySelectorAll(spot.tag)].find((el) => (el.getAttribute('aria-label') || el.textContent) === spot.label);
  (target || card)?.focus({ preventScroll: true });
}

function drawBoard() {
  syncSelects();
  if (!state.data) return;
  renderAgentPills();
  drawGlance();
  const all = state.data.cards || [];
  showHealth();

  const cards = filtered();
  const board = $('board');
  board.replaceChildren();
  if (!state.data.generatedAt) { board.append(skeletonCards('Reading every agent for the first time…')); return; }
  if (!cards.length) {
    board.append(h('p', { class: 'empty' }, state.status === 'closed' ? 'Nothing is closed.' : state.needs ? 'Nothing needs you right now.' : 'No sessions match these filters.'));
    return;
  }
  if (state.status === 'closed') {
    board.append(h('section', { class: 'group', 'aria-label': 'Closed' },
      h('h2', {}, 'Closed on the board', h('span', { class: 'gcount' }, `${cards.length} · reopen with ↺, or they come back on their own when something new happens`)),
      h('div', { class: 'cards' }, cards.map(cardEl))));
    return;
  }
  // The Needs you button: just that list.
  if (state.needs) {
    board.append(needsSection(newestFirst(cards)));
    return;
  }
  // The main view (layout A): everything that needs you on top, then every project folded to one line.
  if (foldApplies(state)) {
    const { needs, recent, projects } = boardLayout(cards);
    board.append(needs.length ? needsSection(needs) : allClear(recent));
    if (recent.length) board.append(recentSection(recent));
    board.append(h('h2', { class: 'projects-title' }, 'Projects'));
    for (const p of projects) board.append(projectSection(p.name, p.all, p));
    return;
  }
  // Filtered views (a status chip, an agent, a search): every card inside its project, as before.
  // Projects with Blocked first, then Review, then Running, then the most recent activity; "No project" last.
  const groups = new Map();
  for (const c of cards) {
    if (!groups.has(c.project)) groups.set(c.project, []);
    groups.get(c.project).push(c);
  }
  const has = (list, st) => list.some((c) => c.status === st);
  const rank = (name, list) => [name === 'No project' ? 1 : 0, has(list, 'blocked') ? 0 : 1, has(list, 'review') ? 0 : 1,
    has(list, 'working') ? 0 : 1, -Math.max(...list.map((c) => c.lastActivity || 0))];
  const order = [...groups.entries()].sort(([an, al], [bn, bl]) => {
    const a = rank(an, al); const b = rank(bn, bl);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return an.localeCompare(bn);
  });
  for (const [project, inGroup] of order) board.append(projectSection(project, inGroup));
}

/** Cards per screen: the 3 / 4 / 6 switch on a computer; on a phone two per screen, so two screens' worth. */
function perScreen() {
  return window.matchMedia('(min-width: 760px)').matches ? Number(document.documentElement.dataset.grid || 4) : 4;
}

/**
 * Active: everything else that moved in the last day (running, updates, recently quiet), newest first. It fills one
 * screen; Show more adds another screen's worth (kept across the 5-second refresh, reset on reload).
 */
function recentSection(list) {
  const shown = Math.max(state.recentShown || 0, perScreen());
  const more = list.length - shown;
  // Stalled chats (Update: stopped with a report, nothing asked) can all be pushed on at once.
  const stalled = list.filter((c) => c.status === 'update' && c.canReply);
  return h('section', { class: 'group recent-list', 'aria-label': 'Active' },
    h('h2', { class: 'recent-title' }, 'Active', h('span', { class: 'gcount' }, `${list.length} in the last day`),
      stalled.length > 1 ? h('button', { type: 'button', class: 'continue-all', title: 'Tell every stalled chat to keep going until it needs you', onclick: () => openContinueAll(stalled) }, `Continue all (${stalled.length})`) : null),
    byAgent(list.slice(0, shown)),
    more > 0 ? h('button', { type: 'button', class: 'ghost more', onclick: () => { state.recentShown = shown + perScreen(); render(); } },
      `Show ${Math.min(more, perScreen())} more`) : null);
}

/** Nothing needs you: a calm tile in place of the Needs you section, with what is still going on. */
function allClear(recent) {
  const running = recent.filter((c) => c.status === 'working').length;
  const updates = recent.filter((c) => c.status === 'update').length;
  const rest = [running && `${running} running`, updates && `${updates} with an update`].filter(Boolean).join(' · ');
  return h('section', { class: 'all-clear', 'aria-label': 'Needs you' },
    h('span', { class: 'all-clear-mark', 'aria-hidden': 'true' }, '✓'),
    h('div', {}, h('p', { class: 'all-clear-title' }, 'All clear'),
      h('p', { class: 'all-clear-note' }, rest ? `Nothing needs you. ${rest}.` : 'Nothing needs you right now.')));
}

/** Placeholder cards while the first read of every agent is under way. */
function skeletonCards(label) {
  const one = () => h('div', { class: 'card skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'sk-line sk-title' }), h('div', { class: 'sk-line' }), h('div', { class: 'sk-line sk-short' }), h('div', { class: 'sk-buttons' }));
  return h('div', { class: 'skeleton-board', role: 'status', 'aria-label': label },
    h('p', { class: 'sr-only' }, label), h('div', { class: 'cards' }, one(), one(), one(), one()));
}

/** Every Blocked / Review card, across projects, most recent first. */
function needsSection(list) {
  return h('section', { class: 'group needs-list', 'aria-label': 'Needs you' },
    h('h2', { class: 'needs-title' }, 'Needs you', h('span', { class: 'gcount' }, String(list.length))),
    byAgent(list));
}

/**
 * Cards grouped by agent, in the order of the agent buttons, each under its icon, name and count (each group keeps
 * the list's order). One agent alone (or a filter on one) needs no heading.
 */
function byAgent(list) {
  const order = Object.keys(state.data?.lanes || {});
  const groups = new Map();
  for (const c of list) {
    if (!groups.has(c.harness)) groups.set(c.harness, []);
    groups.get(c.harness).push(c);
  }
  if (groups.size <= 1) return h('div', { class: 'cards' }, list.map(cardEl));
  const rank = (k) => (order.indexOf(k) === -1 ? order.length : order.indexOf(k));
  // One shared grid: a group spans as many columns as it has cards (up to a full row), so agents with one or two
  // cards sit side by side instead of each leaving the rest of its row empty.
  const cols = gridColumns();
  return h('div', { class: 'cards grouped' }, [...groups].sort(([a], [b]) => rank(a) - rank(b)).map(([k, cards]) =>
    h('div', { class: `agent-group span-${Math.min(cards.length, cols)}` },
      h('h3', { class: 'agent-group-title', 'data-accent': laneOf(k).accent || null }, agentIcon(k, 'pill-icon'), nameBesideTag(k), acctBadge(k),
        h('span', { class: 'gcount' }, String(cards.length))),
      cards.map(cardEl))));
}

// The board's card columns, as styles.css sets them (.cards): 1 on a phone, 2 from 760px, 3 from 1200px except
// in the 4-per-screen layout (2).
const GRID_QUERIES = [window.matchMedia('(min-width: 760px)'), window.matchMedia('(min-width: 1200px)')];
function gridColumns() {
  if (!GRID_QUERIES[0].matches) return 1;
  return GRID_QUERIES[1].matches && document.documentElement.dataset.grid !== '4' ? 3 : 2;
}
for (const q of GRID_QUERIES) q.addEventListener('change', () => { if (state.data) render(); });

const COUNT_WORDS = [['blocked', 'blocked'], ['review', 'review'], ['update', 'update'], ['working', 'running'], ['idle', 'idle'], ['done', 'done']];

/** "2 blocked · 1 review · 9 idle" as coloured spans (zero counts left out). */
function countSpans(list) {
  return COUNT_WORDS.map(([st, word]) => [list.filter((c) => c.status === st).length, word, st])
    .filter(([n]) => n).map(([n, word, st]) => h('span', { class: `count ${st}` }, `${n} ${word}`));
}

/** A project in the main view: folded until you open it; its Blocked / Review cards are in Needs you above. */
function mainProject(project, inGroup, { cards, above }) {
  const open = state.mainOpen.has(project);
  const head = h('button', { type: 'button', class: 'project-head', 'aria-expanded': String(open),
    onclick: () => { if (open) state.mainOpen.delete(project); else state.mainOpen.add(project); render(); } },
  h('span', { class: 'project-name' }, project), h('span', { class: 'project-counts' }, countSpans(inGroup)),
  h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'));
  if (!open) return h('section', { class: 'group folded', 'aria-label': project }, h('h2', {}, head));
  const foldDone = state.settings?.foldDone !== false && !state.openDone.has(project);
  const shown = foldDone ? cards.filter((c) => c.status !== 'done') : cards;
  const doneCount = cards.length - shown.length;
  return h('section', { class: 'group', 'aria-label': project },
    h('h2', {}, head),
    above ? h('p', { class: 'note' }, `${above} waiting on you: in Needs you above.`) : null,
    shown.length ? h('div', { class: 'cards' }, shown.map(cardEl)) : null,
    doneCount ? h('button', { type: 'button', class: 'ghost more', onclick: () => { state.openDone.add(project); render(); } }, `Show ${doneCount} done`) : null,
    !foldDone && state.openDone.has(project)
      ? h('button', { type: 'button', class: 'ghost more', onclick: () => { state.openDone.delete(project); render(); } }, 'Hide done') : null,
  );
}

/**
 * One project: a header with its counts (tap to fold away) and its cards in server order (Blocked first).
 * `main` (the main view): { cards, above } — the project starts folded, shows only the cards not already in Needs you,
 * and its header says how many of its cards are up there.
 */
function projectSection(project, inGroup, main = null) {
  if (main) return mainProject(project, inGroup, main);
  const counts = countSpans(inGroup);
  // Settings can start quiet projects (nothing Blocked, Review or Running) folded; your own taps win.
  const quiet = !inGroup.some((c) => ['blocked', 'review', 'working'].includes(c.status));
  const foldedByDefault = !!state.settings?.foldQuietProjects && quiet && !state.opened.has(project);
  const folded = (state.collapsed.has(project) || foldedByDefault) && foldApplies(state);
  const head = h('button', { type: 'button', class: 'project-head', 'aria-expanded': String(!folded),
    onclick: () => {
      if (folded) { state.collapsed.delete(project); state.opened.add(project); } else { state.collapsed.add(project); state.opened.delete(project); }
      render();
    } },
  h('span', { class: 'project-name' }, project), h('span', { class: 'project-counts' }, counts), h('span', { class: 'chev', 'aria-hidden': 'true' }, folded ? '▸' : '▾'));
  if (folded) return h('section', { class: 'group folded', 'aria-label': project }, h('h2', {}, head));
  // Finished sessions fold away unless asked for, so live work stays on screen.
  const foldDone = state.settings?.foldDone !== false && state.status !== 'done' && !state.q && !state.openDone.has(project);
  const shown = foldDone ? inGroup.filter((c) => c.status !== 'done') : inGroup;
  const doneCount = inGroup.length - shown.length;
  return h('section', { class: 'group', 'aria-label': project },
    h('h2', {}, head),
    shown.length ? h('div', { class: 'cards' }, shown.map(cardEl)) : null,
    doneCount ? h('button', { type: 'button', class: 'ghost more', onclick: () => { state.openDone.add(project); render(); } }, `Show ${doneCount} done`) : null,
    !foldDone && state.openDone.has(project) && state.status !== 'done'
      ? h('button', { type: 'button', class: 'ghost more', onclick: () => { state.openDone.delete(project); render(); } }, 'Hide done') : null,
  );
}

// ---------- sheets ----------
function openSheet(title, ...content) {
  sheet.classList.remove('card-sheet'); // a card opened over the board is wide; every other sheet is not
  $('sheetTitle').textContent = title;
  sheetBody.replaceChildren(...content.flat().filter(Boolean));
  if (!sheet.open) sheet.showModal();
  focusSheet();
}

/**
 * Where focus lands in a sheet: its first text box, else the sheet itself (so Tab starts at the top). Never a button:
 * a stray Enter must not approve or send anything.
 */
function focusSheet() {
  const field = sheetBody.querySelector('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])');
  if (field && !field.disabled) { field.focus({ preventScroll: true }); return; }
  sheetBody.tabIndex = -1;
  sheetBody.focus({ preventScroll: true });
}

/**
 * A two-step confirm: shows what will happen, runs `act` on the button (default "Send now"). `tone`: 'go' (green:
 * approve, continue, resume), 'danger' (red: end, remove) or nothing (purple). The button says what it does.
 */
function confirmStep({ intro, preview, images = [], label = 'Send now', tone = '', act, back }) {
  const err = h('p', { class: 'error', role: 'alert' });
  const go = h('button', { type: 'button', class: `primary${tone ? ` ${tone}` : ''}` }, label);
  go.addEventListener('click', async () => {
    go.disabled = true;
    const was = go.textContent;
    go.textContent = 'Working…';
    try {
      await act();
    } catch (e) {
      err.textContent = e.message;
      go.disabled = false;
      go.textContent = was;
    }
  });
  // What will happen in the amber box; the buttons below it, outside.
  return h('div', { class: 'confirm-step' },
    h('div', { class: 'confirm' },
      h('p', {}, intro),
      preview ? h('div', { class: 'bubble you' }, preview) : null,
      imageThumbs(images)),
    err,
    h('div', { class: 'row' }, back ? h('button', { type: 'button', onclick: back }, 'Back') : h('button', { type: 'button', onclick: () => sheet.close() }, 'Cancel'), go),
  );
}

// ---------- agent menu (press and hold a pill) ----------
// ---------- plan usage (lib/usage.js) ----------
/** "Session 10% used · resets 6:10 PM · Week 4% used · resets Sat 12:59 PM", or '' when there is no reading. */
function usageText(u) {
  if (!u?.windows?.length) return '';
  return u.windows.map((w) => `${w.name} ${w.used}% used${w.resetsAt ? ` · resets ${clockTime(w.resetsAt)}` : ''}`).join(' · ');
}

/**
 * The agent button's outline as a gauge: it drains clockwise from 12 o'clock as the tighter window (session or week)
 * fills; green, amber from 75% used, red from 90%. No reading, no ring. Drawn as a path around the pill, so the
 * length shown is the share left (an angle from the middle would misread a wide pill).
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const ringSizer = new ResizeObserver((entries) => { for (const e of entries) shapeRing(e.target); });
function usageRing(btn, u) {
  if (!u?.windows?.length) return;
  const used = Math.max(...u.windows.map((w) => w.used));
  btn.classList.add('has-usage');
  if (used >= 90) btn.classList.add('usage-high');
  else if (used >= 75) btn.classList.add('usage-warn');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'usage-ring');
  svg.setAttribute('aria-hidden', 'true');
  for (const part of ['track', 'fill']) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('class', part);
    p.setAttribute('pathLength', '100');
    svg.append(p);
  }
  svg.lastChild.setAttribute('stroke-dasharray', `${100 - used} 100`);
  btn.prepend(svg);
}
/**
 * The button's outline, from 12 o'clock clockwise, for its current size and its own corner radius (a round pill in
 * the classic style, rounder or squarer corners in another style), so the gauge always sits on the button's edge.
 */
function shapeRing(btn) {
  const svg = btn.querySelector('.usage-ring');
  const w = btn.offsetWidth;
  const hgt = btn.offsetHeight;
  if (!svg || !w || !hgt) return;
  const s = 1; // half the stroke: the line sits on the button's edge
  const radius = parseFloat(getComputedStyle(btn).borderTopLeftRadius) || 0;
  const r = Math.max(0, Math.min(radius, hgt / 2, w / 2) - s);
  const d = [`M ${w / 2} ${s}`, `H ${w - s - r}`, `A ${r} ${r} 0 0 1 ${w - s} ${s + r}`, `V ${hgt - s - r}`,
    `A ${r} ${r} 0 0 1 ${w - s - r} ${hgt - s}`, `H ${s + r}`, `A ${r} ${r} 0 0 1 ${s} ${hgt - s - r}`, `V ${s + r}`,
    `A ${r} ${r} 0 0 1 ${s + r} ${s}`, 'Z'].join(' ');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  for (const p of svg.children) p.setAttribute('d', d);
}
// A new style can change the buttons' corners: redraw every gauge.
window.addEventListener('agenthub-theme', () => requestAnimationFrame(() => {
  for (const btn of document.querySelectorAll('.agent-pill.has-usage')) shapeRing(btn);
}));

function laneInfo(key, lane) {
  const cards = (state.data.cards || []).filter((c) => c.harness === key);
  const count = (s) => cards.filter((c) => c.status === s).length;
  return [
    h('dl', { class: 'kv' },
      h('dt', {}, 'Light'), h('dd', {}, `${HEALTH_WORD[lane.health] || (lane.connected ? 'ready' : 'down')}: ${lane.why || lane.reason}`),
      h('dt', {}, 'Connection'), h('dd', {}, lane.connected ? 'Connected' : 'NOT CONNECTED'),
      h('dt', {}, 'Checked'), h('dd', {}, `${ago(lane.checkedAt)} (${lane.ms} ms)`),
      h('dt', {}, 'On the board'), h('dd', {}, `${cards.length} sessions · ${count('blocked')} blocked · ${count('review')} to review · ${count('working')} running`),
      lane.usage ? [h('dt', {}, 'Plan usage'), h('dd', {}, usageText(lane.usage) || `No reading: ${lane.usage.why}`)] : null),
    h('div', { class: 'bubble' }, lane.reason),
    runsInFolder(key)
      ? h('p', { class: 'note' }, `To answer ${lane.name} from here, start it with New chat on this board (it runs in tmux). Sessions started elsewhere are read-only.`) : null,
  ];
}

function openAgentMenu(key) {
  const lane = state.data.lanes[key];
  const on = state.harness === key;
  openSheet(lane.name,
    h('p', { class: 'muted lane-line' }, agentIcon(key, 'pill-icon'), h('span', { class: `light${lane.connected ? '' : ' off'}`, 'aria-hidden': 'true' }), lane.connected ? 'Connected' : 'Not connected'),
    h('div', { class: 'menu-list' },
      h('button', { type: 'button', onclick: () => { setHarness(on ? 'all' : key); sheet.close(); } }, on ? 'Show all agents' : `Show only ${lane.name}`),
      h('button', { type: 'button', onclick: () => openSheet(`${lane.name} · details`, laneInfo(key, lane), h('button', { type: 'button', onclick: () => openAgentMenu(key) }, 'Back')) }, 'View details'),
      h('button', { type: 'button', title: 'Its button and cards leave this board on this device (for screenshots). It keeps running.', onclick: () => {
        setHidden(key, true);
        sheet.close();
        toast('Hidden on this device. Press and hold All to show it again.');
      } }, 'Hide from this board'),
      lane.canRestart ? h('button', { type: 'button', class: 'danger', onclick: () => openRestart(key) }, 'Restart gateway…') : null));
}

function openRestart(key) {
  const lane = state.data.lanes[key];
  openSheet(`Restart ${lane.name} gateway`, confirmStep({
    intro: `This restarts the ${lane.name} gateway service on the computer. Any ${lane.name} chat that is running right now is interrupted, and the ${lane.name} app reconnects on its own. It takes 10–60 seconds.`,
    label: 'Restart now',
    back: () => openAgentMenu(key),
    act: async () => {
      // Orange light from the tap until the board has looked again after the restart.
      state.restarting.add(key);
      renderAgentPills();
      try {
        const { output } = await post('/api/lane', { lane: key, action: 'restart', confirm: true });
        openSheet(`${lane.name} gateway restarted`, h('div', { class: 'bubble' }, output || 'Restarted.'), h('button', { type: 'button', onclick: () => sheet.close() }, 'Close'));
      } finally {
        setTimeout(() => { state.restarting.delete(key); renderAgentPills(); load(); }, 6000);
      }
    },
  }));
}

// ---------- close / end ----------
const END_HOW = {
  hermes: 'ends the chat in Hermes, the same as closing it there. It stays in Hermes\'s history and can be reopened.',
  openclaw: 'archives the chat in OpenClaw. You can unarchive it there.',
  codex: 'types /exit in its terminal. The session is saved; resume it later with codex resume.',
};

/** What End chat does for this agent; every Claude Code account resumes with its own command. */
function endHow(harness) {
  if (kindOf(harness) === 'claude') return `types /exit in its terminal. The session is saved; resume it later with ${laneOf(harness).command || 'claude'} --resume.`;
  return END_HOW[harness] || END_HOW[kindOf(harness)] || '';
}

/** Defer: tell the agent to hold off (Esc first on a terminal menu) and move the card to Closed. Confirmed first. */
function openDefer(c) {
  const menu = !!c.pendingPrompt && runsInFolder(c.harness);
  openSheet(`Defer · ${c.title}`, confirmStep({
    intro: `This tells ${HARNESS[c.harness]} to hold off${menu ? ' (Esc closes the menu on screen first)' : ''} and moves the card to Closed. It comes back when you write in this chat again, or when you tap Resume.`,
    preview: DEFER_TEXT,
    label: 'Defer',
    act: async () => {
      // The menu you saw: if the card shows a different one by now, the server presses nothing.
      const { output } = await post('/api/defer', { id: c.id, confirm: true, expectPrompt: !!c.pendingPrompt, expectText: c.question?.expect || c.pendingPrompt || '' });
      sheet.close();
      toast(output);
      load();
    },
  }));
}

/** Resume a deferred card: tell the agent to pick it back up and put the card back on the board. Confirmed first. */
function openResume(c) {
  openSheet(`Resume · ${c.title}`, confirmStep({
    intro: `This tells ${HARNESS[c.harness]} to pick this back up and puts the card back on the board.`,
    preview: RESUME_TEXT,
    label: 'Resume', tone: 'go',
    act: async () => {
      const { output } = await post('/api/resume', { id: c.id, confirm: true });
      sheet.close();
      toast(output);
      load();
    },
  }));
}

async function reopen(c) {
  try {
    await post('/api/reopen', { id: c.id });
    toast('Reopened');
    load();
  } catch (e) { toast(e.message); }
}

function openClose(c) {
  const err = h('p', { class: 'error', role: 'alert' });
  const closeBtn = h('button', { type: 'button', class: 'primary' }, 'Close on this board');
  closeBtn.addEventListener('click', async () => {
    closeBtn.disabled = true;
    try {
      await post('/api/close', { id: c.id, mode: 'board' });
      sheet.close();
      toast('Closed. It comes back if anything new happens.');
      load();
    } catch (e) { err.textContent = e.message; closeBtn.disabled = false; }
  });
  const endBtn = h('button', { type: 'button', class: 'danger', disabled: !c.canEnd }, `End chat in ${HARNESS[c.harness]}…`);
  endBtn.addEventListener('click', () => openSheet(`End · ${c.title}`, confirmStep({
    intro: `This ${endHow(c.harness)} It also closes the card here.`,
    label: 'End chat', tone: 'danger',
    back: () => openClose(c),
    act: async () => {
      const { output } = await post('/api/close', { id: c.id, mode: 'end', confirm: true });
      sheet.close();
      toast(output || 'Ended');
      setTimeout(load, 1500);
    },
  })));
  openSheet(`Close · ${c.title}`,
    h('p', {}, h('b', {}, 'Close on this board'), ' hides this card. Nothing is sent to the agent, and the card comes back by itself if the chat has new activity. Find closed cards under the “Closed” filter.'),
    h('p', {}, h('b', {}, `End chat in ${HARNESS[c.harness]}`), ` ${endHow(c.harness)}`),
    c.canEnd ? null : h('p', { class: 'note' }, c.status === 'done' ? 'This chat has already ended.' : (c.status === 'working' ? 'The agent is working right now.' : (c.replyBlockedReason || 'The board cannot reach this chat to end it.')) + ' You can still close it on this board.'),
    err,
    h('div', { class: 'menu-list' }, closeBtn, endBtn));
}

// ---------- details ----------
function cardHeader(c) {
  return h('dl', { class: 'kv' },
    h('dt', {}, 'Agent'), h('dd', {}, HARNESS[c.harness]),
    h('dt', {}, 'Project'), h('dd', {}, c.project),
    h('dt', {}, 'Status'), h('dd', {}, `${c.needsApproval ? 'Needs approval' : STATUS_LABEL[c.status]}${c.status === 'blocked' || c.status === 'review' ? ` for ${fmtDur(Date.now() - c.waitingSince)}` : ''}`),
    h('dt', {}, 'Last activity'), h('dd', {}, c.lastActivity ? `${new Date(c.lastActivity).toLocaleString()} (${ago(c.lastActivity)})` : 'unknown'),
    c.cwd ? [h('dt', {}, 'Folder'), h('dd', {}, c.cwd)] : null,
    c.model ? [h('dt', {}, 'Model'), h('dd', {}, c.model)] : null,
    c.source ? [h('dt', {}, 'Source'), h('dd', {}, c.source)] : null,
    h('dt', {}, 'Session'), h('dd', {}, c.ref),
    !c.canReply ? [h('dt', {}, 'Replies'), h('dd', {}, c.replyBlockedReason)] : null,
  );
}

function handoffHistory(c) {
  const ho = c.handoff;
  if (!ho) return null;
  if (ho.role === 'from') {
    return h('div', { class: 'bubble handoff-note' },
      h('span', { class: 'who' }, `Handoff · ${when(ho.at)}`),
      `Handed off to ${HARNESS[ho.to.harness]}${ho.to.target ? ` (tmux ${ho.to.target})` : ''}. ${HARNESS[ho.to.harness]} owns this task now.\n\nTask: ${ho.task}\n\n`,
      ho.notified ? `${HARNESS[c.harness]} was told to stop.` : `${HARNESS[c.harness]} could not be told to stop: ${ho.notifyError}`);
  }
  return h('div', { class: 'bubble handoff-note' },
    h('span', { class: 'who' }, `Handoff · ${when(ho.at)}`),
    `You handed this over from ${HARNESS[ho.from.harness]} session “${ho.from.title}”.\n\nTask: ${ho.task}`);
}

async function openDetails(c) {
  const list = h('div', {}, h('p', { class: 'muted' }, 'Loading recent messages…'));
  const canHandOff = !c.pendingPrompt && c.handoff?.role !== 'from';
  openSheet(c.title,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'ask', onclick: () => openAsk(c) }, 'Ask an agent…'),
      h('button', { type: 'button', disabled: !canHandOff, title: canHandOff ? 'Give this task to another agent' : (c.pendingPrompt ? 'Answer the approval first' : 'Already handed off'), onclick: () => openHandoff(c) }, 'Hand off…'),
      c.harness === HELPER ? null : h('button', { type: 'button', disabled: !!delegateBlocked(c), title: delegateBlocked(c) || `${HARNESS[HELPER]} does one thing this chat asked you to do, then you send the result back`, onclick: () => openDelegate(c) }, `Have ${HARNESS[HELPER]} do it…`)),
    cardHeader(c), handoffHistory(c), linksRow(c), list);
  try {
    const { messages, screen } = await api(`/api/messages?id=${encodeURIComponent(c.id)}`);
    if (screen) sheetBody.append(h('h3', {}, 'Terminal now (tmux)'), h('pre', { class: 'screen' }, screen.split('\n').slice(-25).join('\n')));
    list.replaceWith(h('div', { class: 'thread' }, messages.length
      ? messages.map((m) => h('div', { class: `bubble ${m.role}` }, h('span', { class: 'who' }, `${m.role === 'you' ? 'You' : HARNESS[c.harness]}${m.ts ? ` · ${new Date(m.ts).toLocaleString()}` : ''}`), m.text))
      : h('p', { class: 'muted' }, 'No readable messages.')));
  } catch (e) {
    list.replaceWith(h('p', { class: 'error' }, e.message));
  }
}

// ---------- link previews ----------
async function openPreview(c, link, retake = false, extra = null) {
  const box = h('div', {}, h('p', { class: 'muted' }, retake || !c.previews?.[link] ? 'Taking a screenshot on the computer… (5–20 seconds)' : 'Loading…'));
  openSheet('Preview', h('p', { class: 'muted link-full' }, link), box);
  try {
    const meta = await post('/api/preview', { id: c.id, link, refresh: retake });
    c.previews = { ...(c.previews || {}), [link]: { key: meta.key, takenAt: meta.takenAt } };
    const full = `/api/preview-img?k=${meta.key}&size=full&t=${meta.takenAt}`;
    box.replaceChildren(
      h('a', { href: full, target: '_blank', rel: 'noopener', class: 'shot-link', title: 'Open the full-size screenshot' },
        h('img', { class: 'shot', src: full, alt: `Screenshot of ${link}` })),
      h('p', { class: 'note' }, `Screenshot taken ${ago(meta.takenAt)}.${meta.macOnly ? ' This link only opens on the computer (it is local), so the screenshot is what you can see from here. Tap it for full size.' : ' Tap it for full size.'}`),
      h('div', { class: 'row' },
        !meta.macOnly ? h('a', { class: 'button primary', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open page') : null,
        h('button', { type: 'button', onclick: () => openPreview(c, link, true, extra) }, 'Retake')),
      extra);
  } catch (e) {
    box.replaceChildren(h('p', { class: 'error' }, e.message), extra);
  }
}

// ---------- Continue: push an agent that stopped with a report and asks nothing ----------
const UNDO_MS = 5000;
const SENT_MS = 4000; // how long the button says "Sent" before the card shows the agent at work
const pendingContinue = new Map(); // card id -> { timer, at }
const continued = new Map(); // card id -> when its Continue went

/** Send the Continue message to one chat. */
function sendContinue(c) {
  return post('/api/action', { id: c.id, kind: 'reply', text: CONTINUE_TEXT, confirm: true, expectPrompt: false, expectText: '' });
}

/**
 * The Continue button, in place on its card (no pop-ups). Tapped, it becomes Undo with a green fill that
 * drains over the 5 seconds; tapping Undo cancels and it is Continue again. Once sent it says Sent for a moment, then
 * the card shows the agent at work. A redraw keeps the countdown where it was.
 */
function continueButton(c) {
  const pending = pendingContinue.get(c.id);
  if (pending) {
    const left = Math.max(0, UNDO_MS - (Date.now() - pending.at));
    const b = h('button', { type: 'button', class: 'continue-btn counting', title: 'Sending in a moment: tap to cancel',
      'aria-label': `Continue goes in ${Math.ceil(left / 1000)} seconds. Tap to undo.`, onclick: () => undoContinue(c, b) }, 'Undo');
    b.style.setProperty('--undo-ms', `${UNDO_MS}ms`);
    b.style.setProperty('--undo-at', `${left - UNDO_MS}ms`);
    return b;
  }
  const sentAt = continued.get(c.id);
  if (sentAt && Date.now() - sentAt < SENT_MS) {
    return h('button', { type: 'button', class: 'continue-btn sent', disabled: true, 'aria-label': 'Continue sent' }, h('span', { class: 'sent-tick', 'aria-hidden': 'true' }, '✓'), 'Sent');
  }
  const b = h('button', { type: 'button', class: 'continue-btn', title: 'Tell the agent to keep going until it needs you (5 seconds to undo)', onclick: () => continueWithUndo(c, b) }, 'Continue');
  return b;
}

/** One tap: the Continue message goes after 5 seconds unless Undo is pressed. */
function continueWithUndo(c, btn) {
  if (pendingContinue.has(c.id)) return;
  const timer = setTimeout(async () => {
    pendingContinue.delete(c.id);
    try {
      await sendContinue(c);
      continued.set(c.id, Date.now());
      swapContinue(c);
      setTimeout(() => { continued.delete(c.id); renderSoon(); }, SENT_MS);
      setTimeout(load, 1500);
    } catch (e) {
      swapContinue(c);
      toast(`Continue not sent: ${e.message}`);
    }
  }, UNDO_MS);
  pendingContinue.set(c.id, { timer, at: Date.now() });
  btn.replaceWith(continueButton(c));
}

function undoContinue(c, btn) {
  clearTimeout(pendingContinue.get(c.id)?.timer);
  pendingContinue.delete(c.id);
  btn.replaceWith(continueButton(c));
}

/** Redraw the Continue button on this card, wherever it is on the board now. */
function swapContinue(c) {
  for (const card of document.querySelectorAll('article.card')) {
    if (card.dataset.id !== c.id) continue;
    card.querySelector('.continue-btn')?.replaceWith(continueButton(c));
  }
}

/** Continue all: every Update card the board can reply to, after one confirm that lists them. */
function openContinueAll(list) {
  openSheet(`Continue ${list.length} chats`, confirmStep({
    intro: `Sends this to each chat below. Each agent carries on until it needs you, then stops and says what it needs.`,
    preview: `${CONTINUE_TEXT}\n\nTo: ${list.map((c) => `${c.title} (${HARNESS[c.harness]})`).join('; ')}`,
    label: `Continue all ${list.length}`, tone: 'go',
    act: async () => {
      const failed = [];
      for (const c of list) {
        try { await sendContinue(c); continued.set(c.id, Date.now()); } catch (e) { failed.push(`${c.title}: ${e.message}`); }
      }
      // Each card that went says Sent for a moment, in place (no pop-up).
      render();
      setTimeout(() => { for (const c of list) continued.delete(c.id); renderSoon(); }, SENT_MS);
      if (!failed.length) sheet.close();
      else {
        openSheet('Continue all', h('p', {}, `Sent to ${list.length - failed.length} of ${list.length}. Not sent:`),
          h('ul', {}, failed.map((f) => h('li', {}, f))), h('button', { type: 'button', onclick: () => sheet.close() }, 'Close'));
      }
      setTimeout(load, 1500);
    },
  }));
}

// ---------- Review: the agent handed over work to look at ----------
const ASK_FOR_LINK = 'Please send me the link (or the local file path) to what you want me to review. If it only runs on your machine, start the preview and give me its localhost address.';

/** After looking: say it's good, or ask for changes. Nothing is sent without the usual confirm step. */
function reviewVerdict(c) {
  return h('div', { class: 'review-verdict' },
    h('p', { class: 'note' }, 'When you have looked:'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'approve', onclick: () => openSheet(`Review · ${c.title}`, confirmBlock(c, 'reply', 'I reviewed it. Looks good.', 'I reviewed it. Looks good.', () => openReview(c))) }, 'Looks good'),
      h('button', { type: 'button', onclick: () => openCompose(c, 'changes') }, 'Needs changes…')));
}

/**
 * Review: the page or file the agent wants checked. One link opens straight into its screenshot; several are listed;
 * none means the agent didn't say where it is, so the sheet offers to ask for it.
 */
function openReview(c) {
  const links = c.links || [];
  if (links.length === 1) { openPreview(c, links[0], false, reviewVerdict(c)); return; }
  if (links.length > 1) {
    openSheet(`Review · ${c.title}`, h('p', { class: 'note' }, 'The agent shared these. Tap one to see it.'), linksRow(c), reviewVerdict(c));
    return;
  }
  openSheet(`Review · ${c.title}`,
    h('p', {}, 'The agent says this is ready to look at, but its messages don\'t include a link or file to open.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onclick: () => openSheet(`Review · ${c.title}`, confirmBlock(c, 'reply', ASK_FOR_LINK, ASK_FOR_LINK, () => openReview(c))) }, 'Ask for the link')),
    reviewVerdict(c));
}

// ---------- Ask Agent ----------
/** Agents the board can use right now (connected, and not hidden on this device). */
function connectedAgents() {
  return Object.entries(state.data.lanes || {}).filter(([k, l]) => l.connected && !isHidden(k)).map(([k]) => k);
}

function openAsk(c) {
  const agents = connectedAgents();
  const select = h('select', { 'aria-label': 'Agent to ask' },
    agents.map((k) => h('option', { value: k, selected: k === c.harness }, `${HARNESS[k]}${k === c.harness ? ' (owns this session)' : ''}`)));
  const sideRadio = h('input', { type: 'radio', name: 'askMode', value: 'side', checked: true });
  const inRadio = h('input', { type: 'radio', name: 'askMode', value: 'session' });
  const inLabel = h('label', { class: 'radio' }, inRadio, h('span', {}, h('b', {}, 'In this session'), ' — sent as a normal message; the agent may act on it'));
  const inNote = h('p', { class: 'note' });
  const syncMode = () => {
    const ok = select.value === c.harness && c.canReply && !c.pendingPrompt;
    inRadio.disabled = !ok;
    inLabel.classList.toggle('disabled', !ok);
    const why = ok ? '' : (select.value !== c.harness ? `Only ${HARNESS[c.harness]} owns this session` : (c.replyBlockedReason || 'Answer the approval first'));
    inLabel.title = why;
    inNote.textContent = why; // shown as text too: phones can't show a tooltip
    if (!ok) sideRadio.checked = true;
  };
  select.addEventListener('change', syncMode);
  const ta = h('textarea', { 'aria-label': 'Your question', placeholder: 'e.g. What is this waiting on, and is it safe to approve?' });
  const err = h('p', { class: 'error', role: 'alert' });
  const ask = h('button', { type: 'button', class: 'primary' }, 'Ask');
  const out = h('div', { class: 'answer-area' });
  ask.addEventListener('click', async () => {
    const q = ta.value.trim();
    err.textContent = '';
    if (!q) { err.textContent = 'Type a question first.'; return; }
    const agent = select.value;
    if (inRadio.checked) { askInSession(c, q, out); return; }
    ask.disabled = true;
    out.replaceChildren(h('p', { class: 'muted' }, `${HARNESS[agent]} is thinking… (usually 5–60 seconds)`));
    try {
      const { answer } = await post('/api/ask', { id: c.id, agent, question: q });
      const canPost = c.canReply && !c.pendingPrompt;
      out.replaceChildren(...[
        h('div', { class: 'bubble' }, h('span', { class: 'who' }, `${HARNESS[agent]} · side chat (nothing was changed)`), answer),
        h('div', { class: 'row' },
          canPost ? h('button', { type: 'button', onclick: () => postAnswer(c, agent, q, answer) }, 'Post to this session…') : null,
          h('button', { type: 'button', onclick: async () => { await navigator.clipboard?.writeText(answer).catch(() => {}); toast('Answer copied'); } }, 'Copy')),
        canPost ? null : h('p', { class: 'note' }, c.pendingPrompt ? 'Answer the approval before posting into this session.' : c.replyBlockedReason),
      ].filter(Boolean));
    } catch (e) {
      out.replaceChildren(h('p', { class: 'error' }, e.message));
    } finally {
      ask.disabled = false;
    }
  });
  openSheet(`Ask · ${c.title}`,
    h('label', { class: 'field' }, h('span', {}, 'Ask'), select),
    h('fieldset', { class: 'modes' }, h('legend', { class: 'sr-only' }, 'Where to ask'),
      h('label', { class: 'radio' }, sideRadio, h('span', {}, h('b', {}, 'Side chat'), ' — answers only, nothing is changed')),
      inLabel,
      inNote),
    ta, err, h('div', { class: 'row' }, ask), out);
  syncMode();
  ta.focus();
}

/** Relay a side-chat answer into the card's own session (two taps, like any send). */
function postAnswer(c, agent, q, answer) {
  const text = `${HARNESS[agent]} was asked from AgentHub: ${q}\n\n${HARNESS[agent]}'s answer:\n${answer}`;
  openSheet(`Post · ${c.title}`, confirmBlock(c, 'reply', text, text));
}

/** Ask the owning agent inside its own session (two taps), then wait for its next reply. */
function askInSession(c, q, out) {
  out.replaceChildren(confirmStep({
    intro: `This sends your question to ${HARNESS[c.harness]} session “${c.title}” as a normal message. The agent may act on it.`,
    preview: q,
    back: () => out.replaceChildren(),
    act: async () => {
      const sentAt = Date.now() - 5000;
      const res = await post('/api/action', { id: c.id, kind: 'reply', text: q, confirm: true, expectPrompt: false, expectText: '' });
      if (res.output) { out.replaceChildren(h('div', { class: 'bubble' }, h('span', { class: 'who' }, HARNESS[c.harness]), res.output)); return; }
      out.replaceChildren(h('p', { class: 'muted' }, `Sent. Waiting for ${HARNESS[c.harness]}'s reply…`));
      for (let i = 0; i < 45 && sheet.open; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const { messages } = await api(`/api/messages?id=${encodeURIComponent(c.id)}`).catch(() => ({ messages: [] }));
        const reply = [...messages].reverse().find((m) => m.role === 'agent' && m.ts && m.ts > sentAt);
        if (reply) { out.replaceChildren(h('div', { class: 'bubble' }, h('span', { class: 'who' }, `${HARNESS[c.harness]} · ${new Date(reply.ts).toLocaleTimeString()}`), reply.text)); return; }
      }
      if (sheet.open) out.replaceChildren(h('p', { class: 'note' }, 'No reply yet. It will show on the card when it arrives.'));
    },
  }));
}

// ---------- hand off ----------
function openHandoff(c) {
  const targets = connectedAgents().filter((k) => k !== c.harness);
  if (!targets.length) { openSheet('Hand off', h('p', {}, 'No other agent is connected right now.')); return; }
  const to = h('select', { 'aria-label': 'Hand off to' }, targets.map((k) => h('option', { value: k }, HARNESS[k])));
  const folders = [...(c.cwd ? [{ label: `This session's folder · ${folderName(c.cwd)}`, path: c.cwd }] : []), ...(state.data.folders || []).filter((f) => f.path !== c.cwd)];
  const folder = h('select', { 'aria-label': 'Folder to work in' }, folders.map((f) => h('option', { value: f.path }, f.label)));
  const folderField = h('label', { class: 'field' }, h('span', {}, 'Folder'), folder);
  const needsFolder = () => runsInFolder(to.value); // every Claude Code account, and Codex
  const sync = () => { folderField.hidden = !needsFolder(); };
  to.addEventListener('change', sync);
  const ta = h('textarea', { 'aria-label': 'Task for the new owner', placeholder: 'What should it do? e.g. Finish the pricing page, then run the tests.' });
  const err = h('p', { class: 'error', role: 'alert' });
  const next = h('button', { type: 'button', class: 'primary' }, 'Review…');
  const form = h('div', {},
    h('p', { class: 'muted' }, `The new agent gets this session's project, your last request, the last output and your task, and takes ownership. ${HARNESS[c.harness]} is told to stop. Ownership moves; it is never shared.`),
    h('label', { class: 'field' }, h('span', {}, 'Hand off to'), to), folderField, ta, err, h('div', { class: 'row' }, next));
  next.addEventListener('click', () => {
    const task = ta.value.trim();
    if (!task) { err.textContent = 'Say what the new owner should do.'; return; }
    const target = to.value;
    const cwd = needsFolder() ? folder.value : (c.cwd || '');
    if (needsFolder() && !cwd) { err.textContent = 'Pick a folder to work in.'; return; }
    form.replaceWith(confirmStep({
      intro: `This starts a new ${HARNESS[target]} session${needsFolder() ? ` in ${cwd} (in tmux, so you can answer it from here)` : ''} that owns this task, then tells ${HARNESS[c.harness]} to stop working on “${c.title}”.`,
      preview: `Task for ${HARNESS[target]}:\n${task}`,
      label: 'Hand off now',
      back: () => openHandoff(c),
      act: async () => {
        const { record } = await post('/api/handoff', { id: c.id, to: target, task, folder: cwd, confirm: true });
        sheet.close();
        toast(record.notified ? `Handed off to ${HARNESS[target]}` : `Handed off to ${HARNESS[target]}; ${HARNESS[c.harness]} could not be told to stop`);
        setTimeout(load, 1500);
      },
    }));
  });
  openSheet(`Hand off · ${c.title}`, form);
  sync();
}

// ---------- have another agent do it (lib/delegate.js) ----------
// One task this chat asked you to do (run something, grant something) goes to a helper agent; the chat keeps its
// task. The server takes any agent; the page offers Hermes only for now.
const HELPER = 'hermes';

/** Why this chat can't use the helper right now ('' = it can). The server checks again (cannotDelegate). */
function delegateBlocked(c) {
  if (isHidden(HELPER)) return `${HARNESS[HELPER]} is hidden on this device (Settings → On this device).`;
  if (!connectedAgents().includes(HELPER)) return `${HARNESS[HELPER]} isn't running right now.`;
  if (c.handoff?.role === 'from') return 'This task was handed off; it belongs to another agent now.';
  if (c.pendingPrompt) return 'It is waiting on an approval: answer or deny that first.';
  if (!['blocked', 'review', 'update'].includes(c.status)) return 'Only for a chat that is waiting on you.';
  return '';
}

function openDelegate(c, draft = '') {
  const helper = HELPER;
  const ta = h('textarea', { 'aria-label': `Task for ${HARNESS[helper]}`, placeholder: `What should ${HARNESS[helper]} do?` });
  // Prefilled with what the agent asked for; you edit it. What you leave here is the helper's only instruction.
  ta.value = draft || c.ask || c.lastReply || '';
  const folders = [...(c.cwd ? [{ label: `This session's folder · ${folderName(c.cwd)}`, path: c.cwd }] : []), ...(state.data.folders || []).filter((f) => f.path !== c.cwd)];
  const folder = h('select', { 'aria-label': 'Folder to work in' }, folders.map((f) => h('option', { value: f.path }, f.label)));
  const err = h('p', { class: 'error', role: 'alert' });
  const next = h('button', { type: 'button', class: 'primary' }, 'Review…');
  const form = h('div', {},
    h('p', { class: 'muted' }, `${HARNESS[helper]} starts a new chat and does only what this box says. Trim it to the one thing to do. ${HARNESS[c.harness]} keeps its task and is told nothing; when ${HARNESS[helper]} is done, its card offers to send the result back here.`),
    ta,
    folders.length ? h('label', { class: 'field' }, h('span', {}, 'Folder'), folder) : null,
    err, h('div', { class: 'row' }, next));
  next.addEventListener('click', async () => {
    const task = ta.value.trim();
    if (!task) { err.textContent = `Say what ${HARNESS[helper]} should do.`; return; }
    const cwd = folders.length ? folder.value : '';
    next.disabled = true;
    try {
      // The exact first message the helper will get, so nothing is sent unseen.
      const { prompt } = await post('/api/delegate', { id: c.id, to: helper, task, folder: cwd, preview: true });
      form.replaceWith(confirmStep({
        intro: `This starts a new ${HARNESS[helper]} chat with the message below. Anything it needs permission for shows here as usual.`,
        preview: prompt,
        label: `Send to ${HARNESS[helper]}`,
        back: () => openDelegate(c, task),
        act: async () => {
          await post('/api/delegate', { id: c.id, to: helper, task, folder: cwd, confirm: true });
          sheet.close();
          toast(`${HARNESS[helper]} is on it`);
          setTimeout(load, 1500);
        },
      }));
    } catch (e) {
      err.textContent = e.message;
      next.disabled = false;
    }
  });
  openSheet(`Have ${HARNESS[helper]} do it · ${c.title}`, form);
}

/** The helper finished: check its report, then send it to the chat that asked (as your reply). */
function openSendResult(c, draft = '') {
  const d = c.delegation;
  const fromName = HARNESS[d.from.harness];
  const from = (state.allCards || []).find((x) => x.id === d.from.id); // even when its agent is hidden on this device
  const ta = h('textarea', { 'aria-label': `Result for ${fromName}` });
  ta.value = draft || d.result;
  const copy = h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(ta.value).then(() => toast('Copied')).catch(() => toast('Copy not available here')) }, 'Copy');
  // Can't send: say why and offer the text to paste by hand.
  const blocked = !from ? `The chat that asked (“${d.from.title}”) is not on the board any more.`
    : !from.canReply ? from.replyBlockedReason || `The board cannot send to that ${fromName} chat.`
      : from.pendingPrompt ? `${fromName} is showing an approval right now. Answer that first, then send the result.` : '';
  const err = h('p', { class: 'error', role: 'alert' }, blocked ? `${blocked} Copy the report and paste it there.` : '');
  const next = h('button', { type: 'button', class: 'primary', disabled: !!blocked }, 'Review…');
  const form = h('div', {},
    h('p', { class: 'muted' }, `${HARNESS[c.harness]}'s report for ${fromName} “${d.from.title}”. Edit it if you like; it is sent as your reply.`),
    d.resultFound ? null : h('p', { class: 'note' }, `${HARNESS[c.harness]} didn't mark a RESULT section, so this is the end of its last reply.`),
    ta, err, h('div', { class: 'row' }, copy, next));
  next.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) { err.textContent = 'Type a message first.'; return; }
    form.replaceWith(confirmStep({
      intro: `This sends the message below to ${fromName} chat “${d.from.title}”. The agent will act on it.`,
      preview: text,
      label: `Send to ${fromName}`,
      back: () => openSendResult(c, text),
      act: async () => {
        await post('/api/delegate/result', { id: c.id, text, confirm: true });
        sheet.close();
        toast(`Result sent to ${fromName}`);
        setTimeout(load, 1500);
      },
    }));
  });
  openSheet(`Send result · ${d.from.title}`, form);
}

// ---------- approve / changes / reply ----------
/** A terminal approval menu (tmux) needs the full screen shown; a structured request (Hermes) is complete as is. */
function isMenu(c) { return !!c.pendingPrompt && c.approvalStyle !== 'request'; }

function openConfirmApprove(c) {
  const preview = !c.pendingPrompt ? 'Approved. Go ahead.'
    : isMenu(c) ? `Press “Yes” on this approval menu:\n\n${c.pendingPrompt}`
      : `Approve this request once (it will ask again next time):\n\n${c.pendingPrompt}`;
  openSheet(`Approve · ${c.title}`, confirmBlock(c, 'approve', preview, ''), isMenu(c) ? fullScreen(c) : null);
}

/** For menu approvals: the whole terminal screen, so nothing above the menu is hidden. */
function fullScreen(c) {
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading the full terminal screen…'));
  api(`/api/messages?id=${encodeURIComponent(c.id)}`)
    .then(({ screen }) => box.replaceChildren(
      h('h3', {}, 'Full terminal screen (last 80 lines) — read before approving'),
      h('pre', { class: 'screen' }, screen || '(empty)')))
    .catch((e) => box.replaceChildren(h('p', { class: 'error' }, `Could not load the full screen: ${e.message}. Check the terminal before approving.`)));
  return box;
}

const CONFIRM_LABEL = { approve: 'Approve', changes: 'Send changes', reply: 'Send reply' };
function confirmBlock(c, kind, preview, text, back, images = []) {
  return confirmStep({
    label: CONFIRM_LABEL[kind] || 'Send now',
    tone: kind === 'approve' ? 'go' : '',
    intro: c.pendingPrompt
      ? `This answers the approval ${isMenu(c) ? 'menu' : 'request'} in ${HARNESS[c.harness]} session “${c.title}”${withImages(images)}. The agent will act on it.`
      : `This sends the message below to ${HARNESS[c.harness]} session “${c.title}”${withImages(images)}. The agent will act on it.`,
    preview,
    images,
    back,
    act: async () => {
      const res = await post('/api/action', { id: c.id, kind, text, confirm: true, expectPrompt: !!c.pendingPrompt, expectText: c.pendingPrompt || '',
        ...(images.length ? { images: images.map((i) => i.id) } : {}) });
      if (res.output) {
        // A slash command the agent answered right away (Hermes): show what it printed.
        openSheet(`${text.split(/\s/)[0]} · ${HARNESS[c.harness]}`, h('div', { class: 'bubble' }, res.output), h('button', { type: 'button', onclick: () => sheet.close() }, 'Close'));
      } else {
        sheet.close();
        toast(`Sent to ${HARNESS[c.harness]}`);
      }
      setTimeout(load, 1500);
    },
  });
}

async function commandsFor(harness) {
  if (!state.commands[harness]) {
    const { commands } = await api(`/api/commands?harness=${harness}`);
    state.commands[harness] = commands;
  }
  return state.commands[harness];
}

/** Typing "/" in the reply box lists that agent's own slash commands; tapping one inserts it. */
function slashHelper(c, ta) {
  const list = h('div', { class: 'slash-list', role: 'listbox', 'aria-label': `${HARNESS[c.harness]} commands`, hidden: true });
  const update = async () => {
    const m = /^\/([\w:-]*)$/.exec(ta.value);
    if (!m) { list.hidden = true; return; }
    let cmds;
    try { cmds = await commandsFor(c.harness); } catch (e) { list.replaceChildren(h('p', { class: 'note' }, e.message)); list.hidden = false; return; }
    const q = `/${m[1]}`.toLowerCase();
    const hits = cmds.filter((x) => x.name.toLowerCase().startsWith(q)).slice(0, 8);
    list.replaceChildren(...hits.map((x) => h('button', { type: 'button', role: 'option', class: 'slash-item',
      onclick: () => { ta.value = `${x.name} `; list.hidden = true; ta.focus(); } },
    h('b', {}, x.name), h('span', {}, x.description))));
    list.hidden = !hits.length;
  };
  ta.addEventListener('input', update);
  return list;
}

/** The dictation button for a textarea (null when this browser can't dictate here), and whether it can. */
function micFor(ta) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canMic = !!SR && window.isSecureContext;
  let rec = null;
  const label = h('span', {}, 'Mic');
  const mic = canMic ? h('button', { type: 'button', class: 'mic accent-btn', 'aria-pressed': 'false' }, icon('mic'), label) : null;
  if (mic) {
    mic.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.continuous = true;
      rec.onresult = (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) ta.value = `${ta.value}${ta.value && !ta.value.endsWith(' ') ? ' ' : ''}${ev.results[i][0].transcript.trim()}`;
        }
      };
      rec.onerror = (ev) => toast(`Mic: ${ev.error}`);
      rec.onend = () => { rec = null; mic.setAttribute('aria-pressed', 'false'); label.textContent = 'Mic'; };
      rec.start();
      mic.setAttribute('aria-pressed', 'true');
      label.textContent = 'Stop mic';
    });
  }
  return { mic, canMic, stopMic: () => rec?.stop() };
}

// Small line icons for the message box's buttons (16px, drawn with the text colour).
const ICONS = {
  image: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'm21 15-5-5L5 21'],
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 3v4', 'M21 5h-4'],
  send: ['M22 2 11 13', 'M22 2l-7 20-4-9-9-4z'],
};
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ class: 'btn-icon', viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function micNote() {
  return h('p', { class: 'note' }, window.isSecureContext
    ? 'This browser has no built-in dictation. Use your keyboard mic.'
    : 'Built-in mic needs the HTTPS (Tailscale) address. Your keyboard mic works here.');
}

// ---------- Images on a message ----------
const MAX_IMAGES = 4;
const IMAGE_SIDE = 1600; // longest side after shrinking: phone screenshots stay readable, uploads stay small
const IMAGE_QUALITY = 0.82;

/** A photo or screenshot as a smaller JPEG data: URL (white behind any transparency). */
async function shrinkImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(`${file.name || 'That file'} could not be opened as an image.`); }
  const scale = Math.min(1, IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
}

/**
 * The Image button and the thumbnails under a message box. Each image is shrunk and saved on the computer as soon as it
 * is picked, so Review only has ids to send. `start`: images already added (going Back from the review step).
 */
function imagePicker(start = []) {
  const added = [...start]; // [{ id, url }]
  let busy = 0;
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const button = h('button', { type: 'button', class: 'img-add accent-btn', 'aria-label': 'Add an image or screenshot' }, icon('image'), h('span', {}, 'Image'));
  const list = h('div', { class: 'img-list', 'aria-live': 'polite' });
  const draw = () => {
    list.replaceChildren(...added.map((img, i) => h('div', { class: 'img-thumb' },
      h('img', { src: img.url, alt: `Added image ${i + 1}` }),
      h('button', { type: 'button', class: 'img-remove', 'aria-label': `Remove image ${i + 1}`,
        onclick: () => { added.splice(i, 1); draw(); } }, '×'))),
    ...(busy ? [h('p', { class: 'note' }, `Adding ${busy} image${busy > 1 ? 's' : ''}…`)] : []));
    button.disabled = added.length + busy >= MAX_IMAGES;
  };
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files].slice(0, MAX_IMAGES - added.length - busy);
    if (input.files.length > files.length) toast(`At most ${MAX_IMAGES} images per message`);
    input.value = '';
    busy += files.length;
    draw();
    await Promise.all(files.map(async (file) => {
      try {
        const url = await shrinkImage(file);
        const { id } = await post('/api/upload', { data: url });
        added.push({ id, url });
      } catch (e) {
        if (e.message !== 'PIN required') toast(`Image not added: ${e.message}`);
      } finally {
        busy -= 1;
        draw();
      }
    }));
  });
  draw();
  return {
    button: h('span', { class: 'img-add-wrap' }, button, input),
    list,
    images: () => [...added],
    busy: () => busy > 0,
  };
}

/** Small read-only thumbnails for a review step. */
const imageThumbs = (images) => (images.length
  ? h('div', { class: 'img-list' }, images.map((img, i) => h('div', { class: 'img-thumb' }, h('img', { src: img.url, alt: `Image ${i + 1}` }))))
  : null);
const withImages = (images) => (images.length ? ` with ${images.length === 1 ? 'an image' : `${images.length} images`}` : '');

// ---------- Settings ----------
const AGE_LABEL = { today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All' };

/** Settings: board defaults, agents (connection, version, restart / re-check), AgentHub restart, PIN. */
// ---------- Settings: sections in order of priority, each one folds open or shut ----------
// Agents (are they working, on or off, models, paths) → Board (what you see) → Suggestions and usage → Projects →
// Phone access → Security → AgentHub (restart). Which sections are open is remembered while the page is open.
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];

/** One folding section of Settings. */
function settingsGroup(id, title, subtitle, ...content) {
  state.settingsOpen ||= new Set(['agents']);
  const d = h('details', { class: 'set-group', open: state.settingsOpen.has(id) },
    h('summary', {}, h('span', { class: 'set-group-title' }, title), h('span', { class: 'set-group-sub' }, subtitle)),
    h('div', { class: 'set-group-body' }, ...content));
  d.addEventListener('toggle', () => { if (d.open) state.settingsOpen.add(id); else state.settingsOpen.delete(id); });
  return d;
}

/** A part of Settings that fills itself once the setup (and anything else it needs) has loaded. */
function settingsPart(cls, promise, fill) {
  const box = h('div', { class: cls }, h('p', { class: 'muted' }, 'Loading…'));
  promise.then((data) => fill(box, data)).catch((e) => box.replaceChildren(h('p', { class: 'error' }, e.message)));
  return box;
}

/**
 * Agents: each agent on one row: on or off, its light and version (and an update when there is one), the model New
 * chat starts it with, its paths, and Restart gateway or Re-check. Detect and Add a Claude account sit on top.
 * Default models and paths can only be changed on the computer AgentHub runs on (the server checks).
 */
function agentsSettings(setupP) {
  const versionsP = api('/api/versions').catch(() => ({}));
  return settingsPart('agent-settings', Promise.all([setupP, versionsP]), (box, [s, versions]) => {
    const local = s.fromThisComputer;
    const lanes = state.data?.lanes || {};
    const rows = s.agents.map((a) => {
      const lane = lanes[a.key];
      const v = versions[a.key] || {};
      const on = h('input', { type: 'checkbox', checked: a.enabled, 'aria-label': `${a.label} on` });
      const hasModel = a.kind === 'claude' || a.kind === 'codex';
      const model = hasModel ? h('input', { type: 'text', class: 'model-input', value: a.model, disabled: !local, spellcheck: 'false', autocapitalize: 'off',
        placeholder: 'Its own default', 'aria-label': `${a.label}: default model for New chat`, ...(a.kind === 'claude' ? { list: 'claude-models' } : {}) }) : null;
      const health = lane ? laneHealth(a.key, lane) : '';
      const check = !lane ? null : lane.canRestart
        ? h('button', { type: 'button', class: 'ghost', onclick: () => openRestart(a.key) }, 'Restart gateway…')
        : h('button', { type: 'button', class: 'ghost', onclick: async (ev) => {
          ev.target.disabled = true;
          try { const { output } = await post('/api/lane', { lane: a.key, action: 'check', confirm: true }); toast(output); } catch (e) { toast(e.message); }
          ev.target.disabled = false;
          load();
        } }, 'Re-check');
      const update = v.updateAvailable === true
        ? h('p', { class: 'set-update' }, 'Update available. On the computer, run: ', h('code', {}, v.updateCommand),
          h('button', { type: 'button', class: 'ghost copy', onclick: () => navigator.clipboard?.writeText(v.updateCommand).then(() => toast('Copied')).catch(() => toast('Copy not available here')) }, 'Copy'))
        : null;
      const row = h('div', { class: `set-agent${a.enabled ? '' : ' off'}` },
        h('div', { class: 'set-agent-head' },
          agentIcon(a.kind === 'claude' ? 'claude' : a.key),
          h('b', {}, a.label),
          lane ? [h('span', { class: `light ${health}`, 'aria-hidden': 'true' }), h('span', { class: 'muted', title: lane.why || '' }, HEALTH_WORD[health])]
            : h('span', { class: 'muted' }, a.enabled ? 'starts after saving' : 'off'),
          h('span', { class: 'set-version' }, v.version ? `v${v.version}` : ''),
          h('label', { class: 'set-switch', title: a.enabled ? 'Switch off' : 'Switch on' }, on, h('span', {}, 'On'))),
        a.enabled ? [
          update,
          v.note ? h('p', { class: 'note' }, v.note) : null,
          h('div', { class: 'agent-set-right' },
            hasModel ? h('label', { class: 'model-field' }, h('span', {}, 'New chat model'), model) : null,
            h('button', { type: 'button', class: 'ghost', onclick: () => openAgentPaths(s, a) }, a.kind === 'claude' ? 'Edit…' : 'Paths…'),
            check),
        ] : null);
      return { a, on, model, row };
    });
    const save = h('button', { type: 'button', class: 'primary' }, 'Save agent changes…');
    save.addEventListener('click', () => {
      // Only what changed goes, so a phone saving its switches never touches a default model.
      const changes = {};
      const claude = [];
      for (const { a, on, model } of rows) {
        const c = {};
        if (on.checked !== a.enabled) c.enabled = on.checked;
        if (model && local && model.value.trim() !== a.model) c.model = model.value.trim();
        if (!Object.keys(c).length) continue;
        if (a.kind === 'claude') claude.push({ id: a.key, ...c });
        else (changes.agents ||= {})[a.key] = c;
      }
      if (claude.length) (changes.agents ||= {}).claude = claude;
      if (!Object.keys(changes).length) { toast('Nothing changed'); return; }
      saveSetupChanges('Save agent changes', changes, 'This saves the agent changes');
    });
    box.replaceChildren(
      h('datalist', { id: 'claude-models' }, CLAUDE_MODELS.map((m) => h('option', { value: m }))),
      h('div', { class: 'row set-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => openWelcome() }, 'Setup guide…'),
        h('button', { type: 'button', class: 'ghost', onclick: () => openDetect() }, 'Detect agents…'),
        local ? h('button', { type: 'button', class: 'ghost', onclick: () => openClaudeAccount(s, null) }, 'Add a Claude account…') : null),
      ...rows.map((r) => r.row),
      h('p', { class: 'note' }, `Switching an agent off takes it off the board on every device; its chats are not touched. The New chat model is used when the board starts a chat (empty: the agent's own default; /model still changes it inside a chat).${local ? '' : ' Models and paths can only be changed on the computer AgentHub runs on.'}`),
      save);
  });
}

/** Suggestions and usage: which Claude account and model write suggested replies, and the usage rings. */
function suggestSettings(setupP) {
  return settingsPart('agent-settings', setupP, (box, s) => {
    const claude = s.agents.filter((a) => a.kind === 'claude');
    const sugAgent = h('select', { 'aria-label': 'Suggested replies are written by' },
      h('option', { value: '', selected: !s.suggest.agent }, "The chat's own Claude account"),
      claude.map((a) => h('option', { value: a.key, selected: s.suggest.agent === a.key }, a.label)));
    const sugModel = h('input', { type: 'text', class: 'model-input', value: s.suggest.model, list: 'claude-models', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Suggested replies model' });
    const rings = h('input', { type: 'checkbox', checked: s.usage.rings });
    const save = h('button', { type: 'button', class: 'primary' }, 'Save…');
    save.addEventListener('click', () => {
      const changes = {};
      if (sugAgent.value !== s.suggest.agent || sugModel.value.trim() !== s.suggest.model) changes.suggest = { agent: sugAgent.value, model: sugModel.value.trim() };
      if (rings.checked !== s.usage.rings) changes.usage = { rings: rings.checked };
      if (!Object.keys(changes).length) { toast('Nothing changed'); return; }
      saveSetupChanges('Save suggestions and usage', changes, 'This saves these settings');
    });
    box.replaceChildren(
      h('datalist', { id: 'suggest-models' }, CLAUDE_MODELS.map((m) => h('option', { value: m }))),
      h('h4', {}, 'Suggested replies'),
      h('p', { class: 'note' }, 'Written only when you press Suggest a reply, by one of your Claude Code accounts (on its normal plan).'),
      h('label', { class: 'nc-field' }, h('span', {}, 'Written by'), sugAgent),
      h('label', { class: 'nc-field' }, h('span', {}, 'Model'), sugModel),
      h('h4', {}, 'Plan usage'),
      h('label', { class: 'set-toggle' }, rings, h('span', {}, 'Show usage rings on Claude and Codex buttons')),
      save);
    sugModel.setAttribute('list', 'suggest-models');
  });
}

/**
 * Detect (step C3): what AgentHub finds on this computer, as proposals to tick. It fills in what is missing or broken,
 * never replaces a path that works and never switches on an agent it did not find. Applying is for this computer only.
 */
async function openDetect() {
  openSheet('Detect agents', h('p', { class: 'muted' }, 'Looking on this computer…'));
  let d;
  try { d = await api('/api/detect'); } catch (e) { openSheet('Detect agents', h('p', { class: 'error' }, e.message)); return; }
  const up = (yes, what) => h('li', {}, `${what}: ${yes ? 'answering' : 'not answering'}`);
  const status = h('ul', { class: 'detect-status' }, up(d.running.hermes, 'Hermes dashboard'), up(d.running.openclaw, 'OpenClaw gateway'));
  if (!d.items.length) {
    openSheet('Detect agents', h('p', {}, 'Every agent in your setup was found, and every path works. Nothing to change.'), status,
      h('button', { type: 'button', onclick: () => openSettings() }, 'Back'));
    return;
  }
  const boxes = d.items.map((i) => ({ i, box: h('input', { type: 'checkbox', checked: i.suggested, disabled: !d.fromThisComputer }) }));
  const use = h('button', { type: 'button', class: 'primary', disabled: !d.fromThisComputer }, 'Use the ticked ones…');
  use.addEventListener('click', () => {
    const ids = boxes.filter((b) => b.box.checked).map((b) => b.i.id);
    if (!ids.length) { toast('Tick at least one'); return; }
    openSheet('Detect agents', confirmStep({
      intro: `This saves ${ids.length === 1 ? 'that change' : `those ${ids.length} changes`} to your setup and restarts AgentHub. The page reconnects by itself in a few seconds.`,
      preview: boxes.filter((b) => b.box.checked).map((b) => `• ${b.i.label}: ${b.i.detail}`).join('\n'),
      label: 'Save and restart',
      back: () => openDetect(),
      act: async () => {
        afterSave(await post('/api/detect', { ids, confirm: true }), 'Saved.');
      },
    }));
  });
  openSheet('Detect agents',
    h('p', { class: 'muted' }, 'What AgentHub found that differs from your setup. Ticked ones are what it suggests; nothing changes until you save.'),
    d.fromThisComputer ? null : computerOnlyNote(),
    h('div', { class: 'detect-list' }, boxes.map(({ i, box }) => h('label', { class: 'set-toggle detect-item' }, box,
      h('span', {}, h('b', {}, i.label), h('br'), h('span', { class: 'muted' }, i.detail))))),
    status,
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => openSettings() }, 'Back'), use));
}

// ---------- Settings → Projects (step C4) ----------
// How chats group into projects: every folder in the projects folder is a project by itself, unless it is put in a
// group (several folders, and Hermes kanban boards, shown as one project, in the order here) or left out. Groups and
// what is left out can be changed from any device; the projects folder itself only on the computer.
function projectSettings(setupP) {
  return settingsPart('project-settings', setupP, projectSettingsForm);
}

function projectSettingsForm(box, s) {
  const p = s.projects;
  const groups = p.groups.map((g) => ({ label: g.label, folders: [...g.folders], kanbanBoards: [...(g.kanbanBoards || [])] }));
  const ignore = new Set(p.ignore);
  const root = pathInput(p.root, 'Projects folder', '~/projects', s.fromThisComputer);
  const chip = (name, on, onToggle, note = '') => h('button', { type: 'button', class: `pick-chip${on ? ' on' : ''}`, 'aria-pressed': String(on), title: note || name, onclick: onToggle }, name);
  // Folders and boards that are named in the setup but no longer exist still show, so they can be taken out.
  const allFolders = [...new Set([...p.found, ...groups.flatMap((g) => g.folders), ...ignore])];
  const allBoards = [...new Set([...p.boards, ...groups.flatMap((g) => g.kanbanBoards)])];
  const groupOf = (f) => groups.find((g) => g.folders.includes(f));

  const draw = () => {
    const cards = groups.map((g, i) => {
      const name = h('input', { type: 'text', class: 'path-input name-input', value: g.label, placeholder: 'Project name', 'aria-label': 'Project name' });
      name.addEventListener('input', () => { g.label = name.value; });
      const folders = allFolders.filter((f) => !ignore.has(f)).map((f) => {
        const other = groupOf(f);
        if (other && other !== g) return null; // in another group
        const on = g.folders.includes(f);
        return chip(f, on, () => { g.folders = on ? g.folders.filter((x) => x !== f) : [...g.folders, f]; draw(); }, p.found.includes(f) ? '' : 'This folder no longer exists');
      });
      const boards = allBoards.map((b) => {
        const on = g.kanbanBoards.includes(b);
        return chip(b, on, () => { g.kanbanBoards = on ? g.kanbanBoards.filter((x) => x !== b) : [...g.kanbanBoards, b]; draw(); });
      });
      const move = (d) => { const j = i + d; if (j < 0 || j >= groups.length) return; [groups[i], groups[j]] = [groups[j], groups[i]]; draw(); };
      return h('div', { class: 'project-group' },
        h('div', { class: 'project-group-head' }, name,
          h('button', { type: 'button', class: 'ghost', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(-1) }, '↑'),
          h('button', { type: 'button', class: 'ghost', 'aria-label': 'Move down', disabled: i === groups.length - 1, onclick: () => move(1) }, '↓'),
          h('button', { type: 'button', class: 'ghost', 'aria-label': `Remove ${g.label || 'this project'}`, onclick: () => { groups.splice(i, 1); draw(); } }, '✕')),
        h('div', { class: 'pick-chips' }, folders),
        allBoards.length ? [h('p', { class: 'note' }, 'Hermes kanban boards'), h('div', { class: 'pick-chips' }, boards)] : null);
    });
    const leftOut = allFolders.filter((f) => !groupOf(f)).map((f) => chip(f, ignore.has(f), () => { if (ignore.has(f)) ignore.delete(f); else ignore.add(f); draw(); }));
    const save = h('button', { type: 'button', class: 'primary' }, 'Save projects…');
    save.addEventListener('click', () => {
      const changes = { projects: { groups: groups.map((g) => ({ label: g.label.trim(), folders: g.folders, kanbanBoards: g.kanbanBoards })), ignore: [...ignore] } };
      if (s.fromThisComputer && root.value.trim() !== p.root) changes.projects.root = root.value.trim();
      saveSetupChanges('Save projects', changes, 'This saves how chats group into projects');
    });
    box.replaceChildren(
      h('label', { class: 'nc-field' }, h('span', {}, 'Projects folder'), root),
      h('p', { class: 'note' }, `${p.found.length} folders in it. Each one is a project by itself unless it is in a group below or left out.${s.fromThisComputer ? '' : ' The folder itself can only be changed on the computer AgentHub runs on.'}`),
      h('h4', {}, 'Groups (shown first, in this order)'),
      ...cards,
      h('button', { type: 'button', onclick: () => { groups.push({ label: '', folders: [], kanbanBoards: [] }); draw(); } }, 'Add a project group'),
      h('h4', {}, 'Left out of the board'),
      h('div', { class: 'pick-chips' }, leftOut.length ? leftOut : h('span', { class: 'muted' }, 'Every folder is in a group.')),
      save);
  };
  draw();
}

// ---------- Settings → Phone access (step C5) ----------
// Where AgentHub can be opened right now, how to reach it from a phone (Tailscale), and, on this computer only, home
// Wi-Fi and extra private addresses. Never the open internet.
function phoneAccessSettings(setupP) {
  return settingsPart('access-settings', setupP, phoneAccessForm);
}

function phoneAccessForm(box, s) {
  const a = s.access;
  const local = s.fromThisComputer;
  const serveCmd = `tailscale serve --bg --https=4443 ${a.port}`;
  const copy = (text) => h('button', { type: 'button', class: 'ghost copy', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')).catch(() => toast('Copy not available here')) }, 'Copy');
  const reach = h('ul', { class: 'reach-list' }, a.reach.map((r) => h('li', {},
    h('span', { class: 'reach-kind' }, r.kind), h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.url), copy(r.url),
    r.note ? h('span', { class: 'muted reach-note' }, r.note) : null)));
  const wifi = h('input', { type: 'checkbox', checked: a.homeWifi || a.lanForced, disabled: !local || a.lanForced });
  const saved = new Set(a.extraAddresses);
  const options = [...new Map([...a.candidates.map((c) => [c.address, c.iface]), ...a.extraAddresses.map((x) => [x, a.candidates.find((c) => c.address === x)?.iface || 'not on this computer now'])])];
  const extras = options.map(([addr, iface]) => ({ addr, box: h('input', { type: 'checkbox', checked: saved.has(addr), disabled: !local }), iface }));
  const save = h('button', { type: 'button', class: 'primary', disabled: !local }, 'Save phone access…');
  save.addEventListener('click', () => {
    const access = {};
    if (!a.lanForced && wifi.checked !== a.homeWifi) access.homeWifi = wifi.checked;
    const picked = extras.filter((x) => x.box.checked).map((x) => x.addr);
    if (picked.join() !== a.extraAddresses.join()) access.extraAddresses = picked;
    if (!Object.keys(access).length) { toast('Nothing changed'); return; }
    saveSetupChanges('Save phone access', { access }, 'This saves how AgentHub can be reached');
  });
  box.replaceChildren(
    h('p', { class: 'muted' }, 'Open AgentHub at:'),
    reach,
    h('h4', {}, 'From your phone, anywhere: Tailscale'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Install Tailscale on this computer and on your phone, signed in to the same account.'),
      h('li', {}, 'On your phone, open the Tailscale address above.'),
      a.reach.some((r) => r.kind === 'Tailscale HTTPS')
        ? h('li', {}, 'HTTPS (needed for the mic) is already set up: use the Tailscale HTTPS address above.')
        : h('li', {}, 'For HTTPS (needed for the mic), run this once on this computer: ', h('code', {}, serveCmd), copy(serveCmd),
          h('span', { class: 'muted' }, ' It uses port 4443, so nothing you already share on Tailscale is replaced.'))),
    h('p', { class: 'note warn' }, 'Never open AgentHub to the internet: no port forwarding, no public tunnels. Anyone who reaches it can try your PIN, and the board can act on your agents.'),
    h('h4', {}, 'Home Wi-Fi'),
    h('label', { class: 'set-toggle' }, wifi, h('span', {}, 'Also open it on this home network (plain HTTP)')),
    h('p', { class: 'note' }, a.lanForced ? 'Switched on outside Settings (AGENTHUB_LAN=1), which wins over this switch.'
      : 'Plain HTTP: your PIN and login travel unencrypted on the network, and the mic won\'t work. Only on a network you trust; Tailscale is safer.'),
    h('h4', {}, 'Extra addresses'),
    extras.length ? h('div', { class: 'detect-list' }, extras.map((x) => h('label', { class: 'set-toggle' }, x.box, h('span', {}, `${x.addr} `, h('span', { class: 'muted' }, `(${x.iface})`)))))
      : h('p', { class: 'muted' }, 'No other private network addresses on this computer.'),
    h('p', { class: 'note' }, 'For another private network (ZeroTier, your own WireGuard). Only private addresses this computer has.'),
    local ? null : computerOnlyNote(),
    save);
}

// ---------- Welcome: connecting your agents (a new install opens with it; Settings → Agents → Setup guide…) ----------
const WELCOME_BADGE = { ready: 'Ready', off: 'Off', 'not-installed': 'Not installed', 'not-set-up': 'Needs setup', 'not-running': 'Not running' };

async function openWelcome() {
  openSheet('Welcome to AgentHub', h('p', { class: 'muted' }, 'Checking your agents…'));
  sheet.classList.add('card-sheet');
  let w;
  try { w = await api('/api/welcome'); } catch (e) { openSheet('Welcome to AgentHub', h('p', { class: 'error' }, e.message)); return; }
  const copy = (text) => h('button', { type: 'button', class: 'ghost copy', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')).catch(() => toast('Copy not available here')) }, 'Copy');
  const steps = (list) => (list.length ? h('ol', { class: 'steps' }, list.map((s) => h('li', {}, s.text, ' ',
    s.command ? [h('code', {}, s.command), copy(s.command)] : null,
    s.link ? h('a', { href: s.link, target: '_blank', rel: 'noopener' }, 'Open the page ↗') : null))) : null);
  const cards = w.agents.map((a) => {
    const use = h('input', { type: 'checkbox', checked: a.state === 'ready' || (a.enabled && a.state !== 'not-installed' && a.state !== 'off'),
      disabled: a.state === 'not-installed', 'aria-label': `Use ${a.label}` });
    return { a, use, el: h('div', { class: `welcome-agent ${a.state}` },
      h('div', { class: 'set-agent-head' }, agentIcon(a.kind === 'claude' ? 'claude' : a.key), h('b', {}, a.label),
        h('span', { class: `welcome-badge ${a.state}` }, WELCOME_BADGE[a.state] || a.state),
        h('label', { class: 'set-switch', title: a.state === 'not-installed' ? 'Install it first' : 'Show it on the board' }, use, h('span', {}, 'Use it'))),
      h('p', { class: 'note' }, a.why),
      steps(a.steps)) };
  });
  const service = w.service
    ? h('p', { class: 'note' }, '✓ AgentHub already starts with this computer.')
    : w.fromThisComputer
      ? h('button', { type: 'button', onclick: () => openSheet('Start with your computer', confirmStep({
        intro: `This makes AgentHub start whenever you log in to this computer and restart if it ever stops (${w.mac ? 'a launchd agent' : 'a systemd user service'}). This page reconnects by itself in about 20 seconds.`,
        label: 'Start with my computer',
        back: () => openWelcome(),
        act: async () => {
          const res = await post('/api/install-service', { confirm: true });
          state.boardRestartUntil = Date.now() + 60000;
          setHealth('restarting', 'Restarting AgentHub…');
          sheet.close();
          toast(res.already ? 'It already starts with your computer' : 'Done. Reconnecting…');
          setTimeout(load, 8000);
        },
      })) }, 'Start AgentHub with my computer…')
      : h('p', { class: 'note' }, 'On the computer AgentHub runs on, run: npm run install-service');
  const done = h('button', { type: 'button', class: 'primary' }, 'Done');
  done.addEventListener('click', async () => {
    const changes = { welcome: { done: true } };
    const claude = [];
    for (const { a, use } of cards) {
      if (use.disabled || use.checked === a.enabled) continue;
      if (a.kind === 'claude') claude.push({ id: a.key, enabled: use.checked });
      else (changes.agents ||= {})[a.key] = { enabled: use.checked };
    }
    if (claude.length) (changes.agents ||= {}).claude = claude;
    if (!changes.agents) {
      // Only finishing the welcome: saved without asking (nothing about the agents changes).
      let res;
      try { res = await post('/api/setup', { changes, confirm: true }); } catch (e) { toast(e.message); return; }
      sheet.close();
      toast('All set');
      if (res.restarting) { state.boardRestartUntil = Date.now() + 30000; setTimeout(load, 4000); }
      return;
    }
    saveSetupChanges('Finish setup', changes, 'This saves which agents you use');
  });
  openSheet('Welcome to AgentHub',
    h('p', {}, 'Connect the agents you use. AgentHub works with Claude Code (one or more accounts), Codex, Hermes and OpenClaw: any of them, all of them. Each card says where that agent stands and exactly what to do; nothing is installed or started for you.'),
    w.tmux.ok ? null : h('div', { class: 'welcome-agent not-installed' }, h('b', {}, 'tmux'), h('p', { class: 'note' }, w.tmux.why), steps(w.tmux.steps)),
    ...cards.map((c) => c.el),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost', onclick: () => openWelcome() }, 'Check again')),
    h('h4', {}, 'Your phone (optional)'),
    h('p', { class: 'note' }, 'On this computer AgentHub already works: nothing else is needed. To open it on your phone too, Tailscale is the easy, private way (free, works anywhere); home Wi-Fi is a simpler switch for use at home only.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost', onclick: () => { state.settingsOpen = new Set(['phone']); openSettings(); } }, 'Phone access…')),
    h('h4', {}, 'Start with your computer'),
    service,
    h('div', { class: 'row welcome-done' }, h('button', { type: 'button', onclick: () => sheet.close() }, 'Later'), done));
  sheet.classList.add('card-sheet');
}

/**
 * After a setup change is saved: when AgentHub runs as a service it restarts to apply it (the page reconnects by
 * itself); when it was started by hand it can't, so say how to apply it.
 */
function afterSave(res, done) {
  sheet.close();
  if (res?.restarting) {
    state.boardRestartUntil = Date.now() + 30000;
    setHealth('restarting', 'Restarting AgentHub…');
    toast(`${done} Restarting…`);
    setTimeout(load, 4000);
  } else {
    toast(`${done} Restart AgentHub to apply it: stop it (Ctrl+C) and run npm start again.`);
  }
}

/** Confirm, save a setup change, and restart AgentHub to apply it (the page reconnects by itself). */
function saveSetupChanges(title, changes, what) {
  openSheet(title, confirmStep({
    intro: `${what} and restarts AgentHub to apply it. The page reconnects by itself in a few seconds. Running chats are not touched.`,
    label: 'Save and restart',
    back: () => openSettings(),
    act: async () => {
      afterSave(await post('/api/setup', { changes, confirm: true }), 'Saved.');
    },
  }));
}

// Program paths per agent (step C2). Only the computer AgentHub runs on may change them; a phone sees them read-only.
const PATH_LABELS = {
  hermes: [['dashboardUrl', 'Dashboard address', 'http://127.0.0.1:9119'], ['launcher', 'Launcher', '~/.hermes/…/bin/hermes'], ['kanbanRoot', 'Kanban folder', '~/.hermes/kanban/boards']],
  openclaw: [['bin', 'Command', '~/.openclaw/bin/openclaw'], ['port', 'Gateway port', '18789']],
  codex: [['command', 'Command', 'codex'], ['sessionsDir', 'Sessions folder', '~/.codex/sessions']],
};
// An account's colour: it tints its tag badge (the stored names are older, kept so existing setups still work).
const ACCENT_NAMES = { '': 'Standard (grey)', 'green-purple': 'Green', 'blue-yellow': 'Blue' };
const pathInput = (value, label, placeholder, local) => h('input', { type: 'text', class: 'path-input', value: String(value ?? ''), placeholder,
  disabled: !local, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': label });
const computerOnlyNote = () => h('p', { class: 'note' }, 'These can only be changed on the computer AgentHub runs on.');

function openAgentPaths(s, a) {
  if (a.kind === 'claude') { openClaudeAccount(s, a); return; }
  const local = s.fromThisComputer;
  const fields = PATH_LABELS[a.kind].map(([key, label, ph]) => ({ key, input: pathInput(a.paths[key], label, ph, local), label }));
  const save = h('button', { type: 'button', class: 'primary', disabled: !local }, 'Save…');
  save.addEventListener('click', () => {
    const c = {};
    for (const f of fields) if (f.input.value.trim() !== String(a.paths[f.key] ?? '')) c[f.key] = f.input.value.trim();
    if (!Object.keys(c).length) { toast('Nothing changed'); return; }
    saveSetupChanges(`${a.label} paths`, { agents: { [a.key]: c } }, `This saves ${a.label}'s paths`);
  });
  openSheet(`${a.label} · paths`,
    local ? h('p', { class: 'muted' }, 'Where AgentHub finds this agent. Each one is checked on this computer before it is saved.') : computerOnlyNote(),
    ...fields.map((f) => h('label', { class: 'nc-field' }, h('span', {}, f.label), f.input)),
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => openSettings() }, 'Back'), save));
}

/** A Claude Code account: edit one (`a`), or add a new one (`a` null). Computer only. */
function openClaudeAccount(s, a) {
  const local = s.fromThisComputer;
  const p = a?.paths || { command: '', configDir: '', folderArg: false, tag: '', accent: '' };
  const label = pathInput(a?.label || '', 'Name', 'e.g. Claude Work', local);
  const command = pathInput(p.command, 'Command', '~/.local/bin/claude', local);
  const configDir = pathInput(p.configDir, 'Claude folder', '~/.claude-work', local);
  const folderArg = h('input', { type: 'checkbox', checked: p.folderArg, disabled: !local });
  const tag = pathInput(p.tag, 'Tag', 'e.g. WRK (optional)', local);
  const accent = h('select', { disabled: !local, 'aria-label': 'Colour' }, (s.accents || ['']).map((v) => h('option', { value: v, selected: v === p.accent }, ACCENT_NAMES[v] || v)));
  const save = h('button', { type: 'button', class: 'primary', disabled: !local }, a ? 'Save…' : 'Add…');
  save.addEventListener('click', () => {
    const now = { label: label.value.trim(), command: command.value.trim(), configDir: configDir.value.trim(), folderArg: folderArg.checked, tag: tag.value.trim(), accent: accent.value };
    if (!a) { saveSetupChanges('Add a Claude account', { agents: { addClaude: now } }, `This adds ${now.label || 'the account'}`); return; }
    const before = { label: a.label, ...p };
    const c = Object.fromEntries(Object.entries(now).filter(([k, v]) => v !== before[k]));
    if (!Object.keys(c).length) { toast('Nothing changed'); return; }
    saveSetupChanges(`${a.label}`, { agents: { claude: [{ id: a.key, ...c }] } }, `This saves ${a.label}`);
  });
  const remove = a && local && s.agents.filter((x) => x.kind === 'claude').length > 1
    ? h('button', { type: 'button', class: 'danger', onclick: () => openSheet(`Remove ${a.label}`, confirmStep({
      intro: `This removes ${a.label} from the board and restarts AgentHub. Its chats, its sign-in and its folder on this computer are not touched; add it again any time.`,
      label: 'Remove and restart', tone: 'danger',
      back: () => openClaudeAccount(s, a),
      act: async () => {
        afterSave(await post('/api/setup', { changes: { agents: { removeClaude: [a.key] } }, confirm: true }), 'Removed.');
      },
    })) }, 'Remove this account…') : null;
  openSheet(a ? `${a.label} · account` : 'Add a Claude account',
    local ? h('p', { class: 'muted' }, a ? 'How AgentHub runs this account. Its id stays the same, so its cards keep their place.'
      : 'Each account is Claude Code signed in with its own Claude folder. Sign it in once in Terminal first (run its command and log in).') : computerOnlyNote(),
    h('label', { class: 'nc-field' }, h('span', {}, 'Name'), label),
    h('label', { class: 'nc-field' }, h('span', {}, 'Command'), command),
    h('label', { class: 'nc-field' }, h('span', {}, 'Claude folder'), configDir),
    h('label', { class: 'set-toggle' }, folderArg, h('span', {}, 'This command takes the project folder first (a wrapper script)')),
    h('label', { class: 'nc-field' }, h('span', {}, 'Tag on its cards'), tag),
    h('label', { class: 'nc-field' }, h('span', {}, 'Colour'), accent),
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => openSettings() }, 'Back'), save),
    remove);
}

async function openSettings() {
  // Always start from the saved values, so saving one switch never resets the others.
  try { state.settings = await api('/api/settings'); } catch (e) { toast(e.message); return; }
  const settings = { ...state.settings };
  const age = h('select', { 'aria-label': 'Default time window' },
    Object.entries(AGE_LABEL).map(([v, label]) => h('option', { value: v, selected: v === settings.defaultAge }, label)));
  const toggle = (key, label) => h('label', { class: 'set-toggle' },
    h('input', { type: 'checkbox', checked: !!settings[key], onchange: (ev) => { settings[key] = ev.target.checked; } }), h('span', {}, label));
  const saveBoard = h('button', { type: 'button', class: 'primary' }, 'Save board defaults');
  saveBoard.addEventListener('click', async () => {
    settings.defaultAge = age.value;
    try {
      state.settings = await post('/api/settings', { ...settings, confirm: true });
      if (!state.deviceAge) { state.age = state.settings.defaultAge; showAge(); load(); }
      toast('Board defaults saved');
      render();
    } catch (e) { toast(e.message); }
  });

  const cur = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', 'aria-label': 'Current PIN', placeholder: 'Current PIN' });
  const next = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', 'aria-label': 'New PIN (8 to 12 digits)', placeholder: 'New PIN (8–12 digits)' });
  const again = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', 'aria-label': 'New PIN again', placeholder: 'New PIN again' });
  const changePin = h('button', { type: 'button' }, 'Change PIN…');
  changePin.addEventListener('click', () => {
    if (!/^\d{8,12}$/.test(next.value)) { toast('A new PIN is 8 to 12 digits'); return; }
    if (next.value !== again.value) { toast('The two new PINs differ'); return; }
    const pins = { current: cur.value, next: next.value };
    openSheet('Change PIN', confirmStep({
      intro: 'This changes the board PIN and signs out every other device (phone, other browsers). This device stays logged in.',
      label: 'Change PIN',
      back: () => openSettings(),
      act: async () => {
        const res = await post('/api/pin', { ...pins, confirm: true });
        state.token = res.token || '';
        storeToken(state.token);
        sheet.close();
        toast('PIN changed. Other devices must log in again.');
      },
    }));
  });

  const restartBoard = h('button', { type: 'button' }, 'Restart AgentHub…');
  restartBoard.addEventListener('click', () => openSheet('Restart AgentHub', confirmStep({
    intro: 'This restarts the board service on the computer. The page reconnects by itself in a few seconds. Agents and their chats are not touched.',
    label: 'Restart now',
    back: () => openSettings(),
    act: async () => {
      await post('/api/restart-board', { confirm: true });
      state.boardRestartUntil = Date.now() + 30000;
      setHealth('restarting', 'Restarting AgentHub…');
      sheet.close();
      toast('Restarting… reconnecting');
      setTimeout(load, 4000);
    },
  })));

  const setupP = api('/api/setup');
  openSheet('Settings',
    settingsGroup('agents', 'Agents', 'On or off, health, versions, New chat models, paths', agentsSettings(setupP)),
    settingsGroup('board', 'Board', 'Time window, folding, light or dark, which agents this device shows',
      h('label', { class: 'nc-field' }, h('span', {}, 'Default time window'), age),
      toggle('foldDone', 'Fold finished chats inside each project'),
      toggle('foldQuietProjects', 'Fold projects with nothing blocked, to review or running'),
      h('p', { class: 'note' }, 'A time window you pick on a device still wins on that device.'),
      saveBoard,
      h('h4', {}, 'On this device'),
      themeChoice(),
      h('p', { class: 'note' }, 'An agent switched off here leaves this board on this device only: its button, its cards, New chat and Ask. It keeps running, and other devices still show it. Handy before sharing a screenshot.'),
      ...agentToggles()),
    settingsGroup('suggest', 'Suggestions and usage', 'Who writes suggested replies; usage rings', suggestSettings(setupP)),
    settingsGroup('projects', 'Projects', 'How chats group into projects', projectSettings(setupP)),
    settingsGroup('phone', 'Phone access', 'Where to open AgentHub; Tailscale; home Wi-Fi', phoneAccessSettings(setupP)),
    settingsGroup('security', 'Security', 'Change the PIN',
      h('form', { class: 'set-pin', onsubmit: (ev) => { ev.preventDefault(); changePin.click(); } }, cur, next, again, changePin)),
    settingsGroup('service', 'AgentHub', 'Restart the board', restartBoard));
}

// ---------- New chat ----------

/** "A", "A and B", "A, B and C". */
const listNames = (keys) => {
  const names = keys.map((k) => HARNESS[k]);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

/** Start a chat with one or more agents: tap each agent to add or remove it, pick the folder, type the first
 * message, confirm. Every chosen agent gets its own new chat with the same first message. */
function openNewChat(draft = {}) {
  const lanes = state.data?.lanes || {};
  const keys = Object.keys(HARNESS).filter((k) => !isHidden(k));
  const wanted = (draft.agents || []).filter((k) => lanes[k]?.connected && !isHidden(k));
  const first = keys.find((k) => lanes[k]?.connected);
  if (!first) { toast('No agent is connected right now'); return; }
  const chosen = new Set(wanted.length ? wanted : [first]);
  const picked = () => keys.filter((k) => chosen.has(k)); // in the board's agent order
  const folders = state.data.folders || [];
  const ta = h('textarea', { 'aria-label': 'First message', placeholder: 'What should the agent do? (type or dictate)' });
  ta.value = draft.message || '';
  const { mic, canMic } = micFor(ta);
  const pics = imagePicker(draft.images || []);
  const folderSel = h('select', { 'aria-label': 'Folder to work in' });
  const pills = keys.map((k) => h('button', {
    type: 'button', class: 'agent-pill nc-agent', 'data-agent': k, 'data-kind': kindOf(k), 'data-accent': laneOf(k).accent || null, 'aria-pressed': String(chosen.has(k)), disabled: !lanes[k]?.connected,
    'aria-label': lanes[k]?.connected ? HARNESS[k] : `${HARNESS[k]}, not connected`,
    title: lanes[k]?.connected ? HARNESS[k] : `${HARNESS[k]}: ${lanes[k]?.reason || 'not connected'}`,
    onclick: () => {
      if (chosen.has(k) && chosen.size === 1) { toast('Pick at least one agent'); return; }
      if (chosen.has(k)) chosen.delete(k); else chosen.add(k);
      sync();
    },
  }, agentIcon(k), h('span', { class: 'nc-name' }, nameBesideTag(k)), acctBadge(k)));
  const chosenLine = h('p', { class: 'nc-chosen', 'aria-live': 'polite' });
  const folderNote = h('p', { class: 'note' });
  function sync() {
    for (const [i, b] of pills.entries()) b.setAttribute('aria-pressed', String(chosen.has(keys[i])));
    const agents = picked();
    const inFolder = agents.filter(runsInFolder);
    chosenLine.textContent = agents.length > 1 ? `${agents.length} new chats: ${listNames(agents)}` : listNames(agents);
    const keep = folderSel.value || draft.folder || '';
    // Claude Code / Codex: no default folder, you pick one ("Pick a folder…" is refused if left).
    const opts = [inFolder.length ? ['', 'Pick a folder…'] : ['', 'No folder (general chat)'], ...folders.map((f) => [f.path, f.label])];
    folderSel.replaceChildren(...opts.map(([v, label]) => h('option', { value: v }, label)));
    if (opts.some(([v]) => v === keep)) folderSel.value = keep;
    folderNote.textContent = inFolder.length
      ? `${listNames(inFolder)} ${inFolder.length > 1 ? 'start' : 'starts'} in a terminal session on your computer (tmux), so you can answer from here.`
      : '';
  }
  sync();
  const next = h('button', { type: 'button', class: 'send-btn' }, icon('send'), h('span', {}, 'Review…'));
  next.addEventListener('click', () => {
    const message = ta.value.trim();
    if (!message) { toast('Type the first message'); return; }
    if (pics.busy()) { toast('Wait for the images to finish adding'); return; }
    const images = pics.images();
    const agents = picked();
    const folder = folderSel.value;
    const inFolder = agents.filter(runsInFolder);
    if (!folder && inFolder.length) { toast(`Pick a folder for ${listNames(inFolder)}`); return; }
    const where = folder ? ` in ${folders.find((f) => f.path === folder)?.label || folder}` : '';
    const many = agents.length > 1;
    openSheet(many ? `${agents.length} new chats` : `New ${HARNESS[agents[0]]} chat`, confirmStep({
      intro: many
        ? `Starts ${agents.length} new chats${where}, one each in ${listNames(agents)}, with the same first message${withImages(images)}. They're real sessions on your computer and use each agent's normal usage.`
        : `Starts a new ${HARNESS[agents[0]]} chat${where}${withImages(images)}. It's a real session on your computer and uses your normal ${HARNESS[agents[0]]} usage.`,
      preview: message,
      images,
      label: many ? `Start ${agents.length} chats` : 'Start chat',
      back: () => openNewChat({ agents, folder, message, images }),
      act: async () => {
        const started = [];
        const failed = [];
        for (const agent of agents) {
          try {
            await post('/api/new-chat', { agent, folder, message, confirm: true, ...(images.length ? { images: images.map((i) => i.id) } : {}) });
            started.push(agent);
          } catch (e) {
            if (e.message === 'PIN required' && !started.length) throw e; // the PIN box is open: ask once, not per agent
            failed.push(many ? `${HARNESS[agent]}: ${e.message}` : e.message);
          }
        }
        // Nothing started: show why here, so you can fix it and try again.
        if (!started.length) throw new Error(failed.join(' · '));
        sheet.close();
        // Some started: never offer a retry here, it would start those again.
        toast(failed.length ? `Started in ${listNames(started)}. Not started: ${failed.join(' · ')}` : `Started in ${listNames(started)}`);
        setTimeout(load, 1500);
      },
    }));
  });
  openSheet('New chat',
    h('div', { class: 'nc-agents', role: 'group', 'aria-label': 'Agents: tap each one to start a chat with' }, pills),
    chosenLine,
    h('label', { class: 'nc-field' }, h('span', {}, 'Folder'), folderSel),
    folderNote,
    ta,
    pics.list,
    canMic ? null : micNote(),
    h('div', { class: 'row compose-actions' }, pics.button, mic, next));
}

function openCompose(c, kind, prefill = '', startImages = []) {
  const ta = h('textarea', { 'aria-label': kind === 'changes' ? 'What should change' : 'Reply', placeholder: kind === 'changes' ? 'What should change?' : `Type or dictate your reply… (type / for ${HARNESS[c.harness]} commands)` });
  ta.value = prefill;
  // Suggested reply on request: the box opens empty, and "Suggest a reply" asks for the reply you'd most
  // likely send (one model call, only when pressed). It fills an empty box; if you already typed, it is offered below
  // with "Use it", so your own words are never overwritten. Nothing is sent without your review.
  // Offered on any card where the agent spoke last and waits: Blocked, Review, or an Update.
  const hint = h('p', { class: 'note suggest-note' });
  const useSuggestion = (text) => { ta.value = text; hint.textContent = 'Suggested reply: edit it or send as is.'; ta.focus(); };
  const suggestBtn = kind === 'reply' && c.canReply && (needsYou(c) || c.status === 'update')
    ? h('button', { type: 'button', class: 'suggest-btn accent-btn', title: 'Ask for the reply you would most likely send (uses a little of your AI usage)' }, icon('sparkle'), h('span', {}, 'Suggest a reply'))
    : null;
  suggestBtn?.addEventListener('click', async () => {
    suggestBtn.disabled = true;
    hint.textContent = 'Suggesting a reply…';
    try {
      const { suggestion } = await post('/api/suggest', { id: c.id });
      if (!suggestion) hint.textContent = 'No suggestion this time.';
      else if (!ta.value.trim()) useSuggestion(suggestion);
      else hint.replaceChildren(h('span', {}, `Suggestion: ${suggestion} `), h('button', { type: 'button', class: 'ghost', onclick: () => useSuggestion(suggestion) }, 'Use it'));
    } catch (e) {
      hint.textContent = `No suggestion this time: ${e.message}`; // say why, never fail silently
    } finally {
      suggestBtn.disabled = false;
    }
  });
  const { mic, canMic, stopMic } = micFor(ta);
  const pics = imagePicker(startImages);
  const err = h('p', { class: 'error', role: 'alert' });
  const next = h('button', { type: 'button', class: 'send-btn' }, icon('send'), h('span', {}, 'Submit…'));
  const compose = h('div', {},
    // Answering a question: show it above the box.
    kind === 'reply' && c.ask && c.status === 'blocked' ? h('p', { class: 'q-text' }, plain(c.ask)) : null,
    ta,
    pics.list,
    suggestBtn ? h('div', { class: 'suggest-row' }, suggestBtn, hint) : hint,
    kind === 'reply' ? slashHelper(c, ta) : null,
    canMic ? null : micNote(),
    err,
    h('div', { class: 'row compose-actions' }, pics.button, mic, next),
  );
  next.addEventListener('click', () => {
    stopMic();
    const text = ta.value.trim();
    if (!text) { err.textContent = 'Type a message first.'; return; }
    if (pics.busy()) { err.textContent = 'Wait for the images to finish adding.'; return; }
    const images = pics.images();
    const preview = kind !== 'changes' ? text
      : !c.pendingPrompt ? `Request changes: ${text}`
        : isMenu(c) ? `Press “No” on the approval menu, then send:\n\nRequest changes: ${text}`
          : `Deny this request:\n\n${c.pendingPrompt}\n\nthen send:\n\nRequest changes: ${text}`;
    const block = confirmBlock(c, kind, preview, text, () => openCompose(c, kind, text, images), images);
    compose.replaceWith(block);
    if (isMenu(c)) block.after(fullScreen(c));
  });
  openSheet(`${kind === 'changes' ? 'Request changes' : 'Reply'} · ${c.title}`,
    c.lastReply ? h('div', { class: 'bubble quote' }, h('span', { class: 'who' }, `${HARNESS[c.harness]} said`), c.lastReply) : null,
    compose);
  ta.focus();
}

// ---------- boot ----------
// Board defaults first (they decide the starting time window), then the first load. Also run after a login, so a
// device that had to log in when it opened still gets the saved defaults.
async function loadSettings() {
  try { state.settings = await api('/api/settings'); } catch { state.settings = null; }
  state.age = pickAge(state.deviceAge, state.settings);
  showAge();
}
async function start() {
  // Demo mode (npm run demo): no PIN, made-up agents; a small "Demo" tag says so (hidden with ?clean for screenshots).
  try {
    const hello = await (await fetch('/api/hello')).json();
    state.demo = !!hello.demo;
    if (state.demo && !new URLSearchParams(location.search).has('clean')) {
      $('logoRefresh').after(h('span', { class: 'demo-tag', title: 'Made-up agents and chats: try anything, nothing real is touched' }, 'Demo'));
    }
  } catch { /* the board answers below */ }
  await loadSettings();
  load(); // the board as the server last read it, at once
  // Opening the page (or pulling it down to refresh) reads every agent now: the spark spins until the
  // new board lands, then pulses and sets off from 12 o'clock.
  await readAgentsNow();
}

/** Have the server read every agent now: the spark spins until the new board lands (then pulses, from 12). */
async function readAgentsNow() {
  if (state.readingNow) return;
  state.readingNow = true;
  $('settingsBtn').classList.add('reading');
  $('refreshBtn').classList.add('reading');
  await load({ readNow: true });
  if ($('settingsBtn').classList.contains('reading')) startClock(); // the board was already current: back to the clock
  $('refreshBtn').classList.remove('reading');
}

// The logo refreshes (an app installed from Chrome or the Home Screen has no reload button): back to the top, every
// agent read now, and a quarter turn of the pinwheel as the sign it heard you.
$('refreshBtn').addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'smooth' }); readAgentsNow(); });

// ---------- Light / dark (public/theme.js applies it; chosen per device) ----------
/** The header switch says what pressing it does next. */
function labelThemeButton() {
  const toLight = window.agenthubTheme?.current() !== 'light';
  const label = toLight ? 'Switch to light mode' : 'Switch to dark mode';
  $('themeBtn').setAttribute('aria-label', label);
  $('themeBtn').title = label;
}
$('themeBtn').addEventListener('click', () => {
  window.agenthubTheme?.set(window.agenthubTheme.current() === 'light' ? 'dark' : 'light');
});
window.addEventListener('agenthub-theme', labelThemeButton);
labelThemeButton();
$('logoRefresh').addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const mark = $('logoRefresh').querySelector('.mark-logo');
  mark.classList.remove('spin');
  void mark.getBoundingClientRect(); // restart the turn
  mark.classList.add('spin');
  readAgentsNow();
});

// ---------- pull down to refresh, in the Home Screen app ----------
// Safari and Chrome pull to refresh by reloading the page (which reads the agents, above). Opened from the Home
// Screen the page has no browser around it, so it does the same itself: pull down from the top of the board, let go
// past the line, and every agent is read now. Only from the very top, never inside an open sheet or a text box.
const PULL_AT = 70; // px of finger travel that counts as a pull
const pullHint = h('div', { class: 'pull-hint', 'aria-hidden': 'true' }, h('span', { class: 'pull-arrow' }, '↓'), h('span', { class: 'pull-text' }, 'Pull to refresh'));
document.body.append(pullHint);
const homeScreenApp = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
let pullFrom = null;
let pulled = 0;
document.addEventListener('touchstart', (ev) => {
  pullFrom = null;
  if (!homeScreenApp() || ev.touches.length !== 1 || window.scrollY > 0 || sheet.open || $('login').open) return;
  if (ev.target.closest('textarea, input, select, dialog')) return;
  pullFrom = ev.touches[0].clientY;
  pulled = 0;
}, { passive: true });
document.addEventListener('touchmove', (ev) => {
  if (pullFrom === null) return;
  pulled = ev.touches[0].clientY - pullFrom;
  if (pulled <= 0 || window.scrollY > 0) { pullHint.classList.remove('show', 'ready'); return; }
  pullHint.style.setProperty('--pull', `${Math.min(pulled, PULL_AT * 1.6) * 0.5}px`);
  pullHint.classList.add('show');
  pullHint.classList.toggle('ready', pulled >= PULL_AT);
  pullHint.querySelector('.pull-text').textContent = pulled >= PULL_AT ? 'Release to refresh' : 'Pull to refresh';
}, { passive: true });
const endPull = () => {
  if (pullFrom === null) return;
  const go = pulled >= PULL_AT && window.scrollY <= 0;
  pullFrom = null;
  pullHint.classList.remove('show', 'ready');
  if (go) { toast('Reading every agent…'); readAgentsNow(); }
};
document.addEventListener('touchend', endPull, { passive: true });
document.addEventListener('touchcancel', () => { pullFrom = null; pullHint.classList.remove('show', 'ready'); }, { passive: true });
// Cards per screen on a computer: 3 tall, 4 as 2 × 2 (default) or 6 as 2 rows of 3. Kept on this device.
const GRIDS = ['3', '4', '6'];
function setGrid(grid) {
  const g = GRIDS.includes(grid) ? grid : '4';
  document.documentElement.dataset.grid = g;
  for (const b of $('gridChips').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.grid === g));
  return g;
}
setGrid((() => { try { return localStorage.getItem('agenthub_grid') || ''; } catch { return ''; } })());
$('gridChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const g = setGrid(b.dataset.grid);
  try { localStorage.setItem('agenthub_grid', g); } catch { /* private mode */ }
  showTextEnds($('board')); // the cards just changed size: show each one's end again
});

// The sticky bar's real height, so a screen of cards fills what is left below it.
const topBar = document.querySelector('.topbar'); // the sticky bar: cards fill the screen below it
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--top-h', `${topBar.offsetHeight}px`);
  showTextEnds($('board')); // the cards just changed height: show each one's end again
}).observe(topBar);
document.fonts?.ready.then(() => showTextEnds($('board')));
start();
setInterval(load, 5000);
setInterval(() => { if (state.data && !sheet.open) renderSoon(); }, 30000); // keep wait timers fresh
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
