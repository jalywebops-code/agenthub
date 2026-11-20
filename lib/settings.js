// Board defaults you set in Settings, kept on this computer so the phone and the computer agree (.data/settings.json).
// A device's own choice (e.g. the time window it last picked) still wins on that device.
import fs from 'node:fs';
import { writeFileAtomicSync } from './atomic.js';

export const DEFAULTS = Object.freeze({ defaultAge: '7d', foldDone: true, foldQuietProjects: false });
const AGES = ['today', '7d', '30d', 'all'];

/** Valid settings (unknown keys dropped, missing ones defaulted), or an error message to show. */
export function cleanSettings(input) {
  const out = { ...DEFAULTS };
  const v = input || {};
  if (v.defaultAge !== undefined) {
    if (!AGES.includes(v.defaultAge)) return 'Pick a time window: Today, 7 days, 30 days or All.';
    out.defaultAge = v.defaultAge;
  }
  for (const key of ['foldDone', 'foldQuietProjects']) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'boolean') return 'That switch must be on or off.';
    out[key] = v[key];
  }
  return out;
}

/** The saved settings; defaults when the file is missing or unreadable. */
export function readSettings(file) {
  try {
    const cleaned = cleanSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
    return typeof cleaned === 'string' ? { ...DEFAULTS } : cleaned;
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(file, settings) {
  writeFileAtomicSync(file, JSON.stringify(settings, null, 2));
  fs.chmodSync(file, 0o600);
}
