// Link previews: when a card links to a web page or a local .html build, take a screenshot of it
// with headless Chrome on this computer (a fresh empty profile per capture, never your browser profile).
// Only on your tap, only links that are on the card, and never machines on your private network.
// Screenshots are cached per link in .data/previews and only retaken when you ask.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { run } from './util.js';
import { IS_MAC } from './platform.js';

const DIR = path.join(config.dataDir, 'previews');
const HOME = os.homedir();
const MAX_LINKS = 3;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`\\]+/g;
// Absolute or ~ paths to a local HTML file, e.g. ~/projects/site/dist/index.html
// The path may follow a space, bracket, quote, or a label's colon or equals sign (Hermes writes "MEDIA:/Users/you/…").
const FILE_RE = /(?:^|[\s(`'":=])((?:~|\/Users\/[^\s/]+)\/[^\s`'"()<>]*?\.html?)(?=$|[\s)`'".,;:!?])/g;

function tidy(url) {
  return url.replace(/[.,;:!?'")\]}>*_]+$/, '');
}

/** Up to three distinct web links or local .html paths found in the text, newest text first. */
export function findLinks(...texts) {
  const out = [];
  const add = (v) => { if (v && !out.includes(v) && out.length < MAX_LINKS) out.push(v); };
  for (const text of texts) {
    const t = String(text || '');
    for (const m of t.matchAll(URL_RE)) add(tidy(m[0]));
    for (const m of t.matchAll(FILE_RE)) add(m[1].replace(/^~(?=\/)/, HOME));
  }
  return out;
}

// ---------- which addresses a preview may reach ----------
// Loopback (this computer) is allowed: previewing a dev server an agent just started on localhost is the main use.
// IPv4 and IPv6 rules live in separate lists: Node's BlockList also tests an IPv4 address against IPv6 rules
// in its ::ffff: form, so one mixed list would let a ::ffff:0:0/96 rule block every IPv4 site.
const LOOPBACK4 = new net.BlockList();
LOOPBACK4.addSubnet('127.0.0.0', 8, 'ipv4');
const LOOPBACK6 = new net.BlockList();
LOOPBACK6.addAddress('::1', 'ipv6');
LOOPBACK6.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
// Everything that is not the public internet: home network, Tailscale peers, link-local (169.254.169.254),
// multicast; for IPv6 also every form that can carry an IPv4 address (mapped, compatible, NAT64, 6to4),
// which are refused outright rather than decoded.
const PRIVATE4 = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) PRIVATE4.addSubnet(addr, bits, 'ipv4');
const PRIVATE6 = new net.BlockList();
for (const [addr, bits] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE6.addSubnet(addr, bits, 'ipv6');

function blockedAddress(ip) {
  if (net.isIPv4(ip)) return !LOOPBACK4.check(ip, 'ipv4') && PRIVATE4.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return !LOOPBACK6.check(ip, 'ipv6') && PRIVATE6.check(ip, 'ipv6');
  return true;
}

/** Resolve a host and return one address to connect to, or throw if any of its addresses is private. */
async function allowedAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`could not find ${host}`);
  if (addrs.some((a) => blockedAddress(a.address))) throw new Error(`${host} is on your private network; previews only open public sites and this computer`);
  return addrs[0].address;
}

/**
 * A one-capture proxy that every Chrome request goes through. It checks the address of EVERY connection
 * (redirects and anything the page loads, not just the first URL) and connects to the exact address it
 * checked, so a DNS answer can't change between the check and the connection.
 */
