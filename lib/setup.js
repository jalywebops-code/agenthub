// Each install's own setup: which agents it reads, where their programs and folders are, how chats group into
// projects. Kept in this install's .data/setup.json (never committed); nothing here names a person or a machine.
// Paths may start with ~ (the user's home folder) and stay that way in the file; expandHome turns them into real paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomicSync } from './atomic.js';

/** `~` or `~/…` → the home folder; anything else unchanged. */
export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** A fresh install's setup: each agent at its standard install location, one Claude Code account, no project groups. */
export function defaultSetup() {
  return {
    version: 1,
    agents: {
      hermes: {
        enabled: true,
        dashboardUrl: 'http://127.0.0.1:9119',
        launcher: '~/.hermes/hermes-agent/.hermes/bin/hermes',
        kanbanRoot: '~/.hermes/kanban/boards',
      },
      openclaw: { enabled: true, bin: '~/.openclaw/bin/openclaw', port: 18789 },
      codex: { enabled: true, command: 'codex', sessionsDir: '~/.codex/sessions' },
      // One entry per Claude Code account, in board order. `readOnly`: extra session folders shown but never acted on.
      claude: [{ id: 'claude', label: 'Claude Code', command: '~/.local/bin/claude', configDir: '~/.claude', readOnly: [] }],
    },
    projects: { root: '~/projects', groups: [], ignore: [] },
    // Suggested replies: written by `agent` ('' = the chat's own Claude account, else the first one) with `model`.
    suggest: { agent: '', model: 'sonnet' },
    // The plan-usage rings on Claude and Codex buttons (lib/usage.js).
    usage: { rings: true },
    access: { homeWifi: false, extraAddresses: [] },
    preview: { chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    // The agents' official marks, read from their desktop apps when installed (plain icons otherwise).
    icons: {
      hermes: '/Applications/Hermes.app/Contents/Resources/icon.icns',
      openclaw: '/Applications/OpenClaw.app/Contents/Resources/OpenClaw.icns',
      claude: '/Applications/Claude.app/Contents/Resources/electron.icns',
      codex: '/Applications/ChatGPT.app/Contents/Resources/icon-codex-dark-color.png',
    },
  };
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The saved setup with every missing part taken from the defaults (one level deep; a Claude account list replaces). */
function fillDefaults(saved) {
  const d = defaultSetup();
  const s = isObject(saved) ? saved : {};
  const a = isObject(s.agents) ? s.agents : {};
  return {
    ...d,
    ...s,
    agents: {
      hermes: { ...d.agents.hermes, ...(isObject(a.hermes) ? a.hermes : {}) },
      openclaw: { ...d.agents.openclaw, ...(isObject(a.openclaw) ? a.openclaw : {}) },
      codex: { ...d.agents.codex, ...(isObject(a.codex) ? a.codex : {}) },
      claude: Array.isArray(a.claude) && a.claude.length
        ? a.claude.map((c) => ({ readOnly: [], ...c }))
        : d.agents.claude,
    },
    projects: { ...d.projects, ...(isObject(s.projects) ? s.projects : {}) },
    suggest: { ...d.suggest, ...(isObject(s.suggest) ? s.suggest : {}) },
    usage: { ...d.usage, ...(isObject(s.usage) ? s.usage : {}) },
    // The welcome (first-run guide): a setup made before it existed counts as welcomed.
    welcome: { done: true, ...(isObject(s.welcome) ? s.welcome : {}) },
    access: { ...d.access, ...(isObject(s.access) ? s.access : {}) },
    preview: { ...d.preview, ...(isObject(s.preview) ? s.preview : {}) },
    icons: { ...d.icons, ...(isObject(s.icons) ? s.icons : {}) },
  };
}

/** Write the setup (mode 600). */
export function writeSetup(file, setup) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomicSync(file, `${JSON.stringify(setup, null, 2)}\n`);
  fs.chmodSync(file, 0o600);
}

/**
 * This install's setup from `file` (.data/setup.json). When it doesn't exist yet it is made once: from `seedFile`
 * if there is one (an owner's own starting point, never committed), else from the defaults, passed through
 * `onCreate` (the board runs Detect there, so a fresh install finds its agents). A file that can't be read is an
 * error, never silently replaced, so a typo can't wipe someone's setup.
 */
export function loadSetup(file, seedFile, { onCreate } = {}) {
  if (fs.existsSync(file)) {
    try {
      return fillDefaults(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      throw new Error(`Could not read ${file}: ${e.message}. Fix it or move it aside; AgentHub will not overwrite it.`);
    }
  }
  let seed = null;
  if (seedFile && fs.existsSync(seedFile)) seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  let setup = fillDefaults(seed || {});
  if (!seed && onCreate) setup = onCreate(setup);
  setup.welcome = { done: false }; // a brand-new install opens with the welcome
  writeSetup(file, setup);
  return setup;
}

// ---------- changes from Settings (step C) ----------
// What a change may check on disk. The real ones look at this computer; tests pass their own.
export function diskChecks(home = os.homedir()) {
  const isExecutable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  // Where a bare command name is looked for: this process's PATH plus the usual install places (launchd's PATH is short).
  const dirs = [...String(process.env.PATH || '').split(':'), path.join(home, '.npm-global/bin'), path.join(home, '.local/bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean);
  const findOnPath = (name) => dirs.some((d) => isExecutable(path.join(d, name)));
  // This computer's own network addresses right now (IPv4, not loopback).
  const addresses = () => Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  return { home, isExecutable, isDir, findOnPath, addresses };
}

// Fields only someone at the computer may change (program paths, folders, ports), per agent.
const PATH_FIELDS = { hermes: ['dashboardUrl', 'launcher', 'kanbanRoot'], openclaw: ['bin', 'port'], codex: ['command', 'sessionsDir'] };
const CLAUDE_FIELDS = ['label', 'command', 'configDir', 'folderArg', 'tag', 'accent'];
export const ACCENTS = ['', 'green-purple', 'blue-yellow'];
const RESERVED_IDS = new Set(['hermes', 'openclaw', 'codex', 'all', 'claude-all']);

/** Path checks for one field. Each returns { value } (what is stored: `~/…` when inside home) or { error }. */
function pathRules(checks) {
  const { home } = checks;
  const expand = (v) => (v === '~' ? home : v.startsWith('~/') ? path.join(home, v.slice(2)) : v);
  const tidy = (abs) => (abs === home ? '~' : abs.startsWith(home + path.sep) ? `~/${abs.slice(home.length + 1)}` : abs);
  return {
    command(v, what) {
      const s = String(v ?? '').trim();
      if (!s) return { error: `${what}: give the command.` };
      if (!s.includes('/') && !s.startsWith('~')) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) return { error: `${what}: a command name has only letters, digits, . - _` };
        return checks.findOnPath(s) ? { value: s } : { error: `${what}: "${s}" isn't installed where AgentHub looks. Give its full path.` };
      }
      const abs = path.resolve(expand(s));
      if (!path.isAbsolute(expand(s))) return { error: `${what}: give the full path (starting with / or ~/).` };
      return checks.isExecutable(abs) ? { value: tidy(abs) } : { error: `${what}: there is no program at ${s}.` };
    },
    folder(v, what) {
      const s = String(v ?? '').trim();
      if (!s || !path.isAbsolute(expand(s))) return { error: `${what}: give the full path (starting with / or ~/).` };
      const abs = path.resolve(expand(s));
      if (abs !== home && !abs.startsWith(home + path.sep)) return { error: `${what}: it must be inside your home folder.` };
      return checks.isDir(abs) ? { value: tidy(abs) } : { error: `${what}: there is no folder at ${s}.` };
    },
    port(v, what) {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? { value: n } : { error: `${what}: a port is a number from 1 to 65535.` };
    },
    localUrl(v, what) {
      const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})\/?$/.exec(String(v ?? '').trim());
      return m && +m[2] >= 1 && +m[2] <= 65535 ? { value: `http://${m[1]}:${m[2]}` } : { error: `${what}: it must be on this computer, like http://127.0.0.1:9119.` };
    },
  };
}

