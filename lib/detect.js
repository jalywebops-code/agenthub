// Detect (step C3): look for each agent on this computer and propose setup values for what it finds. Read-only:
// it only checks that files and folders exist and reads OpenClaw's own config for its port (the page also knocks on
// the local ports to say what is running). It fills in values that are missing or broken and never replaces one that
// works; it never switches on an agent it did not find. Each finding is a proposal you tick before it is saved
// (Settings), except on a brand-new install, where it fills the setup once by itself (lib/setup.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loginShell } from './platform.js';

/** What Detect may look at. The real one looks at this computer; tests pass their own. */
export function detectEnv(home = os.homedir()) {
  const isExecutable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const listDir = (p) => { try { return fs.readdirSync(p); } catch { return []; } };
  return { home, isExecutable, isDir, readJson, listDir, pathDirs: searchDirs(home) };
}

/** Where commands are looked for: the login shell's PATH (launchd's is short), then the usual install places. */
function searchDirs(home) {
  let shellPath = '';
  try {
    shellPath = execFileSync(loginShell(), ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { shellPath = ''; }
  const dirs = [...shellPath.split(':'), ...String(process.env.PATH || '').split(':'), path.join(home, '.npm-global/bin'), path.join(home, '.local/bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  return [...new Set(dirs.filter((d) => d && path.isAbsolute(d)))];
}

const tidy = (abs, home) => (abs.startsWith(home + path.sep) ? `~/${abs.slice(home.length + 1)}` : abs);
const expand = (p, home) => (p === '~' ? home : String(p || '').startsWith('~/') ? path.join(home, p.slice(2)) : String(p || ''));

/** The first place a command is installed, or ''. */
export function findCommand(env, name, extra = []) {
  for (const p of [...extra, ...env.pathDirs.map((d) => path.join(d, name))]) if (env.isExecutable(p)) return p;
  return '';
}

/** Whether a stored command works: a full path to a program, or a bare name found where the board looks. */
export function commandWorks(env, value) {
  const v = String(value || '');
  if (!v) return false;
  if (!v.includes('/') && !v.startsWith('~')) return !!findCommand(env, v);
  return env.isExecutable(expand(v, env.home));
}

/**
 * Findings for `setup`: [{ id, agent, label, found, detail, change, suggested }]. `change` is the setup change that
 * proposal makes (the shape lib/setup.js applyChanges takes); `suggested` says whether it starts ticked.
 */
export function detect(setup, env = detectEnv()) {
  const { home } = env;
  const out = [];
  const add = (item) => out.push({ suggested: true, change: null, ...item });
  const onOff = (agent, label, found, current) => {
    if (!found && current !== false) add({ id: `${agent}:off`, agent, label: `Switch ${label} off`, found, detail: `${label} isn't installed here.`, change: { agents: { [agent]: { enabled: false } } } });
    if (found && current === false) add({ id: `${agent}:on`, agent, label: `Switch ${label} on`, found, detail: `${label} is installed but switched off.`, change: { agents: { [agent]: { enabled: true } } }, suggested: false });
  };

  // Hermes: its launcher (the board reads its Python from it) and its dashboard on 9119.
  const h = setup.agents.hermes;
  const hermesLauncher = [expand(h.launcher, home), path.join(home, '.hermes/hermes-agent/.hermes/bin/hermes')].find((p) => env.isExecutable(p)) || '';
  const hermesFound = !!hermesLauncher || env.isDir(path.join(home, '.hermes'));
  if (hermesLauncher && !env.isExecutable(expand(h.launcher, home))) {
    add({ id: 'hermes:launcher', agent: 'hermes', label: 'Hermes launcher', found: true, detail: tidy(hermesLauncher, home), change: { agents: { hermes: { launcher: tidy(hermesLauncher, home) } } } });
  }
  const kanban = path.join(home, '.hermes/kanban/boards');
  if (env.isDir(kanban) && !env.isDir(expand(h.kanbanRoot, home))) {
    add({ id: 'hermes:kanban', agent: 'hermes', label: 'Hermes kanban folder', found: true, detail: tidy(kanban, home), change: { agents: { hermes: { kanbanRoot: tidy(kanban, home) } } } });
  }
  onOff('hermes', 'Hermes', hermesFound, h.enabled);

  // OpenClaw: its command and the gateway port from its own config (18789 when it sets none).
  const o = setup.agents.openclaw;
  const ocBin = commandWorks(env, o.bin) ? expand(o.bin, home) : findCommand(env, 'openclaw', [path.join(home, '.openclaw/bin/openclaw')]);
  if (ocBin && !commandWorks(env, o.bin)) {
    add({ id: 'openclaw:bin', agent: 'openclaw', label: 'OpenClaw command', found: true, detail: tidy(ocBin, home), change: { agents: { openclaw: { bin: tidy(ocBin, home) } } } });
  }
  const ocPort = Number(env.readJson(path.join(home, '.openclaw/openclaw.json'))?.gateway?.port) || 18789;
  if (ocBin && Number(o.port) !== ocPort) {
    add({ id: 'openclaw:port', agent: 'openclaw', label: 'OpenClaw gateway port', found: true, detail: `${ocPort} (from OpenClaw's own settings)`, change: { agents: { openclaw: { port: ocPort } } } });
  }
  onOff('openclaw', 'OpenClaw', !!ocBin, o.enabled);

  // Codex: its command and its sessions folder.
  const c = setup.agents.codex;
  const codexBin = commandWorks(env, c.command) ? c.command : findCommand(env, 'codex');
  if (codexBin && !commandWorks(env, c.command)) {
    const value = findCommand(env, 'codex') ? 'codex' : tidy(codexBin, home);
    add({ id: 'codex:command', agent: 'codex', label: 'Codex command', found: true, detail: value, change: { agents: { codex: { command: value } } } });
  }
  const sessions = path.join(home, '.codex/sessions');
  if (env.isDir(sessions) && !env.isDir(expand(c.sessionsDir, home))) {
    add({ id: 'codex:sessions', agent: 'codex', label: 'Codex sessions folder', found: true, detail: tidy(sessions, home), change: { agents: { codex: { sessionsDir: tidy(sessions, home) } } } });
  }
  onOff('codex', 'Codex', !!codexBin, c.enabled);

  // Claude Code: fix an account whose command is missing; offer other Claude folders that hold chats as new accounts
  // (not ticked: a folder may belong to something else, e.g. a read-only workspace).
  const claudeBin = findCommand(env, 'claude', [path.join(home, '.claude/local/claude')]);
  for (const a of setup.agents.claude) {
    if (!commandWorks(env, a.command) && claudeBin) {
      add({ id: `claude:${a.id}:command`, agent: a.id, label: `${a.label || a.id}: command`, found: true, detail: tidy(claudeBin, home), change: { agents: { claude: [{ id: a.id, command: tidy(claudeBin, home) }] } } });
    }
  }
  const known = new Set(setup.agents.claude.flatMap((a) => [expand(a.configDir, home), ...(a.readOnly || []).map((r) => expand(r.dir, home))]));
  const folders = env.listDir(home).filter((n) => /^\.claude(-[A-Za-z0-9._-]+)?$/.test(n)).map((n) => path.join(home, n));
  for (const dir of folders) {
    if (known.has(dir) || !env.isDir(path.join(dir, 'projects')) || !claudeBin) continue;
    const name = path.basename(dir).replace(/^\.claude-?/, '') || 'main';
    add({ id: `claude:add:${path.basename(dir)}`, agent: 'claude', label: `Add a Claude account for ${tidy(dir, home)}`, found: true,
      detail: `A Claude folder with chats. Add it only if it is one of your accounts (signed in with its own login).`, suggested: false,
      change: { agents: { addClaude: [{ label: `Claude ${name}`, command: tidy(claudeBin, home), configDir: tidy(dir, home) }] } } });
  }
  return out;
}

/** One setup change made of the ticked findings (fields of one agent merge; Claude accounts and new ones add up). */
export function mergeChanges(items) {
  const out = { agents: {} };
  for (const { change } of items) {
    for (const [key, v] of Object.entries(change?.agents || {})) {
      if (key === 'claude' || key === 'addClaude') out.agents[key] = [...(out.agents[key] || []), ...v];
      else out.agents[key] = { ...(out.agents[key] || {}), ...v };
    }
  }
  // Several changes to one account become one entry.
  if (out.agents.claude) {
    const byId = new Map();
    for (const a of out.agents.claude) byId.set(a.id, { ...(byId.get(a.id) || {}), ...a });
    out.agents.claude = [...byId.values()];
  }
  return out;
}
