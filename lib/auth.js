// Board access: the PIN is kept only as a salted hash, and anything that acts must come from the board page itself
// (same origin + a per-login token the page sends), so a script on this computer can't drive the board by calling the API.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeFileAtomicSync } from './atomic.js';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

/** "scrypt$<salt hex>$<hash hex>" for a PIN; the PIN itself is never stored. */
export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, KEYLEN, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function isHashed(stored) {
  return /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(String(stored || ''));
}

/** True when `pin` matches the stored hash (constant-time compare). */
export function verifyPin(pin, stored) {
  if (!pin || !isHashed(stored)) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), KEYLEN, SCRYPT);
  return crypto.timingSafeEqual(want, got);
}

/**
 * The token the board page sends with every action, bound to its own login cookie. Handed out only in the login (or
 * PIN change) answer and kept in the page's own storage, never in a cookie, so a cookie that leaks elsewhere can't act.
 */
export function actionToken(cookie, secret) {
  return crypto.createHmac('sha256', secret).update(`action.${cookie}`).digest('hex');
}

/**
 * The login cookie's name, one per port. Browsers share cookies across ports of the same host but keep page storage
 * (where the token lives) per port, so one shared cookie let a login on :4400 replace the cookie :4443's token was
 * bound to, and every action asked for the PIN again. Separate names keep each address's login and token together.
 */
export function cookieName(host) {
  const port = /:(\d{1,5})$/.exec(String(host || ''))?.[1];
  return `agenthub_auth_${port || 'default'}`;
}

const ACTION_REFUSED = 'Actions only work from the board page. Reload the board and try again.';

/**
 * Why a request that would act can't (a message), or null. Actions are POSTs to /api/ other than login; they need an
 * Origin header that matches the host (browsers always send one on fetch POSTs) and the per-login token.
 * `req`: { method, path, origin, host, cookie, token }.
 */
export function checkAction(req, secret) {
  if (req.method !== 'POST' || !req.path.startsWith('/api/') || req.path === '/api/login') return null;
  let originHost = '';
  try { originHost = req.origin ? new URL(req.origin).host : ''; } catch { originHost = ''; }
  if (!originHost || originHost !== req.host) return ACTION_REFUSED;
  if (!req.cookie || !req.token) return ACTION_REFUSED;
  const want = Buffer.from(actionToken(req.cookie, secret));
  const got = Buffer.from(String(req.token));
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? null : ACTION_REFUSED;
}

/** A new PIN: 8 to 12 digits (a 6-digit PIN can be guessed at the board-wide rate limit in months). */
export function validPin(pin) {
  return /^\d{8,12}$/.test(String(pin || ''));
}

const isLoopbackAddr = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

/**
 * Which wrong-PIN counters a login attempt counts against: its own client, plus a shared allowance. Everything that
 * arrives over loopback (this computer, and phones coming through `tailscale serve`, whose forwarding header any local
 * program could fake) shares the 'loopback' allowance; real network connections (the Tailscale address) share
 * 'network', which nothing on this computer can use up.
 */
export function failureKeys({ peer, forwarded }) {
  if (isLoopbackAddr(peer)) {
    const last = String(forwarded || '').split(',').map((s) => s.trim()).filter(Boolean).pop();
    return [`client:${last || peer}`, 'shared:loopback'];
  }
  return [`client:${peer}`, 'shared:network'];
}

/**
 * A PIN change: the current PIN must match; the new one must be 8-12 digits. Returns the new hash and a new signing
 * secret (which signs out every other device), or { error } and changes nothing.
 */
export function changePin({ current, next, pinHash }) {
  if (!verifyPin(String(current || ''), pinHash)) return { error: 'That is not the current PIN. Nothing changed.' };
  if (!validPin(next)) return { error: 'A new PIN is 8 to 12 digits.' };
  return { pinHash: hashPin(String(next)), secret: crypto.randomBytes(32).toString('hex') };
}

/** Wrong-PIN counters on disk, so restarting the board doesn't reset them. */
export function saveFailures(file, failures) {
  try {
    writeFileAtomicSync(file, JSON.stringify(Object.fromEntries(failures)));
  } catch { /* best effort: counting still works in memory */ }
}

/** Saved counters, keeping only attempts inside the window. */
export function loadFailures(file, now, windowMs) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map(Object.entries(data)
      .map(([k, list]) => [k, (Array.isArray(list) ? list : []).filter((t) => typeof t === 'number' && now - t < windowMs)])
      .filter(([, list]) => list.length));
  } catch {
    return new Map();
  }
}
