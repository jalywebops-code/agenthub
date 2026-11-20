// Agent icons: each agent's official mark, read from the app installed on this computer and
// converted to a small PNG in .data/icons. Kept out of git so no logo is redistributed.
// When an app is missing, the page falls back to a plain dot in that agent's brand colour.
// App icons carry an empty margin (about 10% on macOS), so each one is trimmed to its artwork: every logo then fills
// the same square on the board.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { run } from './util.js';
import { decodePng, artBox } from './png.js';
import { IS_MAC } from './platform.js';

export const ICON_DIR = path.join(config.dataDir, 'icons');
// Bumped when the way icons are made changes, so existing ones are made again once.
const ICON_VERSION = 'trimmed-1';

/** Convert one app icon to a 96px PNG trimmed to its artwork. */
async function makeIcon(source, out) {
  // Without macOS's sips, a PNG is used as it is; any other kind leaves the plain stand-in.
  if (!IS_MAC) {
    if (!/\.png$/i.test(source)) throw new Error('needs sips');
    await fs.copyFile(source, out);
    return;
  }
  const work = `${out}.work.png`;
  try {
    await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '256', source, '--out', work], { timeoutMs: 15000 });
    const img = decodePng(await fs.readFile(work));
    const box = artBox(img);
    if (box.size < img.width) {
      await run('/usr/bin/sips', ['-c', String(box.size), String(box.size), '--cropOffset', String(box.y), String(box.x), work, '--out', work], { timeoutMs: 15000 });
    }
    await run('/usr/bin/sips', ['-Z', '96', work, '--out', out], { timeoutMs: 15000 });
  } finally {
    await fs.rm(work, { force: true });
  }
}

/** Convert every installed app icon that is missing, older than its source, or made the old way. */
export async function buildIcons() {
  await fs.mkdir(ICON_DIR, { recursive: true });
  const versionFile = path.join(ICON_DIR, 'version');
  const current = (await fs.readFile(versionFile, 'utf8').catch(() => '')).trim() === ICON_VERSION;
  const made = [];
  for (const [agent, source] of Object.entries(config.icons)) {
    const out = path.join(ICON_DIR, `${agent}.png`);
    try {
      const src = await fs.stat(source);
      const have = await fs.stat(out).catch(() => null);
      if (!current || !have || have.mtimeMs < src.mtimeMs) await makeIcon(source, out);
      made.push(agent);
    } catch { /* app not installed here: the page uses the colour dot */ }
  }
  await fs.writeFile(versionFile, `${ICON_VERSION}\n`);
  return made;
}

/** Path of an agent's icon, or '' if there is none. */
export async function iconFile(agent) {
  if (!Object.hasOwn(config.icons, agent)) return '';
  const file = path.join(ICON_DIR, `${agent}.png`);
  try { await fs.access(file); return file; } catch { return ''; }
}
