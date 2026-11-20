#!/usr/bin/env node
// npm run setup [-- --yes]
// For a computer you reach over SSH (a server with no screen): find your agents (Detect) and save what it finds,
// asking about each finding (with --yes, take the ones Detect suggests). Everything else is in Settings, which you
// can open from your own browser through an SSH tunnel (printed at the end): it then counts as this computer.
import path from 'node:path';
import readline from 'node:readline/promises';
import { config } from '../lib/config.js';
import { loadSetup, writeSetup, applyChanges } from '../lib/setup.js';
import { detect, mergeChanges } from '../lib/detect.js';
import { restartBoard, serviceLabel } from '../lib/service.js';

const FILE = path.join(config.dataDir, 'setup.json');
const yesToAll = process.argv.includes('--yes');
const setup = loadSetup(FILE);

console.log('\nAgentHub setup\n');
const a = setup.agents;
const on = (x) => (x.enabled !== false ? 'on ' : 'off');
console.log(`  ${'Hermes'.padEnd(13)} ${on(a.hermes)}  ${a.hermes.launcher}`);
console.log(`  ${'OpenClaw'.padEnd(13)} ${on(a.openclaw)}  ${a.openclaw.bin} (port ${a.openclaw.port})`);
for (const c of a.claude) console.log(`  ${(c.label || c.id).padEnd(13)} ${on(c)}  ${c.command}  (${c.configDir})`);
console.log(`  ${'Codex'.padEnd(13)} ${on(a.codex)}  ${a.codex.command}  (${a.codex.sessionsDir})`);
console.log(`  ${'Projects'.padEnd(13)}     ${setup.projects.root}\n`);

const items = detect(setup);
if (!items.length) {
  console.log('Detect found nothing to change: the agents it can find are on, and every path works.');
} else {
  const rl = !yesToAll && process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const picked = [];
  for (const i of items) {
    if (!rl) { if (i.suggested) picked.push(i); console.log(`${i.suggested ? '[x]' : '[ ]'} ${i.label}: ${i.detail}`); continue; }
    const answer = (await rl.question(`${i.label}: ${i.detail}\n  Use it? ${i.suggested ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes' || (!answer && i.suggested)) picked.push(i);
  }
  rl?.close();
  if (!picked.length) {
    console.log('\nNothing changed.');
  } else {
    const { setup: next, error } = applyChanges(setup, mergeChanges(picked), { local: true });
    if (error) { console.error(`\nNot saved: ${error}`); process.exit(1); }
    writeSetup(FILE, next);
    console.log(`\nSaved ${picked.length} change${picked.length === 1 ? '' : 's'} to ${FILE}.`);
    if (await serviceLabel()) {
      try { await restartBoard(); console.log('AgentHub restarted to apply them.'); } catch (e) { console.log(`Restart AgentHub to apply them (${e.message}).`); }
    } else {
      console.log('Start (or restart) AgentHub to apply them: npm start');
    }
  }
}

console.log(`
Everything else (paths, Claude accounts, projects, phone access) is in Settings. From your own computer:
  ssh -L ${config.port}:localhost:${config.port} <this server>
then open http://localhost:${config.port} there: through the tunnel it counts as this computer.
`);
