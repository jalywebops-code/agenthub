// What differs between macOS and Linux (step F), in one place: how to list processes and read a process's environment
// and open files, which shell is the login shell, which network interfaces are the home network, where Chrome is.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run } from './util.js';

export const IS_MAC = process.platform === 'darwin';

/** The user's login shell (for commands that need the same PATH as a terminal). */
export function loginShell() {
  return process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/sh');
}

/**
 * `ps` output → Map(pid → { ppid, comm, args }). macOS: `pid ppid comm` (comm is the full path and may hold spaces).
 * Linux: `pid ppid comm args` (comm is at most 15 characters and has no spaces; args is the whole command line).
 */
export function parsePs(text, mac = IS_MAC) {
  const procs = new Map();
  for (const line of String(text).split('\n')) {
    const m = mac ? line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/) : line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3], args: mac ? '' : m[4] });
  }
  return procs;
}

/** Every process: Map(pid → { ppid, comm, args }). */
export async function processTable() {
  const out = IS_MAC
    ? await run('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { timeoutMs: 5000 })
    : await run('ps', ['-eo', 'pid=,ppid=,comm=,args='], { timeoutMs: 5000 });
  return parsePs(out);
}

/**
 * The names a process goes by: its own name, and on Linux also the program in its command line (a Node program such
 * as Claude Code installed with npm can show up as "node" with the program as its first argument).
 */
export function namesOf(proc) {
  const names = [path.basename(proc.comm)];
  for (const word of String(proc.args || '').split(/\s+/).slice(0, 2)) if (word) names.push(path.basename(word));
  return names;
}

/** One variable from a process's environment ('' when unset or unreadable; only your own processes). */
export async function envVarOf(pid, name) {
  if (!IS_MAC) {
    try { return environValue(await fsp.readFile(`/proc/${pid}/environ`, 'latin1'), name); } catch { return ''; }
  }
  const out = await run('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)], { timeoutMs: 5000 });
  const m = new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(out);
  return m ? m[1] : '';
}

/** A variable from the NUL-separated contents of /proc/<pid>/environ. */
export function environValue(raw, name) {
  for (const entry of String(raw).split('\0')) if (entry.startsWith(`${name}=`)) return entry.slice(name.length + 1);
  return '';
}

/** The files a process has open (its own user only; [] when they can't be read). */
export async function openFiles(pid) {
  if (!IS_MAC) {
    const dir = `/proc/${pid}/fd`;
    const fds = await fsp.readdir(dir).catch(() => []);
    const out = await Promise.all(fds.map((fd) => fsp.readlink(path.join(dir, fd)).catch(() => '')));
    return out.filter((f) => f.startsWith('/'));
  }
  try {
    const out = await run('/usr/sbin/lsof', ['-p', String(pid), '-Fn'], { timeoutMs: 5000 });
    return out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
  } catch { return []; }
}

/** A network interface that is the home network (Wi-Fi or cable): en0 on a Mac; eth0, enp3s0, wlan0, wlp2s0 on Linux. */
export function isHomeInterface(name, mac = IS_MAC) {
  return mac ? /^en\d/.test(name) : /^(eth|en|wl)[a-z0-9]*$/i.test(name);
}

const CHROMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/**
 * Chrome or Chromium for link previews: the configured one when it exists, else (on Linux) the first of the usual names
 * on the PATH. '' when there is none: previews then say so instead of failing.
 */
export function findChrome(configured, pathDirs = String(process.env.PATH || '').split(':')) {
  const ok = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
  if (configured && ok(configured)) return configured;
  for (const dir of [...pathDirs, '/usr/bin', '/usr/local/bin', '/snap/bin']) {
    for (const name of CHROMES) if (dir && ok(path.join(dir, name))) return path.join(dir, name);
  }
  return '';
}
