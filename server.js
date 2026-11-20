// AgentHub — standalone multi-agent control board. Plain Node, no dependencies.
// Start: npm start   (or: node server.js)
//
// Network: listens only on loopback, the computer's home-WiFi address and its Tailscale
// address. Never 0.0.0.0, never public. Every device must enter the PIN, this computer included.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { config, ROOT } from './lib/config.js';
import { demoRefusal, demoVersions } from './lib/demo.js';
import { writeFileAtomicSync } from './lib/atomic.js';
import { refresh, getSnapshot, pageIsCurrent, findCard, startPolling, publicCard, LANES, RESTARTABLE, delegations, readNow, schedule } from './lib/board.js';
import { CONTINUE_MESSAGE } from './lib/schedule.js';
import { askAgent, HARNESS_NAMES } from './lib/ask.js';
import { handOff } from './lib/handoff.js';
import { cannotDelegate } from './lib/delegate.js';
import { buildIcons, iconFile } from './lib/icons.js';
import * as preview from './lib/preview.js';
import { STATIC_COMMANDS } from './lib/commands.js';
import { triageText, triageHtml } from './lib/triage.js';
import * as closedCards from './lib/closed.js';
import { DEFER_MESSAGE, RESUME_MESSAGE, canDefer, deferMismatch } from './lib/defer.js';
import { suggestPrompt, cleanSuggestion, suggestKey, suggestAgent } from './lib/suggest.js';

// Suggested replies, one per agent message (bounded).
const suggestions = new Map();
import { run } from './lib/util.js';
import { checkChoice, replyChoiceMessage, stillAsking } from './lib/choices.js';
import { checkNewChat, chatTitle } from './lib/newchat.js';
import { saveImage, resolveImages, pruneImages, MAX_IMAGE_BYTES } from './lib/uploads.js';
import { cardsForAge } from './lib/status.js';
import { encodeBody } from './lib/http.js';
import { readSettings, cleanSettings, writeSettings } from './lib/settings.js';
import { loadSetup, writeSetup, applyChanges, ACCENTS, expandHome, isPrivateAddress } from './lib/setup.js';
import { fromThisComputer } from './lib/local.js';
import { isHomeInterface } from './lib/platform.js';
import { restartBoard } from './lib/service.js';
import { detect, mergeChanges, detectEnv } from './lib/detect.js';
import { welcomeChecks } from './lib/welcome.js';
import { keychainService } from './lib/usage.js';
import { serviceLabel } from './lib/service.js';
import { versions } from './lib/versions.js';
import { hashPin, verifyPin, validPin, isHashed, actionToken, checkAction, failureKeys, changePin, saveFailures, loadFailures, cookieName } from './lib/auth.js';

// ---------- secrets kept on this computer only ----------
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
function readOrCreate(name, make) {
  const file = path.join(config.dataDir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, make(), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}
// The PIN is kept only as a salted hash. An older plain-text PIN is converted in place (same PIN, now unreadable).
// With no PIN set yet, nobody can log in until you run `npm run set-pin` on this computer.
const PIN_FILE = path.join(config.dataDir, 'pin');
let PIN_HASH = fs.existsSync(PIN_FILE) ? fs.readFileSync(PIN_FILE, 'utf8').trim() : '';
if (PIN_HASH && !isHashed(PIN_HASH)) {
  PIN_HASH = hashPin(PIN_HASH);
  writeFileAtomicSync(PIN_FILE, PIN_HASH);
}
let SECRET = readOrCreate('secret', () => crypto.randomBytes(32).toString('hex')); // replaced by a PIN change
// Login cookie names come from cookieName(host) in lib/auth.js (one per port).
const COOKIE_DAYS = 365;

function sign(value) { return crypto.createHmac('sha256', SECRET).update(value).digest('hex'); }
function makeCookie() {
  const exp = String(Date.now() + COOKIE_DAYS * 86400000);
  return `${exp}.${sign(exp)}`;
}
function cookieValid(raw) {
  if (!raw) return false;
  const [exp, mac] = raw.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return ''; } }
  }
  return '';
}

// ---------- network addresses ----------
const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const isPrivateLan = (a) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
const isTailscale = (a) => { const [x, y] = a.split('.').map(Number); return x === 100 && y >= 64 && y <= 127; };

function wantedAddresses() {
  const out = new Map([['127.0.0.1', 'local']]);
  if (config.demo) return out; // the demo only ever listens on this computer
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (isTailscale(a.address)) out.set(a.address, 'tailscale');
      // Home-WiFi listening is off by default: plain HTTP on the LAN would send the PIN and
      // login cookie unencrypted. Tailscale traffic is encrypted. Opt back in with AGENTHUB_LAN=1.
      else if (config.listenLan && isPrivateLan(a.address) && isHomeInterface(ifname)) out.set(a.address, 'lan');
      // Extra private addresses chosen in Settings → Phone access (another private network), while this computer has them.
      else if (config.extraAddresses.includes(a.address) && isPrivateAddress(a.address)) out.set(a.address, 'extra');
    }
  }
  return out;
}

let tailscaleDns = '';
let tailscaleHttpsUrl = '';
// A read that fails (Tailscale busy, restarting) keeps the last good names: dropping them would refuse phones
// using the Tailscale name until the next read, 5 minutes later. The demo never reads Tailscale.
async function readTailscale() {
  if (config.demo) return;
  try {
    const st = JSON.parse(await run('tailscale', ['status', '--json'], { timeoutMs: 5000 }));
    tailscaleDns = (st.Self?.DNSName || '').replace(/\.$/, '');
  } catch { /* keep the last good name */ }
  try {
    const serve = await run('tailscale', ['serve', 'status'], { timeoutMs: 5000 });
    const block = serve.split(/\n\s*\n/).find((b) => new RegExp(`127\\.0\\.0\\.1:${config.port}\\b`).test(b));
    const m = block && block.match(/https:\/\/\S+/);
    tailscaleHttpsUrl = m ? m[0] : '';
  } catch { /* keep the last good address */ }
}

function allowedHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || isLoopback(host)) return true;
  if (listeners.has(host)) return true;
  if (tailscaleDns && host === tailscaleDns.toLowerCase()) return true;
  if (host === `${os.hostname().toLowerCase().replace(/\.local$/, '')}.local`) return true;
  return false;
}