function startFilterProxy() {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url);
      if (u.protocol !== 'http:') throw new Error('unsupported');
      const ip = await allowedAddress(u.hostname);
      const headers = { ...req.headers, host: u.host };
      delete headers['proxy-connection'];
      const up = http.request({ host: ip, port: Number(u.port) || 80, method: req.method, path: `${u.pathname}${u.search}`, headers }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.destroy());
      req.pipe(up);
    } catch {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Blocked by AgentHub preview');
    }
  });
  server.on('connect', async (req, sock, head) => {
    sock.on('error', () => {});
    try {
      const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || '');
      if (!m) throw new Error('bad target');
      const ip = await allowedAddress(m[1]);
      const up = net.connect(Number(m[2]), ip, () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up.write(head);
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
      sock.on('close', () => up.destroy());
    } catch {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** What Chrome should open for a link: the URL itself, or a file:// URL for a local file under your home folder. */
async function target(link) {
  if (/^https?:\/\//.test(link)) {
    const u = new URL(link);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only web links can be previewed');
    await allowedAddress(u.hostname); // early, readable refusal; the proxy enforces it again per connection
    return u.href;
  }
  const file = path.resolve(link);
  if (!file.startsWith(HOME + path.sep) || !/\.html?$/i.test(file)) throw new Error('only .html files in your home folder can be previewed');
  await fs.access(file).catch(() => { throw new Error('that file does not exist on this computer'); });
  return pathToFileURL(file).href;
}

export const keyFor = (link) => crypto.createHash('sha1').update(link).digest('hex');
const files = (key) => ({ full: path.join(DIR, `${key}.png`), thumb: path.join(DIR, `${key}.thumb.png`), meta: path.join(DIR, `${key}.json`) });

/** Cached preview info for a link, or null. */
export async function cached(link) {
  try { return JSON.parse(await fs.readFile(files(keyFor(link)).meta, 'utf8')); } catch { return null; }
}

let queue = Promise.resolve();

/** Screenshot a link (one at a time). Returns { key, link, takenAt }. */
export function capture(link) {
  const job = queue.then(() => shoot(link));
  queue = job.catch(() => {});
  return job;
}

async function shoot(link) {
  if (!config.preview.chrome) throw new Error('Link previews need Google Chrome or Chromium on this computer.');
  const url = await target(link);
  await fs.mkdir(DIR, { recursive: true });
  const key = keyFor(link);
  const f = files(key);
  await fs.rm(f.full, { force: true });
  // A fresh, empty Chrome profile for every capture: no cookies or logins carry from one page to the next.
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'agenthub-preview-'));
  const proxy = await startFilterProxy();
  try {
    await run(config.preview.chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', `--user-data-dir=${profile}`,
      // All web traffic through the filter proxy; no QUIC or WebRTC side channels around it.
      `--proxy-server=http://127.0.0.1:${proxy.address().port}`, '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      `--window-size=${config.preview.width},${config.preview.height}`,
      '--virtual-time-budget=8000', `--screenshot=${f.full}`, url,
    ], { timeoutMs: config.preview.timeoutMs });
  } catch (e) {
    // Chrome sometimes exits non-zero after writing the screenshot; only fail if there is none.
    if (!(await fs.stat(f.full).catch(() => null))) throw new Error(`could not render the page: ${e.message}`);
  } finally {
    proxy.close();
    await fs.rm(profile, { recursive: true, force: true }); // the throwaway profile made just above
  }
  // The small copy for the card: macOS shrinks it with sips; elsewhere the page scales the full screenshot down.
  if (IS_MAC) await run('/usr/bin/sips', ['-Z', '480', f.full, '--out', f.thumb], { timeoutMs: 15000 });
  else await fs.copyFile(f.full, f.thumb);
  const meta = { key, link, takenAt: Date.now() };
  await fs.writeFile(f.meta, JSON.stringify(meta));
  return meta;
}

/** Path of a stored screenshot by key ('thumb' or 'full'), or '' if missing. */
export async function imageFile(key, size) {
  if (!/^[0-9a-f]{40}$/.test(key)) return '';
  const file = size === 'full' ? files(key).full : files(key).thumb;
  try { await fs.access(file); return file; } catch { return ''; }
}

/** True for links only this computer can open (localhost and local files). */
export function macOnly(link) {
  if (!/^https?:\/\//.test(link)) return true;
  try {
    const h = new URL(link).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]' || h.endsWith('.local');
  } catch { return true; }
}
