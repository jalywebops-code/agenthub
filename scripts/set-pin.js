// Set a new board PIN. Run it yourself in Terminal on this computer: `npm run set-pin`.
// - Asks for the current PIN first (when one is set), so a program can't silently take the board over this way.
// - The new PIN is typed hidden (never on the command line, where it would land in shell history), or press Enter
//   to get a random 8-digit one, shown once.
// - Stores only a salted hash, makes a new signing secret (every device is signed out) and restarts the board.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../lib/config.js';
import { hashPin, verifyPin, validPin } from '../lib/auth.js';
import { restartBoard, restartCommand } from '../lib/service.js';

if (!process.stdin.isTTY) {
  console.error('Run this yourself in Terminal: npm run set-pin');
  process.exit(1);
}

/** Read one line without showing what is typed. */
function hidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let text = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') { done(); return; }
      if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      if (ch === '\u007f' || ch === '\b') { text = text.slice(0, -1); return; }
      text += ch;
    };
    function done() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(text.trim());
    }
    stdin.on('data', onData);
  });
}

const pinFile = path.join(config.dataDir, 'pin');
const current = fs.existsSync(pinFile) ? fs.readFileSync(pinFile, 'utf8').trim() : '';
if (current) {
  const given = await hidden('Current PIN: ');
  if (!verifyPin(given, current)) {
    console.error('That is not the current PIN. Nothing changed.');
    process.exit(1);
  }
}

let pin = await hidden('New PIN (8-12 digits), or press Enter for a random one: ');
let shown = false;
if (!pin) {
  pin = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
  shown = true;
} else {
  if (!validPin(pin)) { console.error('A PIN is 8 to 12 digits. Nothing changed.'); process.exit(1); }
  if ((await hidden('Type it again: ')) !== pin) { console.error('The two PINs differ. Nothing changed.'); process.exit(1); }
}

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(config.dataDir, 0o700);
for (const [name, value] of [['pin', hashPin(pin)], ['secret', crypto.randomBytes(32).toString('hex')]]) {
  const file = path.join(config.dataDir, name);
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

let restarted = false;
try {
  await restartBoard();
  restarted = true;
} catch { /* reported below */ }

if (shown) console.log(`\nNew AgentHub PIN: ${pin}   (shown once)`);
console.log(restarted
  ? '\nBoard restarted. Every device, this computer included, must log in again with the new PIN.\n'
  : '\nThe new PIN is saved but NOT in use yet: the board could not be restarted. Until it restarts, the old PIN and '
    + `existing logins still work. Restart it with:  ${(await restartCommand()) || 'npm start'}\n`);