// ---------- login rate limit ----------
// Per-client limit: 5 wrong PINs per 10 minutes. Board-wide limit: 20 per 10 minutes,
// so rotating addresses can't brute-force the 6-digit PIN.
const FAIL_WINDOW_MS = 10 * 60000;
const PER_CLIENT_LIMIT = 5;
const GLOBAL_LIMIT = 20; // per shared allowance: 'loopback' (this computer + tailscale serve) or 'network'
// key -> [timestamps]; saved in .data so restarting the board doesn't reset the wrong-PIN limits.
const FAILURES_FILE = path.join(config.dataDir, 'login-failures.json');
const failures = loadFailures(FAILURES_FILE, Date.now(), FAIL_WINDOW_MS);
function recentFailures(key) {
  const recent = (failures.get(key) || []).filter((t) => Date.now() - t < FAIL_WINDOW_MS);
  if (recent.length) failures.set(key, recent);
  else failures.delete(key);
  return recent.length;
}
function tooManyFailures([client, shared]) {
  return recentFailures(client) >= PER_CLIENT_LIMIT || recentFailures(shared) >= GLOBAL_LIMIT;
}
function recordFailure(keys) {
  for (const key of keys) {
    if (!failures.has(key)) failures.set(key, []);
    failures.get(key).push(Date.now());
  }
  saveFailures(FAILURES_FILE, failures);
}
/** The client's address. X-Forwarded-For is only trusted when the connection itself comes
 *  from loopback (i.e. through `tailscale serve`), and then only its LAST entry — the one
 *  the proxy appended. Earlier entries are whatever the client chose to send. */
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for'];
  if (isLoopback(peer) && forwarded) {
    const last = forwarded.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return peer;
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

/** An error that answers the request with its own status (400 bad request, 413 too large) instead of a 500. */
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw httpError(413, 'Request too large.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'Not valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Expected a JSON object.');
  return body;
}

const SETUP_FILE = path.join(config.dataDir, 'setup.json');

/**
 * Where the board can be reached right now ({ kind, url, note }), and this computer's other private addresses that
 * could be added as extra ones (not Tailscale, not already listened on).
 */
function reachable() {
  const port = config.port;
  const reach = [{ kind: 'This computer', url: `http://localhost:${port}`, note: '' }];
  for (const [addr, kind] of wantedAddresses()) {
    if (!listeners.has(addr) || addr === '127.0.0.1') continue;
    if (kind === 'tailscale') reach.push({ kind: 'Tailscale', url: `http://${tailscaleDns || addr}:${port}`, note: 'Encrypted by Tailscale. The mic needs the HTTPS address.' });
    if (kind === 'lan') reach.push({ kind: 'Home Wi-Fi', url: `http://${addr}:${port}`, note: 'Plain HTTP: only on a network you trust.' });
    if (kind === 'extra') reach.push({ kind: 'Extra address', url: `http://${addr}:${port}`, note: '' });
  }
  if (tailscaleHttpsUrl) reach.push({ kind: 'Tailscale HTTPS', url: tailscaleHttpsUrl, note: 'Best on a phone: encrypted, and the mic works.' });
  const candidates = [];
  if (config.demo) return { reach, candidates }; // the demo never shows this computer's addresses
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateAddress(a.address) || isTailscale(a.address)) continue;
      candidates.push({ address: a.address, iface: ifname });
    }
  }
  return { reach, candidates };
}

/** The visible folders directly inside `dir`, A→Z ([] when it can't be read). */
function subfolders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

/**
 * The page's own version: when any file of the page changes, so does this, and an open page (a browser tab, an app
 * installed from Chrome or to the Home Screen) reloads itself at a safe moment. Checked at most every 10 seconds.
 */
let versionCache = { at: 0, value: '' };
function pageVersion() {
  if (Date.now() - versionCache.at < 10000) return versionCache.value;
  let latest = 0;
  for (const name of fs.readdirSync(config.publicDir)) {
    if (!/\.(js|css|html)$/.test(name)) continue;
    try { latest = Math.max(latest, fs.statSync(path.join(config.publicDir, name)).mtimeMs); } catch { /* gone */ }
  }
  versionCache = { at: Date.now(), value: String(Math.round(latest)) };
  return versionCache.value;
}

/** True when something answers on this computer's `port` within a moment (Detect: is the agent running?). */
function knock(port) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// Whether the welcome has been finished (from the setup; updated at once when it is, even without a restart).
let welcomeDone = config.welcomeDone;

/**
 * After a setup change: a restart applies it everywhere at once (lanes, New chat, suggestions, rings), and the page
 * reconnects by itself. A board started by hand (npm start, not a service) can't restart itself: the page is told
 * to ask for a restart instead.
 */
async function restartToApply(res) {
  const restarting = !!(await serviceLabel());
  send(res, 200, { ok: true, restarting });
  if (restarting) setTimeout(() => restartBoard().catch((e) => console.error('[restart]', e.message)), 500);
}

/** Whether a request comes from a browser on this computer itself (lib/local.js), never from a phone. */
function isLocalRequest(req) {
  return fromThisComputer({ peer: req.socket.remoteAddress || '', forwarded: req.headers['x-forwarded-for'] || '', host: req.headers.host || '' });
}

/**
 * The part of the setup Settings shows: each agent's on/off, default model and program paths (as stored, `~/…`),
 * suggestions and usage rings. Never a secret: the setup holds none.
 */
function setupView(s) {
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? '']));
  const fixed = (key, label, paths) => ({ key, kind: key, label, enabled: s.agents[key].enabled !== false,
    ...(key === 'codex' ? { model: s.agents.codex.model || '' } : {}), paths: pick(s.agents[key], paths) });
  return {
    agents: [
      fixed('hermes', 'Hermes', ['dashboardUrl', 'launcher', 'kanbanRoot']),
      fixed('openclaw', 'OpenClaw', ['bin', 'port']),
      ...s.agents.claude.map((a) => ({ key: a.id, kind: 'claude', label: a.label || a.id, enabled: a.enabled !== false, model: a.model || '',
        paths: { command: a.command || '', configDir: a.configDir || '', folderArg: a.folderArg === true, tag: a.tag || '', accent: a.accent || '' } })),
      fixed('codex', 'Codex', ['command', 'sessionsDir']),
    ],
    accents: ACCENTS,
    // Settings → Phone access: the choices, where the board can be reached right now, and addresses that could be added.
    access: { homeWifi: s.access.homeWifi === true, extraAddresses: s.access.extraAddresses || [], lanForced: config.lanForced, port: config.port, ...reachable() },
    // Settings → Projects: the grouping, plus the folders and kanban boards that exist now, to pick from.
    projects: { root: s.projects.root, groups: s.projects.groups, ignore: s.projects.ignore,
      found: subfolders(expandHome(s.projects.root)), boards: s.agents.hermes.enabled !== false ? subfolders(expandHome(s.agents.hermes.kanbanRoot)) : [] },
    suggest: { agent: s.suggest.agent || '', model: s.suggest.model || 'sonnet' },
    usage: { rings: s.usage.rings !== false },
  };
}

/** Log an action. Never throws: a message that was sent must never be reported as "not sent" because logging failed. */
async function audit(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  try {
    await fsp.appendFile(path.join(config.dataDir, 'actions.log'), `${line}\n`, { mode: 0o600 });
  } catch (e) {
    console.error('[audit] could not write the log:', e.message);
  }
}

