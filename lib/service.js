// The board as a service that starts at login and restarts if it crashes: a launchd agent on macOS, a systemd user
// service on Linux. Nothing here names a person or a machine: the service's name (its launchd label or systemd unit) is
// found at run time, so an owner's own install and one made with `npm run install-service` both work.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './util.js';
import { config, ROOT } from './config.js';

const SERVICE_FILE = path.join(config.dataDir, 'service.json');
/** The name `npm run install-service` uses unless told otherwise (a launchd label; a systemd unit on Linux). */
export const DEFAULT_LABEL = process.platform === 'darwin' ? 'local.agenthub' : 'agenthub';

/** The first loaded launchd label that is AgentHub's board ("…agenthub", not one of its helpers), from `launchctl list`. */
export function labelFromList(text) {
  for (const line of String(text).split('\n')) {
    const label = line.trim().split(/\s+/).pop() || '';
    if (/(^|\.)agenthub$/.test(label)) return label;
  }
  return '';
}

/** The first AgentHub unit in `systemctl --user list-units` output ("agenthub.service" → "agenthub"). */
export function unitFromList(text) {
  for (const line of String(text).split('\n')) {
    const unit = line.trim().split(/\s+/)[0] || '';
    if (/(^|[.-])agenthub\.service$/.test(unit)) return unit.replace(/\.service$/, '');
  }
  return '';
}

/**
 * The board's launchd label: the one launchd started this process with, else the one install-service recorded, else
 * a loaded label ending in "agenthub". '' when the board isn't running as a service.
 */
export async function serviceLabel() {
  const own = process.env.XPC_SERVICE_NAME || '';
  if (/(^|\.)agenthub$/.test(own)) return own;
  try {
    const saved = JSON.parse(fs.readFileSync(SERVICE_FILE, 'utf8')).label;
    if (saved) return saved;
  } catch { /* not installed with install-service */ }
  // A loaded service whose name ends in "agenthub" counts only if it runs this copy's own server.js: another copy on
  // the same computer (a second checkout, a test) must never restart someone else's board.
  try {
    const mine = (text) => String(text).includes(path.join(ROOT, 'server.js'));
    if (process.platform === 'darwin') {
      const label = labelFromList(await run('/bin/launchctl', ['list'], { timeoutMs: 5000 }));
      return label && mine(await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeoutMs: 5000 })) ? label : '';
    }
    const unit = unitFromList(await run('systemctl', ['--user', 'list-units', '--type=service', '--all', '--no-legend', '--plain'], { timeoutMs: 5000 }));
    return unit && mine(await run('systemctl', ['--user', 'cat', `${unit}.service`], { timeoutMs: 5000 })) ? unit : '';
  } catch { return ''; }
}

/** Remember the label install-service used (so set-pin and the board find it). */
export function rememberLabel(label) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(SERVICE_FILE, `${JSON.stringify({ label }, null, 2)}\n`, { mode: 0o600 });
}

export function forgetLabel() {
  fs.rmSync(SERVICE_FILE, { force: true });
}

/** Restart the board through its service. Throws, saying why, when it isn't running as one. */
export async function restartBoard() {
  const label = await serviceLabel();
  if (!label) throw new Error('AgentHub is not running as a service. Restart it yourself, or install it with: npm run install-service');
  if (process.platform === 'darwin') await run('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { timeoutMs: 15000 });
  else await run('systemctl', ['--user', 'restart', `${label}.service`], { timeoutMs: 15000 });
}

/** The command that restarts the board by hand, for messages ('' when it isn't a service). */
export async function restartCommand() {
  const label = await serviceLabel();
  if (!label) return '';
  return process.platform === 'darwin' ? `launchctl kickstart -k gui/$(id -u)/${label}` : `systemctl --user restart ${label}.service`;
}

/**
 * Fill `__NAME__` placeholders in a service template; a placeholder left unfilled is an error. `xml`: escape for a
 * launchd plist (systemd files take values as they are).
 */
export function fillTemplate(text, values, { xml = true } = {}) {
  return String(text).replace(/__([A-Z]+)__/g, (m, name) => {
    if (!(name in values)) throw new Error(`Template value missing: ${name}`);
    const v = String(values[name]);
    return xml ? v.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) : v;
  });
}