/** A new account's id from its label: short, lowercase, not taken (card ids start with it, so it never changes later). */
function newAccountId(label, taken) {
  const base = `claude-${String(label).toLowerCase().replace(/^claude[\s·-]*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'account'}`;
  let id = base;
  for (let i = 2; taken.has(id) || RESERVED_IDS.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** A private-network IPv4 address (10/8, 172.16/12, 192.168/16, or the 100.64/10 range Tailscale and others use). */
export function isPrivateAddress(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(a));
  if (!m || m.slice(1).some((x) => +x > 255)) return false;
  const [x, y] = [+m[1], +m[2]];
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127);
}

/**
 * Settings → Phone access (step C5), this computer only: home Wi-Fi (plain HTTP on the local network: the PIN and
 * login travel unencrypted, so off unless chosen) and extra addresses for another private network (ZeroTier, own
 * WireGuard): each must be a private address this computer has right now; never 0.0.0.0, never a public address.
 */
function accessChanges(input, { local, checks }) {
  if (!isObject(input)) return { error: 'Phone access: expected its settings.' };
  const extra = Object.keys(input).filter((k) => !['homeWifi', 'extraAddresses'].includes(k));
  if (extra.length) return { error: `Phone access: ${extra.join(', ')} can't be changed here.` };
  if (!local) return { error: 'Phone access can only be changed on the computer AgentHub runs on.' };
  const fields = {};
  if (input.homeWifi !== undefined) {
    if (typeof input.homeWifi !== 'boolean') return { error: 'Home Wi-Fi must be on or off.' };
    fields.homeWifi = input.homeWifi;
  }
  if (input.extraAddresses !== undefined) {
    if (!Array.isArray(input.extraAddresses) || input.extraAddresses.length > 8) return { error: 'Extra addresses: up to 8.' };
    const mine = new Set(checks.addresses());
    for (const a of input.extraAddresses) {
      if (!isPrivateAddress(a)) return { error: `${a} isn't a private network address (never a public one, never 0.0.0.0).` };
      if (!mine.has(a)) return { error: `${a} isn't one of this computer's addresses right now.` };
    }
    fields.extraAddresses = [...new Set(input.extraAddresses)];
  }
  return { fields };
}

