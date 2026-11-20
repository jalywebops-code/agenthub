// What each agent is called on the board, in one place. Claude Code accounts are named by this install's own setup
// (.data/setup.json, `agents.claude[].label`), so no person's or business's name lives in the code.
import { config } from './config.js';

export const AGENT_NAMES = {
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  ...Object.fromEntries(config.claudeAccounts.map((a) => [a.id, a.label])),
  codex: 'Codex',
};

/** The lane keys that are Claude Code accounts. */
export const CLAUDE_IDS = new Set(config.claudeAccounts.map((a) => a.id));
