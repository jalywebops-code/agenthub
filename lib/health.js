// Agent lights. A light answers one question: can the
// board act on this agent right now?
//   ok    green: yes (the gateway answers, or a session in tmux the board can answer)
//   idle  amber: nothing to act on, but nothing is broken (no session running; New chat starts one)
//   down  red:   no (the agent itself is closed, or the board can't reach or find it)
// `why` is the plain sentence shown when you hover over or hold the light.
import fs from 'node:fs/promises';

/** Hermes and OpenClaw: the board acts through the agent's own gateway. `error` is why it didn't answer ('' = it did). */
export function gatewayHealth(name, error) {
  if (!error) return { health: 'ok', why: `${name} is running: the board can reply and approve.` };
  return { health: 'down', why: `${name} itself isn't running, so the board can show its chats but can't reply. (${error})` };
}

/**
 * Claude Code accounts and Codex: the board acts through sessions running in tmux.
 * `running` is how many sessions are running at all, `inTmux` how many of them the board can answer.
 */
export function tmuxHealth(name, { binOk, bin = '', running, inTmux }) {
  if (!binOk) return { health: 'down', why: `${name} isn't installed where the board expects it (${bin}), so New chat can't start it.` };
  if (inTmux > 0) return { health: 'ok', why: `${inTmux} ${inTmux === 1 ? 'session' : 'sessions'} in tmux: the board can answer ${inTmux === 1 ? 'it' : 'them'}.` };
  if (running > 0) {
    return { health: 'idle', why: `${running} ${running === 1 ? 'session' : 'sessions'} running, none in tmux, so the board can only read ${running === 1 ? 'it' : 'them'}. New chat starts one it can answer.` };
  }
  return { health: 'idle', why: `No ${name} session is running. New chat starts one.` };
}

/** True when a program file exists and can be run. */
export async function canRun(file) {
  try { await fs.access(file, fs.constants.X_OK); return true; } catch { return false; }
}
