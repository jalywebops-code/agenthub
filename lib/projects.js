import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';

/** The project grouping from this install's setup ({ projects, ignore }). */
const load = () => config.projects;

const NO_PROJECT = 'No project';

/**
 * The projects on this computer: the grouped ones from the setup first (their order), then every other real folder
 * directly under `root`, A→Z, named after the folder. Hidden folders, files and `data.ignore` are skipped.
 * `readdir(root)` returns directory entries (injected so tests need no disk).
 */
export function listProjects({ root, data, readdir }) {
  const mapped = data.projects.map((p) => ({ label: p.label, folders: [...p.folders] }));
  const taken = new Set(mapped.flatMap((p) => p.folders));
  const ignore = new Set(data.ignore || []);
  let entries = [];
  try { entries = readdir(root); } catch { entries = []; }
  const found = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !ignore.has(e.name) && !taken.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return [...mapped, ...found.map((name) => ({ label: name, folders: [name] }))];
}

/**
 * The project a chat belongs to, from its working folder:
 *   <projects root>/<folder>/…                     → that folder's project (a setup group's label wins)
 *   <projects root>/.worktrees/<folder>-<suffix>/…  → <folder>'s project (the longest matching folder)
 *   a Hermes kanban board                           → its mapped label, else the board name
 *   the home folder                                 → "Home"
 *   ~/<top>/<name>/… elsewhere in home              → <name>   (e.g. ~/Cursor-Projects/foo → "foo")
 *   inside a hidden app folder (~/.codex/…)         → the chat's own folder name (~/.hermes itself → "Hermes")
 *   anything else                                   → the folder's own name; no folder → "No project"
 */
export function projectForPath(cwd, { root, kanbanRoot, home, data, known }) {
  if (!cwd) return NO_PROJECT;
  const labelOf = (folder) => data.projects.find((p) => p.folders.includes(folder))?.label || folder;
  const inside = (base) => { const rel = path.relative(base, cwd); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep) : null; };
  const board = inside(kanbanRoot);
  if (board) return data.projects.find((p) => (p.kanbanBoards || []).includes(board[0]))?.label || board[0];
  const parts = inside(root);
  if (parts) {
    if (parts[0] === '.worktrees' && parts[1]) {
      const match = [...known].filter((f) => parts[1] === f || parts[1].startsWith(`${f}-`)).sort((a, b) => b.length - a.length)[0];
      return match ? labelOf(match) : parts[1];
    }
    return labelOf(parts[0]);
  }
  if (path.resolve(cwd) === path.resolve(home)) return 'Home';
  const inHome = inside(home);
  if (inHome) {
    // Hidden app folders (~/.codex/worktrees/<id>/<repo>, ~/.hermes/profiles/<name>): the chat's own folder.
    if (inHome[0].startsWith('.')) return inHome.length === 1 ? (inHome[0] === '.hermes' ? 'Hermes' : inHome[0]) : path.basename(cwd);
    return inHome.length >= 2 ? inHome[1] : inHome[0];
  }
  return path.basename(cwd) || NO_PROJECT;
}

// ---------- this computer (the folder list is cached for 60 s) ----------
let scan = { at: 0, list: [] };
function current() {
  const data = load();
  if (Date.now() - scan.at > 60000) {
    const list = listProjects({ root: config.projectsRoot, data, readdir: (r) => fs.readdirSync(r, { withFileTypes: true }) });
    scan = { at: Date.now(), list, known: new Set(list.flatMap((p) => p.folders)) };
  }
  return { data, ...scan };
}

/** Project labels in board order, "No project" last. */
export function projectLabels() {
  return [...current().list.map((p) => p.label), NO_PROJECT];
}

/** The project label for a working folder. */
export function projectFor(cwd) {
  const { data, known } = current();
  return projectForPath(cwd, { root: config.projectsRoot, kanbanRoot: config.kanbanRoot, home: os.homedir(), data, known });
}

/** Every project folder that exists on this computer, for New chat and Hand off. */
export function projectFolders() {
  const out = [];
  for (const p of current().list) {
    for (const folder of p.folders) {
      const dir = path.join(config.projectsRoot, folder);
      if (fs.existsSync(dir)) out.push({ label: p.label === folder ? folder : `${p.label} · ${folder}`, path: dir });
    }
  }
  return out;
}
