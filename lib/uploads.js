// Images you add to a message (New chat, Reply, Request changes). The phone shrinks each one, the board saves it on
// this computer, and the message carries only its id; the server turns ids back into files and hands them to the agent.
// Only images, only files the board saved itself, and old ones are cleared after KEEP_DAYS.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES = 4;
const KEEP_DAYS = 30;

// Leading bytes -> extension. Nothing else is accepted, whatever the browser says the file is.
const MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png'],
  [[0xff, 0xd8, 0xff], 'jpg'],
  [[0x47, 0x49, 0x46, 0x38], 'gif'],
];
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
// An id is "<day>/<24 hex>.<ext>": no other shape can name a file, so an id can never point outside the folder.
const ID = /^(\d{4}-\d{2}-\d{2})\/([a-f0-9]{24})\.(png|jpg|gif|webp)$/;

/** The image type from its first bytes ('png', 'jpg', 'gif', 'webp'), or '' when it isn't one of those. */
export function sniffImage(buf) {
  for (const [sig, ext] of MAGIC) if (sig.every((b, i) => buf[i] === b)) return ext;
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

/** Decode the page's base64 (a bare string or a data: URL). Throws a message to show when it isn't a usable image. */
export function decodeImage(data) {
  if (typeof data !== 'string' || !data) throw new Error('No image was sent.');
  const b64 = data.replace(/^data:[^;,]+;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('That image could not be read.');
  if (b64.length * 0.75 > MAX_IMAGE_BYTES + 3) throw new Error('That image is too large (8 MB at most).');
  const buf = Buffer.from(b64, 'base64');
  const ext = sniffImage(buf);
  if (!ext) throw new Error('Only PNG, JPEG, GIF or WebP images can be added.');
  return { buf, ext };
}

/** Save one image under `dir` (the board's uploads folder). Returns its id. */
export async function saveImage(dir, data, now = new Date()) {
  const { buf, ext } = decodeImage(data);
  const day = now.toISOString().slice(0, 10);
  const id = `${day}/${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await fsp.mkdir(path.join(dir, day), { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(dir, id), buf, { mode: 0o600, flag: 'wx' });
  return id;
}

/**
 * The files for a message's image ids, in order: [{ path, mime, name }]. Throws a message to show when an id is
 * malformed, missing, repeated, or there are too many. `ids` may be absent (no images).
 */
export function resolveImages(dir, ids) {
  if (ids == null) return [];
  if (!Array.isArray(ids)) throw new Error('Images were not sent correctly.');
  if (ids.length > MAX_IMAGES) throw new Error(`Add at most ${MAX_IMAGES} images to one message.`);
  if (new Set(ids).size !== ids.length) throw new Error('The same image was added twice.');
  return ids.map((id) => {
    const m = ID.exec(String(id));
    if (!m) throw new Error('Images were not sent correctly.');
    const file = path.join(dir, id);
    if (!fs.existsSync(file)) throw new Error('An added image is no longer on the computer. Remove it and add it again.');
    return { path: file, mime: MIME[m[3]], name: `${m[2].slice(0, 8)}.${m[3]}` };
  });
}

/** The lines added to a message for agents that open images from a file path (Claude Code, Codex replies). */
export function imageNote(images) {
  if (!images.length) return '';
  const one = images.length === 1;
  return `\n\n[${one ? 'An image is' : `${images.length} images are`} attached to this message. Open ${one ? 'it' : 'each'} to see ${one ? 'it' : 'them'}:]\n${images.map((i) => i.path).join('\n')}`;
}

/** Remove days older than KEEP_DAYS (whole day folders the board made). Returns how many were removed. */
export async function pruneImages(dir, now = new Date()) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return 0; }
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const old = names.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && n < cutoff);
  for (const n of old) await fsp.rm(path.join(dir, n), { recursive: true, force: true });
  return old.length;
}
