// The welcome (onboarding): each agent's state on a computer, and the next steps it gives (lib/welcome.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { welcomeChecks, LINKS } from '../lib/welcome.js';
import { defaultSetup } from '../lib/setup.js';

const HOME = '/Users/you';
function computer({ programs = [], files = [], signedIn = [], listening = {} } = {}) {
  const p = new Set(programs);
  const f = new Set(files);
  return {
    env: { home: HOME, isExecutable: (x) => p.has(x), isDir: () => false, readJson: () => null, listDir: () => [], pathDirs: ['/opt/homebrew/bin', `${HOME}/.local/bin`] },
    facts: { signedIn: (dir) => signedIn.includes(dir), exists: (x) => f.has(x), listening: { hermes: false, openclaw: false, ...listening } },
  };
}
const byKey = (r) => Object.fromEntries(r.agents.map((a) => [a.key, a]));

test('a bare computer: every agent not installed, each with its install page; tmux missing', () => {
  const { env, facts } = computer();
  const r = welcomeChecks(defaultSetup(), env, facts);
  const a = byKey(r);
  assert.deepEqual(r.agents.map((x) => x.state), ['not-installed', 'not-installed', 'not-installed', 'not-installed']);
  assert.equal(a.claude.steps[0].link, LINKS.claude);
  assert.equal(a.hermes.steps[0].link, LINKS.hermes);
  assert.equal(r.tmux.ok, false);
  assert.match(r.tmux.steps[0].command, /tmux/);
});

test('installed but not signed in or set up: the exact command to run', () => {
  const { env, facts } = computer({ programs: [`${HOME}/.local/bin/claude`, '/opt/homebrew/bin/codex', `${HOME}/.local/bin/hermes`, '/opt/homebrew/bin/openclaw', '/opt/homebrew/bin/tmux'] });
  const a = byKey(welcomeChecks(defaultSetup(), env, facts));
  assert.equal(a.claude.state, 'not-set-up');
  assert.equal(a.claude.steps[0].command, 'claude');
  assert.equal(a.codex.state, 'not-set-up');
  assert.equal(a.hermes.steps[0].command, 'hermes setup');
  assert.match(a.openclaw.steps[0].command, /^openclaw onboard/);
});

test('set up but not running: how to start it', () => {
  const { env, facts } = computer({ programs: [`${HOME}/.local/bin/hermes`, '/opt/homebrew/bin/openclaw'],
    files: [path.join(HOME, '.hermes', 'config.yaml'), path.join(HOME, '.openclaw', 'openclaw.json')] });
  const a = byKey(welcomeChecks(defaultSetup(), env, facts));
  assert.equal(a.hermes.state, 'not-running');
  assert.match(a.hermes.steps[0].command, /^hermes dashboard/);
  assert.equal(a.openclaw.state, 'not-running');
  assert.equal(a.openclaw.steps[0].command, 'openclaw gateway start');
});

test('everything ready; an agent switched off says so', () => {
  const s = defaultSetup();
  s.agents.codex.enabled = false;
  const { env, facts } = computer({
    programs: [`${HOME}/.local/bin/claude`, '/opt/homebrew/bin/codex', `${HOME}/.local/bin/hermes`, '/opt/homebrew/bin/openclaw', '/opt/homebrew/bin/tmux'],
    files: [path.join(HOME, '.codex', 'auth.json'), path.join(HOME, '.hermes', 'config.yaml'), path.join(HOME, '.openclaw', 'openclaw.json')],
    signedIn: [path.join(HOME, '.claude')], listening: { hermes: true, openclaw: true } });
  const r = welcomeChecks(s, env, facts);
  assert.deepEqual(r.agents.map((x) => `${x.key}:${x.state}`), ['claude:ready', 'codex:off', 'hermes:ready', 'openclaw:ready']);
  assert.equal(r.tmux.ok, true);
});
