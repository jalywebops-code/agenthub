// The welcome (onboarding) for a new install: for each agent AgentHub supports, a plain state and the exact next
// steps, so a new user connects the agents they use without reading docs. Checks only: files and folders, whether a
// command is installed, whether the agent is signed in or set up, whether its gateway answers. Nothing is installed,
// started or signed in from here.
import path from 'node:path';
import { findCommand, commandWorks } from './detect.js';

export const LINKS = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli/',
  hermes: 'https://hermes-agent.nousresearch.com/docs/',
  openclaw: 'https://docs.openclaw.ai/start/getting-started',
};

const expand = (p, home) => (p === '~' ? home : String(p || '').startsWith('~/') ? path.join(home, p.slice(2)) : String(p || ''));
const step = (text, command = '', link = '') => ({ text, ...(command ? { command } : {}), ...(link ? { link } : {}) });

/**
 * One state per agent: 'ready' | 'off' | 'not-installed' | 'not-set-up' | 'not-running', with a sentence (`why`) and
 * the steps to get it ready. `facts` are what was checked on this computer: signedIn(configDir) for a Claude account,
 * listening.hermes / listening.openclaw (their gateways answer), exists(path).
 */
export function welcomeChecks(setup, env, facts) {
  const { home } = env;
  const a = setup.agents;
  const agents = [];
  const add = (key, kind, label, enabled, state, why, steps = []) => agents.push({ key, kind, label, enabled, state, why, steps });

  for (const c of a.claude) {
    const label = c.label || c.id;
    const cmd = commandWorks(env, c.command) ? c.command : '';
    if (!cmd) {
      add(c.id, 'claude', label, c.enabled !== false, 'not-installed', 'Claude Code is not installed here (or not where the setup says).',
        [step('Install Claude Code from its setup page, then check again.', '', LINKS.claude)]);
    } else if (!facts.signedIn(expand(c.configDir, home))) {
      add(c.id, 'claude', label, c.enabled !== false, 'not-set-up', 'Claude Code is installed but not signed in.',
        [step('Open a terminal, run this once and log in with your Claude account:', path.basename(expand(cmd, home)))]);
    } else {
      add(c.id, 'claude', label, c.enabled !== false, c.enabled === false ? 'off' : 'ready', c.enabled === false ? 'Installed and signed in, switched off.' : 'Installed and signed in.');
    }
  }

  const codexOk = commandWorks(env, a.codex.command) || !!findCommand(env, 'codex');
  const codexHome = path.dirname(expand(a.codex.sessionsDir, home));
  if (!codexOk) {
    add('codex', 'codex', 'Codex', a.codex.enabled !== false, 'not-installed', 'Codex is not installed here.',
      [step('Install the Codex CLI from its page, then check again.', '', LINKS.codex)]);
  } else if (!facts.exists(path.join(codexHome, 'auth.json'))) {
    add('codex', 'codex', 'Codex', a.codex.enabled !== false, 'not-set-up', 'Codex is installed but not signed in.',
      [step('Open a terminal, run this and choose "Sign in with ChatGPT":', 'codex')]);
  } else {
    add('codex', 'codex', 'Codex', a.codex.enabled !== false, a.codex.enabled === false ? 'off' : 'ready', a.codex.enabled === false ? 'Installed and signed in, switched off.' : 'Installed and signed in.');
  }

  const hermesCmd = env.isExecutable(expand(a.hermes.launcher, home)) || findCommand(env, 'hermes');
  if (!hermesCmd) {
    add('hermes', 'hermes', 'Hermes', a.hermes.enabled !== false, 'not-installed', 'Hermes is not installed here.',
      [step('Install Hermes Agent from its docs, then check again.', '', LINKS.hermes)]);
  } else if (!facts.exists(path.join(home, '.hermes', 'config.yaml'))) {
    add('hermes', 'hermes', 'Hermes', a.hermes.enabled !== false, 'not-set-up', 'Hermes is installed but not set up yet.',
      [step('Open a terminal and run its setup wizard (it picks the model Hermes uses):', 'hermes setup')]);
  } else if (!facts.listening.hermes) {
    add('hermes', 'hermes', 'Hermes', a.hermes.enabled !== false, 'not-running', 'Hermes is set up, but its dashboard (which AgentHub reads) is not running.',
      [step('Start it (Start with your computer below keeps it running from then on):', 'hermes dashboard --no-open --skip-build'),
        step('So AgentHub can answer Hermes chats, keep its gateway running too:', 'hermes gateway install')]);
  } else {
    add('hermes', 'hermes', 'Hermes', a.hermes.enabled !== false, a.hermes.enabled === false ? 'off' : 'ready', a.hermes.enabled === false ? 'Running, switched off.' : 'Set up and running.');
  }

  const ocCmd = commandWorks(env, a.openclaw.bin) || findCommand(env, 'openclaw');
  if (!ocCmd) {
    add('openclaw', 'openclaw', 'OpenClaw', a.openclaw.enabled !== false, 'not-installed', 'OpenClaw is not installed here.',
      [step('Install OpenClaw from its getting-started page, then check again.', '', LINKS.openclaw)]);
  } else if (!facts.exists(path.join(home, '.openclaw', 'openclaw.json'))) {
    add('openclaw', 'openclaw', 'OpenClaw', a.openclaw.enabled !== false, 'not-set-up', 'OpenClaw is installed but not set up yet.',
      [step('Open a terminal and run its guided setup:', 'openclaw onboard --install-daemon')]);
  } else if (!facts.listening.openclaw) {
    add('openclaw', 'openclaw', 'OpenClaw', a.openclaw.enabled !== false, 'not-running', 'OpenClaw is set up, but its gateway is not running.',
      [step('Start the gateway:', 'openclaw gateway start')]);
  } else {
    add('openclaw', 'openclaw', 'OpenClaw', a.openclaw.enabled !== false, a.openclaw.enabled === false ? 'off' : 'ready', a.openclaw.enabled === false ? 'Running, switched off.' : 'Set up and running.');
  }

  const mac = process.platform === 'darwin';
  const tmux = findCommand(env, 'tmux', ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'])
    ? { ok: true }
    : { ok: false, why: 'tmux is not installed. Without it AgentHub can show Claude Code and Codex chats but not answer them.',
      steps: [step('Install it, then check again:', mac ? 'brew install tmux' : 'sudo apt install tmux')] };
  return { agents, tmux };
}
