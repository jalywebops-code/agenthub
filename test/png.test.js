import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, artBox } from '../lib/png.js';

/** A tiny RGBA PNG: transparent, with an opaque rectangle (rows filtered with "Sub" to exercise unfiltering). */
function makePng(w, h, rect) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // CRC unchecked by the reader
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const px = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) {
      if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) px.set([200, 100, 50, 255], x * 4);
    }
    const sub = Buffer.alloc(w * 4);
    for (let i = 0; i < px.length; i++) sub[i] = (px[i] - (i >= 4 ? px[i - 4] : 0)) & 255;
    rows.push(Buffer.from([1]), sub);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('decodePng reads an RGBA image back pixel for pixel', () => {
  const img = decodePng(makePng(8, 6, { x: 2, y: 1, w: 3, h: 2 }));
  assert.equal(img.width, 8);
  assert.equal(img.height, 6);
  assert.deepEqual([...img.pixel(3, 2)], [200, 100, 50, 255]);
  assert.equal(img.pixel(0, 0)[3], 0);
});

// App icons carry an empty margin (about 10% on a Mac), so logos looked smaller than their square on the board.
test('artBox finds the artwork as a centred square, ignoring the transparent margin', () => {
  assert.deepEqual(artBox(decodePng(makePng(100, 100, { x: 10, y: 12, w: 80, h: 76 }))), { x: 10, y: 10, size: 80 });
});

test('artBox keeps the whole image when there is no margin or nothing to see', () => {
  assert.deepEqual(artBox(decodePng(makePng(10, 10, { x: 0, y: 0, w: 10, h: 10 }))), { x: 0, y: 0, size: 10 });
  assert.deepEqual(artBox(decodePng(makePng(10, 10, { x: 0, y: 0, w: 0, h: 0 }))), { x: 0, y: 0, size: 10 });
});
