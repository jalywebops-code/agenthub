#!/usr/bin/env node
// npm run install-service  [-- --label <name>]   start AgentHub at login and restart it if it crashes
// npm run uninstall-service [-- --label <name>]  stop it and remove it again
//
// macOS: fills in launchd/*.plist.template (this Node, this folder, your home folder), writes it to
// ~/Library/LaunchAgents and loads it. Linux: fills in systemd/*.service.template, writes it to
// ~/.config/systemd/user and enables it. The Hermes dashboard helper is added only when Hermes is on in the setup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, ROOT } from '../lib/config.js';
import { DEFAULT_LABEL, serviceLabel, rememberLabel, forgetLabel, fillTemplate } from '../lib/service.js';

const [, , action, ...args] = process.argv;
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const home = os.homedir();
const MAC = process.platform === 'darwin';
const quietly = (fn) => { try { fn(); } catch { /* not loaded */ } };
const sh = (cmd, ...a) => execFileSync(cmd, a, { stdio: 'pipe' });

// Where each system keeps user services, and how to start and stop one.
const SYS = MAC ? {
  dir: path.join(home, 'Library', 'LaunchAgents'),
  file: (name) => `${name}.plist`,
  templates: { board: 'launchd/agenthub.plist.template', hermes: 'launchd/agenthub-hermes-dashboard.plist.template' },
  xml: true,
  start: (name, file) => { quietly(() => sh('/bin/launchctl', 'bootout', `gui/${process.getuid()}/${name}`)); sh('/bin/launchctl', 'bootstrap', `gui/${process.getuid()}`, file); },
  stop: (name) => quietly(() => sh('/bin/launchctl', 'bootout', `gui/${process.getuid()}/${name}`)),
  done: () => {},
} : {
  dir: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user'),
  file: (name) => `${name}.service`,
  templates: { board: 'systemd/agenthub.service.template', hermes: 'systemd/agenthub-hermes-dashboard.service.template' },
  xml: false,
  start: (name) => { sh('systemctl', '--user', 'daemon-reload'); sh('systemctl', '--user', 'enable', '--now', `${name}.service`); },
  stop: (name) => quietly(() => sh('systemctl', '--user', 'disable', '--now', `${name}.service`)),
  done: () => quietly(() => sh('systemctl', '--user', 'daemon-reload')),
};

if (!MAC && process.platform !== 'linux') {
  console.error('install-service supports macOS and Linux. Elsewhere, run `npm start` under your own process manager.');
  process.exit(1);
}

if (action === 'install') {
  const label = flag('--label') || DEFAULT_LABEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*agenthub$|^agenthub$/.test(label)) {
    console.error(`A name is short, ends in "agenthub" and has only letters, digits, dots and dashes, e.g. ${DEFAULT_LABEL}`);
    process.exit(1);
  }
  const running = await serviceLabel();
  if (running && running !== label) {
    console.error(`AgentHub already runs as the service "${running}". Two would fight over the same port.\n`
      + `Use it as it is, or remove it first: npm run uninstall-service -- --label ${running}`);
    process.exit(1);
  }
  const items = [{ name: label, template: SYS.templates.board, values: {
    LABEL: label, NODE: process.execPath, ROOT,
    PATH: [path.dirname(process.execPath), path.join(home, '.npm-global/bin'), path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  } }];
  const hermesPython = path.join(home, '.hermes/hermes-agent/venv/bin/python');
  if (config.enabled.hermes && fs.existsSync(hermesPython)) {
    const port = Number(/:(\d+)/.exec(config.hermes.baseUrl)?.[1]) || 9119;
    const name = MAC ? `${label}.hermes-dashboard` : `${label}-hermes-dashboard`;
    items.push({ name, template: SYS.templates.hermes, values: { LABEL: name, HOME: home, ROOT, PORT: port } });
  }
  fs.mkdirSync(SYS.dir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  for (const item of items) {
    const file = path.join(SYS.dir, SYS.file(item.name));
    const text = fillTemplate(fs.readFileSync(path.join(ROOT, item.template), 'utf8'), item.values, { xml: SYS.xml });
    fs.writeFileSync(file, text, { mode: 0o644 });
    SYS.start(item.name, file);
    console.log(`Installed and started ${item.name}  (${file})`);
  }
  rememberLabel(label);
  console.log(`\nAgentHub starts ${MAC ? 'at login' : 'with your user session'} now. Open http://localhost:${config.port}`);
  if (!MAC) console.log('On a server you don\'t log in to, run this once so it keeps running:  loginctl enable-linger $USER');
} else if (action === 'uninstall') {
  const label = flag('--label') || (await serviceLabel());
  if (!label) {
    console.error('AgentHub is not installed as a service.');
    process.exit(1);
  }
  for (const name of [label, MAC ? `${label}.hermes-dashboard` : `${label}-hermes-dashboard`]) {
    SYS.stop(name);
    const file = path.join(SYS.dir, SYS.file(name));
    if (fs.existsSync(file)) { fs.rmSync(file); console.log(`Stopped and removed ${name}`); }
  }
  SYS.done();
  forgetLabel();
  console.log('AgentHub no longer starts by itself. Start it by hand with: npm start');
} else {
  console.error('Usage: npm run install-service  |  npm run uninstall-service   (optional: -- --label <name>)');
  process.exit(1);
}
