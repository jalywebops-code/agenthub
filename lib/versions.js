// Agent versions for Settings. Read-only: only `--version` and OpenClaw's own `update status` ever run (never an
// update, and nothing at all that updates Codex). Commands run through a login shell so PATH matches Terminal.
import { config } from './config.js';
import { run } from './util.js';
import { loginShell } from './platform.js';
import { CLAUDE_IDS } from './names.js';

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The exact commands run per agent (fixed strings; nothing from a request ever goes in). */
export const VERSION_COMMANDS = {
  hermes: ['hermes --version'],
  openclaw: [`${sh(config.openclaw.bin)} --version`, `${sh(config.openclaw.bin)} update status --json`],
  // One `--version` per Claude Code account, through that account's own command.
  ...Object.fromEntries(config.claudeAccounts.map((a) => [a.id, [`${sh(a.bin)} --version`]])),
  codex: [`${sh(config.codex.bin)} --version`],
};

/** What Settings shows for an agent, from its command output(s). updateAvailable: true / false / null (unknown). */
export function parseVersion(agent, outputs) {
  const first = String(outputs[0] || '');
  if (agent === 'hermes') {
    return { version: /Hermes Agent v([\w.-]+)/.exec(first)?.[1] || '', updateAvailable: /Update available/i.test(first), updateCommand: 'hermes update', note: '' };
  }
  if (agent === 'openclaw') {
    let status = {};
    try { status = JSON.parse(outputs[1] || '{}'); } catch { status = {}; }
    const available = status.availability?.available;
    return { version: /OpenClaw ([\w.-]+)/.exec(first)?.[1] || '', updateAvailable: typeof available === 'boolean' ? available : null,
      updateCommand: 'openclaw update', note: status.update?.installOwner?.updateHint || '' };
  }
  if (CLAUDE_IDS.has(agent)) {
    return { version: /^\s*([\d.]+)/.exec(first)?.[1] || '', updateAvailable: null, updateCommand: 'claude update', note: '' };
  }
  return { version: /codex-cli ([\w.-]+)/.exec(first)?.[1] || '', updateAvailable: null, updateCommand: '',
    note: 'Update Codex yourself in Terminal; the board never updates it.' };
}

let cache = { at: 0, data: null };

/** Versions of all four agents (cached 30 min; each command has a 20 s limit; a failure shows as unknown). */
export async function versions({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < 30 * 60000) return cache.data;
  const out = {};
  await Promise.all(Object.entries(VERSION_COMMANDS).map(async ([agent, cmds]) => {
    try {
      const outputs = await Promise.all(cmds.map((c) => run(loginShell(), ['-lc', c], { timeoutMs: 20000 }).catch((e) => '')));
      out[agent] = parseVersion(agent, outputs);
    } catch (e) {
      out[agent] = { version: '', updateAvailable: null, updateCommand: '', note: `Could not read the version: ${e.message}` };
    }
  }));
  cache = { at: Date.now(), data: out };
  return out;
}