// A folder or board name inside the projects root or the kanban folder: a plain name, never a path.
const NAME_OK = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 100 && !n.startsWith('.') && !/[/\\\u0000-\u001f]/.test(n);

/**
 * Settings → Projects (step C4): the root folder (this computer only), the groups ({ label, folders, kanbanBoards }:
 * folders shown as one project, in this order) and the folders left out. Groups and the ignore list replace the old
 * ones whole. Returns { fields } or { error }.
 */
function projectChanges(input, { local, rules }) {
  if (!isObject(input)) return { error: 'Projects: expected its settings.' };
  const extra = Object.keys(input).filter((k) => !['root', 'groups', 'ignore'].includes(k));
  if (extra.length) return { error: `Projects: ${extra.join(', ')} can't be changed here.` };
  const fields = {};
  if (input.root !== undefined) {
    if (!local) return { error: 'The projects folder can only be changed on the computer AgentHub runs on.' };
    const r = rules.folder(input.root, 'Projects folder');
    if (r.error) return { error: r.error };
    fields.root = r.value;
  }
  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups) || input.groups.length > 100) return { error: 'Projects: up to 100 groups.' };
    const labels = new Set();
    const used = new Set();
    fields.groups = [];
    for (const g of input.groups) {
      if (!isObject(g) || Object.keys(g).some((k) => !['label', 'folders', 'kanbanBoards'].includes(k))) return { error: 'A project group has a name, folders and kanban boards.' };
      const label = String(g.label ?? '').trim();
      if (!label || label.length > 40 || /[<>\u0000-\u001f]/.test(label)) return { error: 'A project name is 1 to 40 characters.' };
      if (labels.has(label.toLowerCase())) return { error: `Two projects are called "${label}".` };
      labels.add(label.toLowerCase());
      const folders = Array.isArray(g.folders) ? g.folders : [];
      const boards = g.kanbanBoards === undefined ? [] : g.kanbanBoards;
      if (!folders.length && !(Array.isArray(boards) && boards.length)) return { error: `${label}: pick at least one folder or kanban board.` };
      if (!folders.every(NAME_OK) || !Array.isArray(boards) || !boards.every(NAME_OK)) return { error: `${label}: folders and boards are plain names from the lists.` };
      for (const f of folders) {
        if (used.has(f)) return { error: `The folder "${f}" is in two projects.` };
        used.add(f);
      }
      fields.groups.push({ label, folders: [...folders], kanbanBoards: [...new Set(boards)] });
    }
  }
  if (input.ignore !== undefined) {
    if (!Array.isArray(input.ignore) || input.ignore.length > 200 || !input.ignore.every(NAME_OK)) return { error: 'Left out: plain folder names from the list.' };
    fields.ignore = [...new Set(input.ignore)];
  }
  return { fields };
}

