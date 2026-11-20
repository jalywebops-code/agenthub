// Plan usage per agent: how much of the current session (5-hour) and week windows each Claude Code
// account and Codex have used, for the draining ring on their agent buttons.
//
// Codex writes its limits into its own session logs after every turn ("rate_limits"), so that is read from disk.
// Claude Code's numbers come from the same place its /usage screen gets them: Anthropic's usage endpoint, asked with
// the account's own sign-in, which Claude Code keeps in the macOS Keychain (or ~/.claude*/.credentials.json on Linux).
// That endpoint is not a published API and may change; when it fails the ring just isn't drawn.
//
// The sign-in is only ever sent to Anthropic, never logged, stored or passed to the page. The board never renews
// it (that could sign Claude Code out): an expired sign-in means no reading until Claude Code runs again.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, tailLines, parseJsonLines } from './util.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** The Keychain item Claude Code keeps an account's sign-in in: its own name for ~/.claude, else a hash of the folder. */
export function keychainService(configDir, home = os.homedir()) {
  const dir = path.resolve(configDir);
  if (dir === path.join(home, '.claude')) return 'Claude Code-credentials';
  return `Claude Code-credentials-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
}

/** One usage window for the page: { name, used (0-100), resetsAt (ms, 0 unknown) }; a window past its reset is fresh. */
function windowOf(name, used, resetsAt, now) {
  const reset = resetsAt || 0;
  return { name, used: reset && reset <= now ? 0 : Math.max(0, Math.min(100, Math.round(Number(used) || 0))), resetsAt: reset };
}

/** Claude's usage reply → windows: the 5-hour session and the week (all models). */
export function claudeWindows(body, now = Date.now()) {
  const out = [];
  const ms = (t) => (t ? Date.parse(t) || 0 : 0);
  if (body?.five_hour) out.push(windowOf('Session', body.five_hour.utilization, ms(body.five_hour.resets_at), now));
  if (body?.seven_day) out.push(windowOf('Week', body.seven_day.utilization, ms(body.seven_day.resets_at), now));
  return out;
}

/** Codex's last "rate_limits" record → windows (a window of a few hours is the session, a longer one the week). */
export function codexWindows(limits, now = Date.now()) {
  const out = [];
  for (const w of [limits?.primary, limits?.secondary]) {
    if (!w || w.used_percent == null) continue;
    out.push(windowOf((w.window_minutes || 0) <= 12 * 60 ? 'Session' : 'Week', w.used_percent, w.resets_at ? w.resets_at * 1000 : 0, now));
  }
  return out.sort((a, b) => (a.name === 'Session' ? -1 : 1) - (b.name === 'Session' ? -1 : 1));
}

/** The account's sign-in token, or '' when there is none or it has expired. */
async function claudeToken(configDir) {
  let raw = '';
  if (process.platform === 'darwin') {
    try { raw = await run('/usr/bin/security', ['find-generic-password', '-s', keychainService(configDir), '-w'], { timeoutMs: 8000 }); } catch { raw = ''; }
  }
  if (!raw) raw = await fs.readFile(path.join(configDir, '.credentials.json'), 'utf8').catch(() => '');
  let creds;
  try { creds = JSON.parse(raw).claudeAiOauth; } catch { return { token: '', why: 'no Claude sign-in found for this account' }; }
  if (!creds?.accessToken) return { token: '', why: 'no Claude sign-in found for this account' };
  if (creds.expiresAt && creds.expiresAt <= Date.now() + 60000) return { token: '', why: 'its sign-in has expired; Claude Code renews it when it next runs' };
  return { token: creds.accessToken, why: '' };
}

/** A Claude account's usage: { windows, why } (why says why there are no windows). */
export async function claudeUsage(configDir) {
  const { token, why } = await claudeToken(configDir);
  if (!token) return { windows: [], why };
  try {
    const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { windows: [], why: `Anthropic answered ${res.status}` };
    return { windows: claudeWindows(await res.json()), why: '' };
  } catch (e) {
    return { windows: [], why: `could not reach Anthropic (${e.name === 'TimeoutError' ? 'timed out' : e.message})` };
  }
}

/** Codex's usage, from the newest session log that recorded its limits. */
export async function codexUsage(sessionsDir) {
  const files = [];
  for (let i = 0; i < 8 && files.length < 5; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dir = path.join(sessionsDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    const names = await fs.readdir(dir).catch(() => []);
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const st = await fs.stat(path.join(dir, n)).catch(() => null);
      if (st) files.push({ file: path.join(dir, n), mtime: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, 5)) {
    const entries = parseJsonLines(await tailLines(f.file, 300_000).catch(() => []));
    for (let i = entries.length - 1; i >= 0; i--) {
      const limits = entries[i]?.payload?.rate_limits || entries[i]?.rate_limits;
      if (limits) return { windows: codexWindows(limits), why: '' };
    }
  }
  return { windows: [], why: 'Codex has not recorded its limits yet (it does after a turn)' };
}
