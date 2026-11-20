// Just enough PNG reading to find where an icon's artwork is (8-bit, non-interlaced, the kind `sips` writes).
// No dependencies: Node's own zlib does the decompression.
import zlib from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }; // grey, RGB, grey + alpha, RGBA

/** Decode a PNG into { width, height, channels, pixel(x, y) → [r, g, b, a] }. Throws on a kind it can't read. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0 || !CHANNELS[data[9]]) throw new Error('unsupported PNG (needs 8-bit, not interlaced)');
      channels = CHANNELS[data[9]];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  // Undo each row's filter (PNG spec 9.2): None, Sub, Up, Average, Paeth.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  const pixel = (x, y) => {
    const i = (y * width + x) * channels;
    if (channels === 4) return px.subarray(i, i + 4);
    if (channels === 3) return [px[i], px[i + 1], px[i + 2], 255];
    if (channels === 2) return [px[i], px[i], px[i], px[i + 1]];
    return [px[i], px[i], px[i], 255];
  };
  return { width, height, channels, pixel };
}

/**
 * The artwork inside an icon: the smallest square, centred on everything not (nearly) transparent, kept inside the
 * image. { x, y, size } in pixels; the whole image when there is no margin or nothing visible.
 */
export function artBox(img) {
  const { width: w, height: h, pixel } = img;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixel(x, y)[3] > 16) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, size: Math.min(w, h) };
  const size = Math.min(Math.max(x1 - x0 + 1, y1 - y0 + 1), w, h);
  const clamp = (v, max) => Math.max(0, Math.min(v, max - size));
  return { x: clamp(Math.round((x0 + x1 + 1 - size) / 2), w), y: clamp(Math.round((y0 + y1 + 1 - size) / 2), h), size };
}
