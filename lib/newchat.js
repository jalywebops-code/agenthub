// New chat from the board: what may be started where. Nothing here starts anything; the route does, after these checks.

import { AGENT_NAMES as NAMES, CLAUDE_IDS } from './names.js';
// Every Claude Code account and Codex run in a project folder (in tmux, so the board can answer them); Hermes and
// OpenClaw can also start a general chat with no folder.
const NEEDS_FOLDER = new Set([...CLAUDE_IDS, 'codex']);
const MAX_MESSAGE = 8000;

/**
 * Why a New chat request can't be started (a message to show), or null when it is fine.
 * `connected`: agent keys that are connected now; `folders`: the board's own folder list (never a typed path).
 */
export function checkNewChat(body, { connected, folders, needsFolder = NEEDS_FOLDER }) {
  if (body?.confirm !== true) return 'Not confirmed.';
  const agent = String(body.agent || '');
  if (!connected.includes(agent)) return `${NAMES[agent] || 'That agent'} is not connected right now.`;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return 'Type the first message.';
  if (message.length > MAX_MESSAGE) return 'That message is too long.';
  if (body.folder != null && typeof body.folder !== 'string') return 'Pick one of the listed folders.';
  const folder = body.folder || '';
  if (!folder) return needsFolder.has(agent) ? `Pick a project folder for ${NAMES[agent] || agent}.` : null;
  return folders.includes(folder) ? null : 'Pick one of the listed folders.';
}

/** A first message that starts with "-" would be read as a command-line option by `claude` / `codex`; a leading
 * space keeps it a message. */
export function safeFirstMessage(message) {
  return String(message).startsWith('-') ? ` ${message}` : String(message);
}

/** A short name for the new chat: the message's first line, without markdown, at most 60 characters. */
export function chatTitle(message) {
  const line = String(message || '').trim().split('\n')[0].replace(/\*\*|__|`|^#+\s*/g, '').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