// Images you add to messages (lib/uploads.js). Cleared after 30 days.
const UPLOADS_DIR = path.join(config.dataDir, 'uploads');
pruneImages(UPLOADS_DIR).catch(() => {});
setInterval(() => pruneImages(UPLOADS_DIR).catch(() => {}), 24 * 3600000);
/** What the action log says about a message's images (never the images themselves). */
const imagesLogged = (images) => (images.length ? ` [+${images.length} image${images.length > 1 ? 's' : ''}]` : '');

const ACTION_TEXT = {
  approve: () => 'Approved. Go ahead.',
  changes: (t) => `Request changes: ${t}`,
  reply: (t) => t,
};

const MIME = { '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(config.publicDir, rel);
  if (!file.startsWith(config.publicDir + path.sep)) return send(res, 403, 'forbidden');
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(data);
  } catch {
    send(res, 404, 'not found');
  }
}

async function sendFile(res, file, type) {
  const data = await fsp.readFile(file);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

/** Lanes that are connected right now (Ask Agent and Handoff only offer these). */
function connectedLanes() {
  return Object.entries(getSnapshot().lanes).filter(([, l]) => l.connected).map(([k]) => k);
}

// ---------- routes ----------
async function handle(req, res) {
  if (!allowedHost(req.headers.host)) return send(res, 421, 'unknown host');
  const url = new URL(req.url, 'http://board');
  const p = url.pathname;
  // Every device logs in with the PIN, this computer included: being on this computer proves nothing (any program here can call
  // the board), so only the login cookie counts.
  const COOKIE_NAME = cookieName(req.headers.host); // one login cookie per port
  const cookie = readCookie(req, COOKIE_NAME);
  // Demo mode needs no PIN: it holds nothing real, and demoRefusal keeps it to its own page and its made-up agents.
  if (config.demo) {
    const refusal = demoRefusal({ method: req.method, path: p, host: req.headers.host, origin: req.headers.origin, port: config.port });
    if (refusal) return send(res, 403, { error: refusal });
  }
  const authed = config.demo || cookieValid(cookie);

  if (req.method === 'POST') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
    const origin = req.headers.origin;
    let originHost = '';
    try { originHost = origin ? new URL(origin).host : ''; } catch { originHost = 'invalid'; }
    if (origin && originHost !== req.headers.host) return send(res, 403, { error: 'cross-origin request refused' });
  }

  // Before any login: has a PIN been set, and is this browser on the computer itself? (The page shows "Create your
  // PIN" only then; anywhere else it says to create it on the computer.)
  if (p === '/api/hello' && req.method === 'GET') return send(res, 200, { needsPin: !config.demo && !PIN_HASH, here: isLocalRequest(req), demo: config.demo });
  // The first PIN, from the browser (the welcome): only while there is none, only from the computer itself, only from
  // the board's own page (a site open in the same browser can't do it), and you are logged in right away.
  if (p === '/api/first-pin' && req.method === 'POST') {
    const { pin } = await readJson(req);
    if (PIN_HASH) return send(res, 409, { error: 'A PIN is already set. Log in with it.' });
    if (!isLocalRequest(req)) return send(res, 403, { error: 'Create the PIN on the computer AgentHub runs on.' });
    const origin = String(req.headers.origin || '');
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'Create the PIN from the AgentHub page itself.' });
    if (!validPin(String(pin || ''))) return send(res, 400, { error: 'A PIN is 8 to 12 digits.' });
    PIN_HASH = hashPin(String(pin));
    SECRET = crypto.randomBytes(32).toString('hex');
    for (const [name, value] of [['pin', PIN_HASH], ['secret', SECRET]]) {
      const file = path.join(config.dataDir, name);
      writeFileAtomicSync(file, value);
    }
    await audit({ kind: 'pin-created', message: '[first PIN created on this computer]', ok: true, peer: req.socket.remoteAddress || '' });
    const fresh = makeCookie();
    return send(res, 200, { ok: true, token: actionToken(fresh, SECRET) }, {
      'Set-Cookie': `${COOKIE_NAME}=${fresh}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}`,
    });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const keys = failureKeys({ peer: req.socket.remoteAddress || '', forwarded: req.headers['x-forwarded-for'] });
    // Read the body first, then check-compare-record with no await in between, so parallel
    // requests can't all slip past the limit before any failure is counted.
    const { pin } = await readJson(req);
    if (tooManyFailures(keys)) {
      await audit({ kind: 'login-refused', message: '[too many wrong PINs]', ok: false, ip, peer: req.socket.remoteAddress || '' });
      return send(res, 429, { error: 'Too many wrong PINs. Wait 10 minutes.' });
    }
    if (!PIN_HASH) return send(res, 503, { error: 'No PIN is set yet. On the computer, run: npm run set-pin' });
    if (!verifyPin(String(pin || ''), PIN_HASH)) {
      recordFailure(keys);
      audit({ kind: 'login-failed', message: '[wrong PIN]', ok: false, ip, peer: req.socket.remoteAddress || '' }).catch(() => {});
      return send(res, 401, { error: 'Wrong PIN' });
    }
    const secure = req.headers['x-forwarded-proto'] === 'https' || !!req.headers['tailscale-user-login'];
    const fresh = makeCookie();
    audit({ kind: 'login', message: '[logged in]', ok: true, ip, peer: req.socket.remoteAddress || '' }).catch(() => {});
    // The action token is handed out only here, in the login answer: the page keeps it in its own storage (separate
    // per port), so a cookie that leaks to another site on the same host name can't be used to act.
    return send(res, 200, { ok: true, token: actionToken(fresh, SECRET) }, {
      'Set-Cookie': `${COOKIE_NAME}=${fresh}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}${secure ? '; Secure' : ''}`,
    });
  }

  if (p.startsWith('/api/')) {
    if (!authed) return send(res, 401, { error: 'PIN required' });
    // Anything that acts must come from the board page: same origin plus the token the page got for its login.
    // (The demo has no login, so no token: demoRefusal above already checked where the request comes from.)
    const refused = config.demo ? '' : checkAction({ method: req.method, path: p, origin: req.headers.origin, host: req.headers.host, cookie,
      token: req.headers['x-agenthub-token'] }, SECRET);
    if (refused) return send(res, 403, { error: refused, relogin: true });

    if (p === '/api/board' && req.method === 'GET') {
      // Only the cards inside the chosen window go to the page (Blocked and Running always do), so a phone polling
      // every few seconds never downloads months of chats. `fresh=1` (a page that just opened, e.g. pulled to
      // refresh) reads every agent first, unless the board is only seconds old.
      const snap = url.searchParams.get('fresh') === '1' ? await readNow().catch(() => getSnapshot()) : getSnapshot();
      const age = ['today', '7d', '30d', 'all'].includes(url.searchParams.get('age')) ? url.searchParams.get('age') : '7d';
      // The page already has this exact board (same read, same window): say so instead of sending it again.
      if (pageIsCurrent(snap, url.searchParams.get('since'), age)) {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const cards = cardsForAge(snap.cards, age);
      const { body, headers } = encodeBody(JSON.stringify({ ...snap, cards: cards.map(publicCard), age, totalCards: snap.cards.length,
        refreshMs: config.refreshMs, version: pageVersion(), welcome: !welcomeDone }),
        req.headers['accept-encoding']);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      return res.end(body);
    }
    const settingsFile = path.join(config.dataDir, 'settings.json');
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, readSettings(settingsFile));
    // Settings → Agent settings (step C): what the page may show of this install's setup, and whether this browser is
    // on the computer itself (only it may change computer-only fields such as default models).
    if (p === '/api/setup' && req.method === 'GET') {
      const s = loadSetup(SETUP_FILE);
      return send(res, 200, { fromThisComputer: isLocalRequest(req), ...setupView(s) });
    }
    // Detect (step C3): what it finds on this computer, as proposals; applying ticked ones is for this computer only.
    if (p === '/api/detect' && req.method === 'GET') {
      const s = loadSetup(SETUP_FILE);
      const items = detect(s).map(({ change, ...rest }) => rest);
      const port = (u) => Number(/:(\d+)/.exec(u || '')?.[1]) || 0;
      const [hermesUp, openclawUp] = await Promise.all([knock(port(s.agents.hermes.dashboardUrl)), knock(Number(s.agents.openclaw.port))]);
      return send(res, 200, { fromThisComputer: isLocalRequest(req), items, running: { hermes: hermesUp, openclaw: openclawUp } });
    }
    if (p === '/api/detect' && req.method === 'POST') {
      const { ids, confirm } = await readJson(req);
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      if (!isLocalRequest(req)) return send(res, 403, { error: 'Detect can only change the setup on the computer AgentHub runs on.' });
      const s = loadSetup(SETUP_FILE);
      const picked = detect(s).filter((i) => Array.isArray(ids) && ids.includes(i.id));
      if (!picked.length) return send(res, 400, { error: 'Tick at least one finding (or they changed: run Detect again).' });
      const { setup: next, error } = applyChanges(s, mergeChanges(picked), { local: true });
      if (error) return send(res, 400, { error });
      writeSetup(SETUP_FILE, next);
      await audit({ kind: 'setup', message: `[Detect applied] ${picked.map((i) => i.label).join('; ')}`, ok: true });
      return restartToApply(res);
    }
    // The welcome: each agent's state and next steps, tmux, and whether AgentHub already starts with the computer.
    if (p === '/api/welcome' && req.method === 'GET') {
      const s = loadSetup(SETUP_FILE);
      const port = (u) => Number(/:(\d+)/.exec(u || '')?.[1]) || 0;
      const [hermesUp, openclawUp] = await Promise.all([knock(port(s.agents.hermes.dashboardUrl)), knock(Number(s.agents.openclaw.port))]);
      const signed = new Map();
      for (const c of s.agents.claude) {
        const dir = expandHome(c.configDir);
        let ok = fs.existsSync(path.join(dir, '.credentials.json'));
        if (!ok && process.platform === 'darwin') ok = await run('/usr/bin/security', ['find-generic-password', '-s', keychainService(dir)], { timeoutMs: 5000 }).then(() => true, () => false);
        signed.set(dir, ok);
      }
      const checks = welcomeChecks(s, detectEnv(), { signedIn: (dir) => signed.get(dir) === true, exists: (f) => fs.existsSync(f), listening: { hermes: hermesUp, openclaw: openclawUp } });
      return send(res, 200, { ...checks, fromThisComputer: isLocalRequest(req), service: await serviceLabel(), mac: process.platform === 'darwin', port: config.port });
    }
    // Start with the computer, from the welcome (this computer only): install the service. When this board was started
    // by hand, it then steps aside so the service takes over (the page reconnects by itself).
    if (p === '/api/install-service' && req.method === 'POST') {
      const { confirm } = await readJson(req);
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      if (!isLocalRequest(req)) return send(res, 403, { error: 'This can only be done on the computer AgentHub runs on.' });
      const already = await serviceLabel();
      if (already) return send(res, 200, { ok: true, already });
      try {
        const out = await run(process.execPath, [path.join(ROOT, 'scripts', 'service.js'), 'install'], { timeoutMs: 60000 });
        await audit({ kind: 'service', message: '[installed to start with the computer]', ok: true });
        send(res, 200, { ok: true, output: out.trim().split('\n').slice(-3).join('\n') });
        setTimeout(() => process.exit(0), 1500); // the service starts the board again
        return;
      } catch (e) {
        await audit({ kind: 'service', message: '[install failed]', ok: false, error: e.message });
        return send(res, 502, { error: `Not installed: ${e.message}` });
      }
    }
    if (p === '/api/setup' && req.method === 'POST') {
      const { changes, confirm } = await readJson(req);
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      const local = isLocalRequest(req);
      const { setup: next, error } = applyChanges(loadSetup(SETUP_FILE), changes, { local });
      if (error) return send(res, 400, { error });
      writeSetup(SETUP_FILE, next);
      await audit({ kind: 'setup', message: `[setup changed${local ? ' on this computer' : ''}] ${JSON.stringify(changes)}`, ok: true });
      if (changes?.welcome) welcomeDone = next.welcome.done !== false; // at once, restart or not
      return restartToApply(res);
    }
    // Change the PIN from Settings: current PIN required; every other device is signed out (new signing secret);
    // this device gets a fresh login and action token so it keeps working.
    if (p === '/api/pin' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      const keys = failureKeys({ peer: req.socket.remoteAddress || '', forwarded: req.headers['x-forwarded-for'] });
      if (tooManyFailures(keys)) return send(res, 429, { error: 'Too many wrong PINs. Wait 10 minutes.' });
      const result = changePin({ current: body.current, next: body.next, pinHash: PIN_HASH });
      if (result.error) {
        if (/current PIN/.test(result.error)) {
          recordFailure(keys);
          await audit({ kind: 'pin-change-failed', message: '[wrong current PIN]', ok: false, peer: req.socket.remoteAddress || '' });
          return send(res, 403, { error: result.error });
        }
        return send(res, 400, { error: result.error });
      }
      for (const [name, value] of [['pin', result.pinHash], ['secret', result.secret]]) {
        const file = path.join(config.dataDir, name);
        writeFileAtomicSync(file, value);
      }
      PIN_HASH = result.pinHash;
      SECRET = result.secret;
      const fresh = makeCookie();
      const secure = req.headers['x-forwarded-proto'] === 'https' || !!req.headers['tailscale-user-login'];
      await audit({ kind: 'pin-changed', message: '[PIN changed; other devices signed out]', ok: true, peer: req.socket.remoteAddress || '' });
      return send(res, 200, { ok: true, token: actionToken(fresh, SECRET) }, {
        'Set-Cookie': `${COOKIE_NAME}=${fresh}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}${secure ? '; Secure' : ''}`,
      });
    }
    // Restart AgentHub itself: answer first, then let launchd restart the service.
    if (p === '/api/restart-board' && req.method === 'POST') {
      const { confirm } = await readJson(req);
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      await audit({ kind: 'restart-board', message: '[AgentHub restart requested]', ok: true });
      if (!(await serviceLabel())) return send(res, 409, { error: 'AgentHub is not running as a service, so it cannot restart itself. Stop it (Ctrl+C) and run npm start again, or set it to start with your computer.' });
      send(res, 200, { ok: true });
      setTimeout(() => restartBoard().catch((e) => console.error('[restart]', e.message)), 500);
      return;
    }
    if (p === '/api/versions' && req.method === 'GET') {
      // The demo never runs the real agent programs: made-up versions, all up to date.
      if (config.demo) return send(res, 200, demoVersions());
      return send(res, 200, await versions({ fresh: url.searchParams.get('fresh') === '1' }));
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      const { confirm, ...wanted } = body;
      const cleaned = cleanSettings(wanted);
      if (typeof cleaned === 'string') return send(res, 400, { error: cleaned });
      writeSettings(settingsFile, cleaned);
      await audit({ kind: 'settings', message: `[board defaults] ${JSON.stringify(cleaned)}`, ok: true });
      return send(res, 200, cleaned);
    }
    if (p === '/api/refresh' && req.method === 'POST') {
      const snap = await refresh();
      return send(res, 200, { ...snap, cards: snap.cards.map(publicCard) });
    }
    if (p === '/api/messages' && req.method === 'GET') {
      const card = findCard(url.searchParams.get('id') || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      try {
        const lane = LANES[card.harness].mod;
        const messages = await lane.messages(card);
        const screen = typeof lane.screen === 'function' ? await lane.screen(card).catch(() => '') : '';
        return send(res, 200, { card: publicCard(card), messages, screen });
      } catch (e) {
        return send(res, 502, { error: `Could not load messages: ${e.message}` });
      }
    }
    if (p === '/api/commands' && req.method === 'GET') {
      const harness = url.searchParams.get('harness') || '';
      if (!Object.hasOwn(LANES, harness)) return send(res, 404, { error: 'Unknown agent' });
      const lane = LANES[harness].mod;
      try {
        const commands = typeof lane.commands === 'function' ? await lane.commands() : (STATIC_COMMANDS[harness] || []);
        return send(res, 200, { commands });
      } catch (e) {
        return send(res, 502, { error: `Could not load ${HARNESS_NAMES[harness]}'s commands: ${e.message}` });
      }
    }
    if (p === '/api/ask' && req.method === 'POST') {
      const { id, agent, question } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      const q = String(question || '').trim();
      if (!q) return send(res, 400, { error: 'Type a question first.' });
      if (q.length > 4000) return send(res, 400, { error: 'Question too long.' });
      if (!connectedLanes().includes(agent)) return send(res, 409, { error: `${HARNESS_NAMES[agent] || 'That agent'} is not connected right now.` });
      try {
        const answer = await askAgent({ lanes: LANES, card, agent, question: q });
        await audit({ kind: 'ask', harness: agent, session: card.ref, title: card.title, message: q, ok: true });
        return send(res, 200, { answer, agent });
      } catch (e) {
        await audit({ kind: 'ask', harness: agent, session: card.ref, title: card.title, message: q, ok: false, error: e.message });
        return send(res, 502, { error: `${HARNESS_NAMES[agent]} could not answer: ${e.message}` });
      }
    }
    if (p === '/api/handoff' && req.method === 'POST') {
      const { id, to, task, folder, confirm } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      if (!connectedLanes().includes(to)) return send(res, 409, { error: `${HARNESS_NAMES[to] || 'That agent'} is not connected right now.` });
      const allowed = new Set([card.cwd, ...getSnapshot().folders.map((f) => f.path)].filter(Boolean));
      if (folder && !allowed.has(folder)) return send(res, 400, { error: 'Pick one of the listed folders.' });
      try {
        const record = await handOff({ lanes: LANES, card, to, task, folder });
        await audit({ kind: 'handoff', harness: card.harness, session: card.ref, title: card.title, message: `[handed off to ${HARNESS_NAMES[to]}] ${record.task}`, ok: true, to: record.to, notified: record.notified, notifyError: record.notifyError });
        refresh().catch(() => {});
        return send(res, 200, { ok: true, record });
      } catch (e) {
        await audit({ kind: 'handoff', harness: card.harness, session: card.ref, title: card.title, message: `[hand off to ${HARNESS_NAMES[to] || to}] ${String(task || '')}`, ok: false, error: e.message });
        return send(res, 502, { error: `Not handed off: ${e.message}` });
      }
    }
    // Have another agent (Hermes for now) do one task for a chat; the chat keeps its task (lib/delegate.js).
    // `preview: true` returns the helper's first message without starting anything.
    if (p === '/api/delegate' && req.method === 'POST') {
      const { id, to, task, folder, confirm, preview } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      if (!LANES[to]) return send(res, 400, { error: 'Unknown agent.' });
      if (!connectedLanes().includes(to)) return send(res, 409, { error: `${HARNESS_NAMES[to]} isn't running right now.` });
      const problem = cannotDelegate(card, to, HARNESS_NAMES);
      if (problem) return send(res, 409, { error: problem });
      const allowed = new Set([card.cwd, ...getSnapshot().folders.map((f) => f.path)].filter(Boolean));
      if (folder && !allowed.has(folder)) return send(res, 400, { error: 'Pick one of the listed folders.' });
      if (String(task || '').length > 8000) return send(res, 400, { error: 'Task too long.' });
      if (preview === true) return send(res, 200, { prompt: delegations.preview({ card, to, task, names: HARNESS_NAMES }) });
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      try {
        const record = await delegations.delegate({ lane: LANES[to].mod, card, to, task, folder, names: HARNESS_NAMES });
        await audit({ kind: 'delegate', harness: card.harness, session: card.ref, title: card.title, message: `[asked ${HARNESS_NAMES[to]} to do] ${record.task}`, ok: true, to: record.to });
        refresh().catch(() => {});
        return send(res, 200, { ok: true, record });
      } catch (e) {
        await audit({ kind: 'delegate', harness: card.harness, session: card.ref, title: card.title, message: `[ask ${HARNESS_NAMES[to]} to do] ${String(task || '')}`, ok: false, error: e.message });
        return send(res, 502, { error: `Not sent to ${HARNESS_NAMES[to]}: ${e.message}` });
      }
    }
    // Send a helper's result back to the chat that asked, as your reply (after you checked it).
    if (p === '/api/delegate/result' && req.method === 'POST') {
      const { id, text, confirm } = await readJson(req);
      const helper = findCard(id || '');
      if (!helper) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      const record = await delegations.forHelper(helper);
      if (!record) return send(res, 409, { error: 'This chat has no task waiting to be reported back.' });
      const from = findCard(record.from.id);
      if (!from) return send(res, 409, { error: `The chat that asked (“${record.from.title}”) is not on the board any more. Copy the report and paste it there.` });
      if (!from.canReply || typeof LANES[from.harness].mod.send !== 'function') {
        return send(res, 409, { error: `${from.replyBlockedReason || 'The board cannot send to the chat that asked.'} Copy the report and paste it there.` });
      }
      if (from.pendingPrompt) return send(res, 409, { error: `${HARNESS_NAMES[from.harness]} is showing an approval right now. Answer that first, then send the result.` });
      const body = String(text || '').trim();
      if (!body) return send(res, 400, { error: 'Type a message first.' });
      if (body.length > 8000) return send(res, 400, { error: 'Message too long.' });
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      try {
        await LANES[from.harness].mod.send(from, { kind: 'reply', message: body, images: [], expectPrompt: false, expectText: '' });
        // Sent: from here on nothing may report it as not sent.
        await delegations.markDone(record.id).catch((e) => console.error('[delegate] could not mark done:', e.message));
        await audit({ kind: 'delegate-result', harness: from.harness, session: from.ref, title: from.title, message: `[result from ${HARNESS_NAMES[helper.harness]}] ${body}`, ok: true });
        refresh().catch(() => {});
        return send(res, 200, { ok: true });
      } catch (e) {
        await audit({ kind: 'delegate-result', harness: from.harness, session: from.ref, title: from.title, message: `[result from ${HARNESS_NAMES[helper.harness]}] ${body}`, ok: false, error: e.message });
        return send(res, 502, { error: `Not sent: ${e.message}` });
      }
    }
    // Continue later: plan a Continue for a chat (by default two minutes after its usage limit resets), or cancel it.
    if (p === '/api/schedule' && req.method === 'POST') {
      const { id, at, confirm } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      if (!card.canReply) return send(res, 409, { error: card.replyBlockedReason || 'The board cannot type into this chat.' });
      const when = Number(at) || card.limit?.continueAt || 0;
      if (!when) return send(res, 400, { error: 'The agent did not say when its limit resets. Pick a time.' });
      if (when < Date.now() - 60000 || when > Date.now() + 8 * 24 * 3600e3) return send(res, 400, { error: 'Pick a time within the next week.' });
      const plan = await schedule.plan(card, when, card.limit ? `after the ${card.limit.label} resets` : '');
      await audit({ kind: 'schedule', harness: card.harness, session: card.ref, title: card.title, message: `[Continue planned for ${new Date(when).toISOString()}]`, ok: true });
      refresh().catch(() => {});
      return send(res, 200, { ok: true, plan });
    }
    if (p === '/api/schedule/cancel' && req.method === 'POST') {
      const { id } = await readJson(req);
      const card = findCard(id || '');
      const cancelled = await schedule.cancel(id || '');
      if (cancelled) await audit({ kind: 'schedule', harness: card?.harness || '', session: card?.ref || '', title: card?.title || '', message: '[planned Continue cancelled]', ok: true });
      refresh().catch(() => {});
      return send(res, 200, { ok: true, cancelled });
    }
    if (p === '/api/close' && req.method === 'POST') {
      const { id, mode, confirm } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      if (mode === 'board') {
        closedCards.close(card.id);
        await audit({ kind: 'close', harness: card.harness, session: card.ref, title: card.title, message: '[closed on the board]', ok: true });
        refresh().catch(() => {});
        return send(res, 200, { ok: true, output: 'Closed on the board. It comes back if anything new happens in it.' });
      }
      if (mode !== 'end') return send(res, 400, { error: 'Unknown close mode' });
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      if (!card.canEnd || typeof LANES[card.harness].mod.endSession !== 'function') {
        return send(res, 409, { error: `The board can't end this ${HARNESS_NAMES[card.harness]} chat. You can still close it on the board.` });
      }
      try {
        const output = await LANES[card.harness].mod.endSession(card);
        closedCards.close(card.id);
        await audit({ kind: 'end', harness: card.harness, session: card.ref, title: card.title, message: '[ended the chat]', ok: true });
        refresh().catch(() => {});
        return send(res, 200, { ok: true, output });
      } catch (e) {
        await audit({ kind: 'end', harness: card.harness, session: card.ref, title: card.title, message: '[end the chat]', ok: false, error: e.message });
        return send(res, 502, { error: `Not ended: ${e.message}` });
      }
    }
    if (p === '/api/reopen' && req.method === 'POST') {
      const { id } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more.' });
      closedCards.reopen(card.id);
      await audit({ kind: 'reopen', harness: card.harness, session: card.ref, title: card.title, message: '[reopened on the board]', ok: true });
      refresh().catch(() => {});
      return send(res, 200, { ok: true });
    }
    // Suggested reply for a card that needs you: written by the one-shot side chat when you ask for it.
    // A POST, so it needs the page token like every action (it spends a little model usage).
    if (p === '/api/suggest' && req.method === 'POST') {
      const { id } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      // Any card where the agent spoke last and is waiting: Blocked, Review, or an Update (a report you may still answer).
      if (!card.canReply || !['blocked', 'review', 'update'].includes(card.status)) return send(res, 409, { error: 'No suggestion for this card.' });
      const key = suggestKey(card);
      if (suggestions.has(key)) return send(res, 200, { suggestion: suggestions.get(key) });
      const agent = suggestAgent(card);
      if (!agent) return send(res, 409, { error: 'Suggested replies need a Claude Code account (Settings → Agents).' });
      if (!connectedLanes().includes(agent)) return send(res, 409, { error: `${HARNESS_NAMES[agent] || 'That agent'} is not connected right now.` });
      try {
        const suggestion = cleanSuggestion(await LANES[agent].mod.sideAsk({ context: suggestPrompt(card), model: config.suggest.model }));
        if (suggestions.size > 200) suggestions.delete(suggestions.keys().next().value);
        if (suggestion) suggestions.set(key, suggestion);
        return send(res, 200, { suggestion });
      } catch (e) {
        return send(res, 502, { error: `No suggestion: ${e.message}` });
      }
    }
    // Defer: tell the agent to hold off (leaving a menu with Esc first), then keep the card closed until your own
    // last message in that chat changes or you tap Resume.
    if (p === '/api/defer' && req.method === 'POST') {
      const { id, confirm, expectPrompt, expectText } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      const changed = deferMismatch(card, { expectPrompt, expectText });
      if (changed) return send(res, 409, { error: changed });
      const lane = LANES[card.harness].mod;
      if (!canDefer(card) || typeof lane.defer !== 'function') return send(res, 409, { error: `The board can't defer this ${HARNESS_NAMES[card.harness]} chat. Answer it in its own window.` });
      try {
        await lane.defer(card, DEFER_MESSAGE);
        closedCards.defer(card.id, [card.lastPrompt, DEFER_MESSAGE]);
        await audit({ kind: 'defer', harness: card.harness, session: card.ref, title: card.title, message: DEFER_MESSAGE, ok: true });
        refresh().catch(() => {});
        return send(res, 200, { ok: true, output: `Deferred. ${HARNESS_NAMES[card.harness]} was told to hold off; the card is in Closed until you come back to it.` });
      } catch (e) {
        await audit({ kind: 'defer', harness: card.harness, session: card.ref, title: card.title, message: DEFER_MESSAGE, ok: false, error: e.message });
        return send(res, 502, { error: `Not deferred: ${e.message}` });
      }
    }
    // Resume a deferred card: tell the agent to pick it back up, and put the card back on the board.
    if (p === '/api/resume' && req.method === 'POST') {
      const { id, confirm } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      if (!card.deferred || !card.canReply) return send(res, 409, { error: 'Only a deferred chat the board can type into can be resumed here.' });
      try {
        await LANES[card.harness].mod.send(card, { kind: 'reply', message: RESUME_MESSAGE, expectPrompt: false, expectText: '' });
        closedCards.reopen(card.id);
        await audit({ kind: 'resume', harness: card.harness, session: card.ref, title: card.title, message: RESUME_MESSAGE, ok: true });
        refresh().catch(() => {});
        return send(res, 200, { ok: true, output: `Resumed. ${HARNESS_NAMES[card.harness]} was told to pick it back up.` });
      } catch (e) {
        await audit({ kind: 'resume', harness: card.harness, session: card.ref, title: card.title, message: RESUME_MESSAGE, ok: false, error: e.message });
        return send(res, 502, { error: `Not resumed: ${e.message}` });
      }
    }
    if (p === '/api/lane' && req.method === 'POST') {
      const { lane, action, confirm } = await readJson(req);
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      // Claude Code / Codex: re-check only (read the agent again); never stops or relaunches a session.
      if (action === 'check' && Object.hasOwn(LANES, lane)) {
        await refresh().catch(() => {});
        const info = getSnapshot().lanes[lane];
        await audit({ kind: 'recheck', harness: lane, message: info?.reason || '', ok: !!info?.connected });
        return send(res, 200, { ok: true, output: `${info?.connected ? 'Connected' : 'Not connected'}. ${info?.reason || ''}` });
      }
      if (action !== 'restart' || !RESTARTABLE.has(lane)) return send(res, 400, { error: 'That agent has no gateway the board can restart.' });
      try {
        const output = await LANES[lane].mod.restartGateway();
        await audit({ kind: 'restart-gateway', harness: lane, message: output, ok: true });
        setTimeout(() => refresh().catch(() => {}), 5000);
        return send(res, 200, { ok: true, output });
      } catch (e) {
        await audit({ kind: 'restart-gateway', harness: lane, ok: false, error: e.message });
        return send(res, 502, { error: `Restart failed: ${e.message}` });
      }
    }
    if (p === '/api/preview' && req.method === 'POST') {
      const { id, link, refresh: again } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      // Only links that are actually on the card can be rendered.
      if (!(card.links || []).includes(link)) return send(res, 400, { error: 'That link is not on this card.' });
      try {
        const meta = (!again && await preview.cached(link)) || await preview.capture(link);
        return send(res, 200, { ...meta, macOnly: preview.macOnly(link) });
      } catch (e) {
        return send(res, 502, { error: `No preview: ${e.message}` });
      }
    }
    if (p === '/api/preview-img' && req.method === 'GET') {
      const file = await preview.imageFile(url.searchParams.get('k') || '', url.searchParams.get('size'));
      if (!file) return send(res, 404, { error: 'No such preview' });
      return sendFile(res, file, 'image/png');
    }
    if (p === '/api/action' && req.method === 'POST') {
      const { id, kind, text, confirm, expectPrompt, expectText, images: imageIds } = await readJson(req);
      const card = findCard(id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      if (!Object.hasOwn(ACTION_TEXT, kind)) return send(res, 400, { error: 'Unknown action' });
      let images;
      try { images = resolveImages(UPLOADS_DIR, imageIds); } catch (e) { return send(res, 400, { error: e.message }); }
      if (images.length && kind === 'approve') return send(res, 400, { error: 'Images go with a reply, not an approval.' });
      if (!card.canReply || typeof LANES[card.harness].mod.send !== 'function') {
        return send(res, 409, { error: card.replyBlockedReason || 'This lane cannot receive replies from the board.' });
      }
      const body = String(text || '').trim();
      if ((kind === 'reply' || kind === 'changes') && !body) return send(res, 400, { error: 'Type a message first.' });
      if (body.length > 8000) return send(res, 400, { error: 'Message too long.' });
      if (confirm !== true) return send(res, 400, { error: 'Not confirmed.' });
      const message = ACTION_TEXT[kind](body);
      const request = card.approvalStyle === 'request';
      const logged = (expectPrompt && kind === 'approve' ? (request ? '[approved the pending request once]' : '[pressed Yes on the approval menu]')
        : expectPrompt && kind === 'changes' ? (request ? `[denied the pending request] ${message}` : `[pressed No on the approval menu] ${body}`) : message)
        + imagesLogged(images);
      try {
        const result = await LANES[card.harness].mod.send(card, { kind, message, images, expectPrompt: !!expectPrompt, expectText: String(expectText || '') });
        await audit({ kind, harness: card.harness, session: card.ref, title: card.title, message: logged, ok: true });
        refresh().catch(() => {});
        return send(res, 200, { ok: true, sent: logged, output: result?.output || '' });
      } catch (e) {
        await audit({ kind, harness: card.harness, session: card.ref, title: card.title, message: logged, ok: false, error: e.message });
        return send(res, 502, { error: `Not sent: ${e.message}` });
      }
    }
    // An image you add to a message (already shrunk by the page). Saved on this computer; the page gets back its id.
    if (p === '/api/upload' && req.method === 'POST') {
      let body;
      try { body = await readJson(req, Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4096); } catch { return send(res, 413, { error: 'That image is too large (8 MB at most).' }); }
      try {
        return send(res, 200, { id: await saveImage(UPLOADS_DIR, body.data) });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    // Start a new chat with one agent (New chat button). Only connected agents and the board's own folders.
    if (p === '/api/new-chat' && req.method === 'POST') {
      const body = await readJson(req);
      const problem = checkNewChat(body, { connected: connectedLanes(), folders: getSnapshot().folders.map((f) => f.path) });
      if (problem) return send(res, 400, { error: problem });
      let images;
      try { images = resolveImages(UPLOADS_DIR, body.images); } catch (e) { return send(res, 400, { error: e.message }); }
      const agent = body.agent;
      const message = body.message.trim();
      const title = chatTitle(message);
      const lane = LANES[agent].mod;
      try {
        const folder = typeof body.folder === 'string' ? body.folder : '';
        const started = await lane.startSession({ title, message, images, cwd: folder });
        await audit({ kind: 'new-chat', harness: agent, session: started.ref || started.target || '', title, message: message + imagesLogged(images), ok: true, folder: body.folder || '' });
        refresh().catch(() => {});
        return send(res, 200, { ok: true, ref: started.ref || '', paneId: started.paneId || '' });
      } catch (e) {
        await audit({ kind: 'new-chat', harness: agent, session: '', title, message: message + imagesLogged(images), ok: false, error: e.message, folder: body.folder || '' });
        return send(res, 502, { error: `Not started: ${e.message}` });
      }
    }

    // Answer a multiple-choice question on a card. The question must still be exactly what you saw.
    if (p === '/api/choose' && req.method === 'POST') {
      const body = await readJson(req);
      const card = findCard(body.id || '');
      if (!card) return send(res, 404, { error: 'Session not on the board any more. Refresh.' });
      const problem = checkChoice(card, body);
      if (problem) return send(res, 409, { error: problem });
      if (!card.canReply) return send(res, 409, { error: card.replyBlockedReason || 'This lane cannot receive answers from the board.' });
      const q = card.question;
      const lane = LANES[card.harness].mod;
      const picks = q.multi ? body.pick : [body.pick];
      const typed = typeof body.text === 'string' ? body.text.trim() : '';
      const logged = q.kind === 'reply' ? replyChoiceMessage(q, body.pick)
        : `[answered “${(q.text || 'the question').split('\n').pop()}”: ${typed ? `typed: ${typed}` : picks.map((i) => q.options[i]).join(', ')}]`;
      try {
        // The board's snapshot can be seconds old: re-read the chat now and send only if the agent's last message is
        // still the question you saw (not answered in the app/terminal, not moved on).
        if (q.kind === 'reply' && !stillAsking(await lane.messages(card, 6), q.expect)) {
          return send(res, 409, { error: 'The agent has moved on since you looked (answered or changed). Nothing was sent. Refresh.' });
        }
        if (q.kind === 'reply') await lane.send(card, { kind: 'reply', message: logged, expectPrompt: false, expectText: '' });
        else if (typeof lane.choose === 'function') await lane.choose(card, { pick: body.pick, text: typed });
        else throw new Error('This agent cannot answer questions from the board.');
        await audit({ kind: 'choose', harness: card.harness, session: card.ref, title: card.title, message: logged, ok: true });
        refresh().catch(() => {});
        return send(res, 200, { ok: true, sent: logged });
      } catch (e) {
        await audit({ kind: 'choose', harness: card.harness, session: card.ref, title: card.title, message: logged, ok: false, error: e.message });
        return send(res, 502, { error: `Not sent: ${e.message}` });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  // Read-only triage summary (plain text, for anyone with the PIN). No actions.
  if ((p === '/triage' || p === '/triage.txt') && req.method === 'GET') {
    if (!authed) return send(res, 401, 'PIN required: open the board once on this device and log in, then come back.');
    const snap = getSnapshot();
    if (p === '/triage.txt') return send(res, 200, triageText(snap));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    return res.end(triageHtml(snap));
  }
  if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');
  const icon = /^\/icons\/(\w+)\.png$/.exec(p);
  if (icon) {
    const file = await iconFile(icon[1]);
    return file ? sendFile(res, file, 'image/png') : send(res, 404, 'no icon');
  }
  return serveStatic(req, res, p);
}

// ---------- listeners ----------
const listeners = new Map(); // address -> server

function listenOn(address) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!e.status) console.error('[http]', e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    });
  });
  server.on('error', (e) => {
    console.error(`[net] could not listen on ${address}:${config.port}: ${e.message}`);
    listeners.delete(address);
    // Without this computer's own address the board is useless, and a second copy would run its own scheduler
    // beside the first (planned Continues sent twice). Usually AgentHub is already running (the service).
    if (address === '127.0.0.1') {
      console.error(`[net] Port ${config.port} is taken: AgentHub is probably running already. Stopping this copy.`);
      process.exit(1);
    }
  });
  server.listen(config.port, address);
  listeners.set(address, server);
}

function reconcileListeners() {
  const wanted = wantedAddresses();
  for (const [addr, kind] of wanted) {
    if (!listeners.has(addr)) {
      listenOn(addr);
      console.log(`[net] listening on http://${addr}:${config.port}  (${kind})`);
    }
  }
  for (const [addr, server] of listeners) {
    if (!wanted.has(addr)) {
      server.close();
      listeners.delete(addr);
      console.log(`[net] address ${addr} went away; stopped listening on it`);
    }
  }
}

reconcileListeners();
setInterval(reconcileListeners, 30000);
await readTailscale();
setInterval(readTailscale, 5 * 60000);

const addrs = wantedAddresses();
const lan = [...addrs].find(([, k]) => k === 'lan')?.[0];
const ts = [...addrs].find(([, k]) => k === 'tailscale')?.[0];
console.log(config.demo ? '\nAgentHub DEMO is running: made-up agents and chats, nothing real is read or changed' : '\nAgentHub is running');
console.log(`  This computer:   http://localhost:${config.port}`);
if (lan) console.log(`  Home WiFi:  http://${lan}:${config.port}`);
if (ts) console.log(`  Tailscale:  http://${ts}:${config.port}${tailscaleDns ? `  or  http://${tailscaleDns}:${config.port}` : ''}`);
if (tailscaleHttpsUrl) console.log(`  Tailscale HTTPS (mic works): ${tailscaleHttpsUrl}`);
console.log(PIN_HASH ? '  Log in with your PIN on every device, this computer included. Forgot it? npm run set-pin'
  : '  No PIN set yet: run  npm run set-pin  on this computer.');
console.log('');

await buildIcons().catch((e) => console.error('[icons]', e.message));
startPolling();

// Planned Continues (lib/schedule.js): every 20 s, send those whose time has come, after reading the agents fresh so
// the board checks each chat as it is right now.
let sendingPlanned = false;
async function sendPlannedContinues() {
  if (sendingPlanned) return; // the last run is still going (a slow read): never two at once
  sendingPlanned = true;
  try { await sendDuePlans(); } finally { sendingPlanned = false; }
}
async function sendDuePlans() {
  if (!(await schedule.anyDue())) return;
  await refresh().catch(() => {});
  const done = await schedule.runDue({
    findCard,
    send: (card) => LANES[card.harness].mod.send(card, { kind: 'reply', message: CONTINUE_MESSAGE, images: [], expectPrompt: false, expectText: '' }),
    log: (plan, card, ok, why) => audit({ kind: 'schedule', harness: card?.harness || plan.harness, session: card?.ref || '', title: plan.title,
      message: ok ? `[planned Continue sent] ${CONTINUE_MESSAGE}` : `[planned Continue not sent] ${why}`, ok }),
  });
  if (done.length) refresh().catch(() => {});
}
setInterval(() => { sendPlannedContinues().catch((e) => console.error('[schedule] failed', e)); }, 20000);