/** Check a Claude account's fields (all optional except on a new one); returns { fields } or { error }. */
function claudeFields(input, rules, { isNew, label: current }) {
  const out = {};
  const name = input.label !== undefined ? String(input.label).trim() : current;
  if (input.label !== undefined || isNew) {
    if (!name || name.length > 24 || /[\u0000-\u001f<>]/.test(name)) return { error: 'An account name is 1 to 24 characters.' };
    out.label = name;
  }
  if (input.command !== undefined || isNew) {
    const r = rules.command(input.command, `${name}: command`);
    if (r.error) return r;
    out.command = r.value;
  }
  if (input.configDir !== undefined || isNew) {
    const r = rules.folder(input.configDir, `${name}: Claude folder`);
    if (r.error) return r;
    out.configDir = r.value;
  }
  if (input.folderArg !== undefined) {
    if (typeof input.folderArg !== 'boolean') return { error: `${name}: "takes the folder first" must be on or off.` };
    out.folderArg = input.folderArg;
  }
  if (input.tag !== undefined) {
    const t = String(input.tag).trim();
    if (t.length > 8 || !/^[A-Za-z0-9 ·._-]*$/.test(t)) return { error: `${name}: a tag is up to 8 letters or digits.` };
    out.tag = t;
  }
  if (input.accent !== undefined) {
    if (!ACCENTS.includes(input.accent)) return { error: `${name}: pick one of the colour choices.` };
    out.accent = input.accent;
  }
  return { fields: out };
}

// A model name as the agents take it: short and plain, never something that could read as an option or a path trick.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const validModel = (m) => m === '' || MODEL_RE.test(m);

/**
 * Apply a change from Settings to `setup`. `changes` may hold only the fields Settings edits:
 *   agents.hermes / openclaw / codex: { enabled }, codex also { model }
 *   agents.claude: [{ id, enabled, model }] (accounts matched by id)
 *   suggest: { agent, model }, usage: { rings }
 * `local` is true when the request comes from this computer itself: a default model can only be changed there.
 * Returns { setup } (a new object; the input is untouched) or { error } (a sentence for the page).
 */
