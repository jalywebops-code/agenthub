import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSetup, applyChanges, defaultSetup, writeSetup, expandHome as home } from './setup.js';
import { detect, mergeChanges } from './detect.js';
import { findChrome } from './platform.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Demo mode (`npm run demo`): made-up agents and chats (lib/demo.js), kept in a throwaway folder of its own, so a demo
// never reads or changes a real setup.
export const DEMO = process.env.AGENTHUB_DEMO === '1';
// A fresh private folder each run (mkdtemp makes it 0700 with a random name, so no other user can plant one first),
// removed when the demo stops.
const DATA_DIR = DEMO ? fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-demo-')) : path.join(ROOT, '.data');
if (DEMO) {
  writeDemoSetup();
  process.on('exit', () => { fs.rmSync(DATA_DIR, { recursive: true, force: true }); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}

/** The demo's setup: two Claude Code accounts, Codex, Hermes and OpenClaw, and five example project folders. */
function writeDemoSetup() {
  const s = defaultSetup();
  s.agents.claude = [
    { id: 'claude', label: 'Claude Code', command: 'claude', configDir: '~/.claude', readOnly: [] },
    { id: 'claude-work', label: 'Claude · Work', command: 'claude', configDir: '~/.claude-work', tag: 'WORK', accent: 'blue-yellow', readOnly: [] },
  ];
  s.projects = { root: path.join(DATA_DIR, 'projects'), groups: [], ignore: [] };
  // Hermes's kanban boards: a demo folder, never the real one in your home folder.
  s.agents.hermes.kanbanRoot = path.join(DATA_DIR, 'boards');
  for (const b of ['website', 'mobile']) fs.mkdirSync(path.join(DATA_DIR, 'boards', b), { recursive: true });
  s.welcome = { done: true };
  for (const p of ['website-redesign', 'mobile-app', 'data-pipeline', 'docs-site', 'infra']) fs.mkdirSync(path.join(DATA_DIR, 'projects', p), { recursive: true });
  writeSetup(path.join(DATA_DIR, 'setup.json'), s);
}

// This install's own setup: .data/setup.json, made once from setup.local.json (an owner's starting point, never
// committed) or from the generic defaults in lib/setup.js. Nothing about a particular person or machine lives here.
// A brand-new install with no seed runs Detect once, taking what it suggests (agents it finds, ones it doesn't
// switched off); Settings → Agent settings → Detect runs it again later, as proposals to tick.
export const setup = loadSetup(path.join(DATA_DIR, 'setup.json'), path.join(ROOT, 'setup.local.json'), {
  onCreate: (s) => applyChanges(s, mergeChanges(detect(s).filter((i) => i.suggested)), { local: true }).setup || s,
});
const { hermes, openclaw, codex } = setup.agents;

/**
 * One Claude Code account as the board uses it. `id` is the lane key (card ids start with it); `bin` the command that
 * starts Claude Code on it; `dirs` its config folder; `folderArg` true when that command takes the project folder as
 * its first argument (a wrapper script); `tag` a short label shown on its cards; `accent` a colour preset for its
 * button and cards. `readOnly`: extra session folders shown but never acted on, each session labelled by its
 * sub-folder under `labelBy` and tagged (e.g. "Tools").
 */
function claudeAccount(a) {
  const readOnly = (a.readOnly || []).map((r) => ({ dir: home(r.dir), labelBy: home(r.labelBy || ''), tag: r.tag || 'Read-only', name: r.name || '' }));
  return {
    id: a.id,
    label: a.label || a.id,
    bin: home(a.command),
    dirs: [home(a.configDir)],
    defaultDir: home(a.configDir) === home('~/.claude'),
    folderArg: a.folderArg === true,
    tag: a.tag || '',
    accent: a.accent || '',
    // The model New chat starts it with ('' = Claude Code's own default).
    model: a.model || '',
    readOnlyDirs: readOnly.map((r) => r.dir),
    readOnlyRoot: readOnly[0]?.labelBy || '',
    readOnlyTag: readOnly[0]?.tag || '',
    // What a read-only session in the `labelBy` folder itself is called (its folder name when not set).
    readOnlyName: readOnly[0]?.name || '',
  };
}

export const config = {
  demo: DEMO,
  port: Number(process.env.AGENTHUB_PORT || 4400),
  // This computer and Tailscale only. Home-WiFi (plain HTTP) listening is opt-in: AGENTHUB_LAN=1 or the setup.
  listenLan: process.env.AGENTHUB_LAN === '1' || setup.access.homeWifi === true,
  // Home Wi-Fi forced on from outside the setup (the AGENTHUB_LAN=1 switch wins over Settings).
  lanForced: process.env.AGENTHUB_LAN === '1',
  // Extra private addresses to listen on (another private network: ZeroTier, own WireGuard), from Settings.
  extraAddresses: Array.isArray(setup.access.extraAddresses) ? setup.access.extraAddresses : [],
  dataDir: DATA_DIR,
  publicDir: path.join(ROOT, 'public'),
  // Project grouping: { projects: [{ label, folders, kanbanBoards }], ignore } (lib/projects.js).
  projects: { projects: setup.projects.groups, ignore: setup.projects.ignore },
  projectsRoot: home(setup.projects.root),
  kanbanRoot: home(hermes.kanbanRoot),

  // How often the server re-reads every lane in the background (each read starts a couple of helper programs, so not
  // too often). Anything you do on the board refreshes at once; this only sets how soon agents' own news shows.
  refreshMs: 30000,
  // Only sessions with activity inside this window appear on the board.
  lookbackMs: 180 * 24 * 3600 * 1000,
  // An agent that spoke last within this window is waiting on you (shown as Blocked or Review); older is "idle".
  waitWindowMs: 24 * 3600 * 1000,
  // Activity this recent with no finished reply counts as "working".
  workingWindowMs: 3 * 60 * 1000,
  maxPerLane: 300,

  hermes: {
    baseUrl: hermes.dashboardUrl,
    // Replies go through the running Hermes gateway (the desktop app's backend) via lib/hermes_bridge.py,
    // run with the Python interpreter named in Hermes's own launcher.
    launcher: home(hermes.launcher),
    bridge: path.join(ROOT, 'lib/hermes_bridge.py'),
  },
  // The board always passes the gateway port explicitly.
  openclaw: { bin: home(openclaw.bin), port: Number(openclaw.port) },
  // Which agents this install reads (Settings will switch them; the board skips one that is off).
  enabled: { hermes: hermes.enabled !== false, openclaw: openclaw.enabled !== false, codex: codex.enabled !== false },
  // Claude Code accounts, each its own lane, in board order (the board never signs in or touches a login). An account
  // switched off in Settings is left out entirely.
  claudeAccounts: setup.agents.claude.filter((a) => a.enabled !== false).map(claudeAccount),
  // `model`: the one New chat starts Codex with ('' = Codex's own default).
  // `bin`: the command that runs Codex (a name on the PATH, or a full path from Settings).
  codex: { bin: home(codex.command || 'codex'), sessionsDir: home(codex.sessionsDir), model: codex.model || '' },
  // Suggested replies: which Claude account writes them ('' = the chat's own, else the first) and with which model.
  suggest: { agent: setup.suggest.agent || '', model: setup.suggest.model || 'sonnet' },
  // The plan-usage rings on Claude and Codex buttons.
  usage: { rings: setup.usage.rings !== false },
  // A new install opens with the welcome until it is finished.
  welcomeDone: setup.welcome.done !== false,
  // Ask Agent's side chat for Claude Code (a one-shot, tool-less `claude -p`).
  ask: {
    claudeModel: 'sonnet',
    timeoutMs: 180000,
  },
  // Link previews: headless Chrome on this computer, with its own throwaway profile.
  preview: {
    // The configured Chrome, else Chrome or Chromium found on the PATH (Linux); '' when there is none.
    chrome: findChrome(home(setup.preview.chrome)),
    width: 1280,
    height: 900,
    timeoutMs: 45000,
  },
  // Official marks, read from the agents' desktop apps when installed (copies kept in .data, never committed).
  icons: Object.fromEntries(Object.entries(setup.icons).map(([k, v]) => [k, home(v)])),
};
