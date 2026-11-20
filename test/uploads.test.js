import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sniffImage, decodeImage, saveImage, resolveImages, imageNote, pruneImages, MAX_IMAGES } from '../lib/uploads.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-uploads-'));

test('sniffImage knows images by their bytes, not their name', () => {
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(JPG), 'jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a....')), 'gif');
  assert.equal(sniffImage(WEBP), 'webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), '');
  assert.equal(sniffImage(Buffer.from('%PDF-1.7')), '');
});

test('decodeImage takes base64 or a data: URL and refuses anything else', () => {
  assert.equal(decodeImage(PNG.toString('base64')).ext, 'png');
  assert.equal(decodeImage(`data:image/jpeg;base64,${JPG.toString('base64')}`).ext, 'jpg');
  assert.throws(() => decodeImage(''), /No image/);
  assert.throws(() => decodeImage('not base64!'), /could not be read/);
  assert.throws(() => decodeImage(Buffer.from('hello').toString('base64')), /Only PNG, JPEG, GIF or WebP/);
  assert.throws(() => decodeImage('A'.repeat(12 * 1024 * 1024)), /too large/);
});

test('saveImage writes a private file that resolveImages finds again', async () => {
  const dir = tmp();
  const id = await saveImage(dir, PNG.toString('base64'), new Date('2026-11-18T10:00:00Z'));
  assert.match(id, /^2026-11-18\/[a-f0-9]{24}\.png$/);
  const [img] = resolveImages(dir, [id]);
  assert.equal(img.path, path.join(dir, id));
  assert.equal(img.mime, 'image/png');
  assert.deepEqual(fs.readFileSync(img.path), PNG);
  assert.equal(fs.statSync(img.path).mode & 0o777, 0o600);
});

test('resolveImages refuses ids that could name other files, repeats, missing files and too many', async () => {
  const dir = tmp();
  assert.deepEqual(resolveImages(dir, undefined), []);
  assert.deepEqual(resolveImages(dir, []), []);
  for (const bad of ['../pin', '2026-11-18/../../pin', '/etc/passwd', '2026-11-18/abc.png', '2026-11-18/aaaaaaaaaaaaaaaaaaaaaaaa.svg']) {
    assert.throws(() => resolveImages(dir, [bad]), /not sent correctly/, bad);
  }
  assert.throws(() => resolveImages(dir, 'x'), /not sent correctly/);
  assert.throws(() => resolveImages(dir, ['2026-11-18/aaaaaaaaaaaaaaaaaaaaaaaa.png']), /no longer on the computer/);
  const id = await saveImage(dir, PNG.toString('base64'));
  assert.throws(() => resolveImages(dir, [id, id]), /twice/);
  assert.throws(() => resolveImages(dir, Array.from({ length: MAX_IMAGES + 1 }, (_, i) => `${i}`)), /at most/);
});

test('imageNote lists the files for agents that open images by path', () => {
  assert.equal(imageNote([]), '');
  assert.match(imageNote([{ path: '/x/a.png' }]), /An image is attached[\s\S]*\n\/x\/a\.png$/);
  assert.match(imageNote([{ path: '/x/a.png' }, { path: '/x/b.jpg' }]), /2 images are attached[\s\S]*\/x\/a\.png\n\/x\/b\.jpg$/);
});

test('pruneImages removes only day folders older than 30 days', async () => {
  const dir = tmp();
  for (const d of ['2026-09-01', '2026-10-20', '2026-11-18', 'keep-me']) fs.mkdirSync(path.join(dir, d));
  assert.equal(await pruneImages(dir, new Date('2026-11-18T12:00:00Z')), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-10-20', '2026-11-18', 'keep-me']);
  assert.equal(await pruneImages(path.join(dir, 'missing')), 0);
});