export function applyChanges(setup, changes, { local = false, checks = diskChecks() } = {}) {
  const rules = pathRules(checks);
  const next = JSON.parse(JSON.stringify(setup));
  const c = isObject(changes) ? changes : {};
  const only = (obj, keys, where) => {
    const extra = Object.keys(obj).filter((k) => !keys.includes(k));
    return extra.length ? `${where}: ${extra.join(', ')} can't be changed here.` : '';
  };
  const bool = (v, what) => (typeof v === 'boolean' ? '' : `${what} must be on or off.`);
  const computerOnly = (before, after, what) => (!local && (before || '') !== after ? `${what} can only be changed on the computer AgentHub runs on.` : '');

  const top = only(c, ['agents', 'suggest', 'usage', 'projects', 'access', 'welcome'], 'Settings');
  if (top) return { error: top };

  const agents = isObject(c.agents) ? c.agents : {};
  const bad = only(agents, ['hermes', 'openclaw', 'codex', 'claude', 'addClaude', 'removeClaude'], 'Agents');
  if (bad) return { error: bad };
  const atComputer = 'Program paths, folders, ports and Claude accounts can only be changed on the computer AgentHub runs on.';
  for (const name of ['hermes', 'openclaw', 'codex']) {
    if (agents[name] === undefined) continue;
    const a = agents[name];
    if (!isObject(a)) return { error: `${name}: expected its settings.` };
    const err = only(a, [...(name === 'codex' ? ['enabled', 'model'] : ['enabled']), ...PATH_FIELDS[name]], name);
    if (err) return { error: err };
    for (const field of PATH_FIELDS[name]) {
      if (a[field] === undefined) continue;
      if (!local) return { error: atComputer };
      const what = { dashboardUrl: 'Hermes dashboard', launcher: 'Hermes launcher', kanbanRoot: 'Hermes kanban folder', bin: 'OpenClaw command',
        port: 'OpenClaw port', command: 'Codex command', sessionsDir: 'Codex sessions folder' }[field];
      const rule = { dashboardUrl: rules.localUrl, launcher: rules.command, kanbanRoot: rules.folder, bin: rules.command, port: rules.port,
        command: rules.command, sessionsDir: rules.folder }[field];
      const r = rule(a[field], what);
      if (r.error) return { error: r.error };
      next.agents[name][field] = r.value;
    }
    if (a.enabled !== undefined) {
      const e = bool(a.enabled, `${name} on/off`);
      if (e) return { error: e };
      next.agents[name].enabled = a.enabled;
    }
    if (a.model !== undefined) {
      const m = String(a.model).trim();
      if (!validModel(m)) return { error: 'A model is a short name like gpt-5.5 or sonnet (letters, digits, . - _ : /).' };
      const e = computerOnly(setup.agents.codex.model, m, "Codex's default model");
      if (e) return { error: e };
      if (m) next.agents.codex.model = m; else delete next.agents.codex.model;
    }
  }
  if (agents.claude !== undefined) {
    if (!Array.isArray(agents.claude)) return { error: 'Claude accounts: expected a list.' };
    for (const a of agents.claude) {
      const err = isObject(a) ? only(a, ['id', 'enabled', 'model', ...CLAUDE_FIELDS], 'A Claude account') : 'A Claude account: expected its settings.';
      if (err) return { error: err };
      const acct = next.agents.claude.find((x) => x.id === a.id);
      if (!acct) return { error: `There is no Claude account "${a.id}".` };
      const label = acct.label || acct.id;
      if (CLAUDE_FIELDS.some((f) => a[f] !== undefined)) {
        if (!local) return { error: atComputer };
        const { fields, error } = claudeFields(a, rules, { isNew: false, label });
        if (error) return { error };
        Object.assign(acct, fields);
      }
      if (a.enabled !== undefined) {
        const e = bool(a.enabled, `${label} on/off`);
        if (e) return { error: e };
        acct.enabled = a.enabled;
      }
      if (a.model !== undefined) {
        const m = String(a.model).trim();
        if (!validModel(m)) return { error: 'A model is a short name like sonnet, opus or claude-opus-5-5 (letters, digits, . - _ : /).' };
        const before = setup.agents.claude.find((x) => x.id === a.id)?.model;
        const e = computerOnly(before, m, `${label}'s default model`);
        if (e) return { error: e };
        if (m) acct.model = m; else delete acct.model;
      }
    }
  }

  if (agents.addClaude !== undefined) {
    if (!local) return { error: atComputer };
    // One new account, or several (Detect can offer more than one).
    for (const add of Array.isArray(agents.addClaude) ? agents.addClaude : [agents.addClaude]) {
      if (!isObject(add)) return { error: 'A new Claude account: expected its settings.' };
      const err = only(add, CLAUDE_FIELDS, 'A new Claude account');
      if (err) return { error: err };
      const { fields, error } = claudeFields(add, rules, { isNew: true });
      if (error) return { error };
      const id = newAccountId(fields.label, new Set(next.agents.claude.map((x) => x.id)));
      next.agents.claude.push({ id, ...fields, readOnly: [] });
    }
  }
  if (agents.removeClaude !== undefined) {
    if (!local) return { error: atComputer };
    const ids = Array.isArray(agents.removeClaude) ? agents.removeClaude : [agents.removeClaude];
    for (const id of ids) {
      if (!next.agents.claude.some((x) => x.id === id)) return { error: `There is no Claude account "${id}".` };
      next.agents.claude = next.agents.claude.filter((x) => x.id !== id);
      if (next.suggest?.agent === id) next.suggest.agent = '';
    }
    if (!next.agents.claude.length) return { error: 'Keep at least one Claude account (switch it off instead).' };
  }
  // Two accounts on one Claude folder would show every chat twice; names must tell them apart.
  const folders = next.agents.claude.map((x) => path.resolve(String(x.configDir || '').replace(/^~(?=\/|$)/, checks.home)));
  if (new Set(folders).size !== folders.length) return { error: 'Two Claude accounts use the same Claude folder.' };
  const labels = next.agents.claude.map((x) => String(x.label || x.id).toLowerCase());
  if (new Set(labels).size !== labels.length) return { error: 'Two Claude accounts have the same name.' };

  if (c.welcome !== undefined) {
    if (!isObject(c.welcome) || Object.keys(c.welcome).some((k) => k !== 'done') || typeof c.welcome.done !== 'boolean') return { error: 'Welcome: done must be on or off.' };
    next.welcome = { done: c.welcome.done };
  }

  if (c.access !== undefined) {
    const r = accessChanges(c.access, { local, checks });
    if (r.error) return { error: r.error };
    Object.assign(next.access, r.fields);
  }

  if (c.projects !== undefined) {
    const r = projectChanges(c.projects, { local, rules });
    if (r.error) return { error: r.error };
    Object.assign(next.projects, r.fields);
  }

  if (c.suggest !== undefined) {
    if (!isObject(c.suggest)) return { error: 'Suggested replies: expected its settings.' };
    const err = only(c.suggest, ['agent', 'model'], 'Suggested replies');
    if (err) return { error: err };
    if (c.suggest.agent !== undefined) {
      const id = String(c.suggest.agent);
      if (id && !next.agents.claude.some((x) => x.id === id)) return { error: 'Suggested replies: pick one of your Claude accounts.' };
      next.suggest.agent = id;
    }
    if (c.suggest.model !== undefined) {
      const m = String(c.suggest.model).trim();
      if (!m || !validModel(m)) return { error: 'Suggested replies: pick a model (a short name like sonnet).' };
      next.suggest.model = m;
    }
  }
  if (c.usage !== undefined) {
    if (!isObject(c.usage)) return { error: 'Usage rings: expected its settings.' };
    const err = only(c.usage, ['rings'], 'Usage rings') || (c.usage.rings !== undefined ? bool(c.usage.rings, 'Usage rings') : '');
    if (err) return { error: err };
    if (c.usage.rings !== undefined) next.usage.rings = c.usage.rings;
  }
  return { setup: next };
}
