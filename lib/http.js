// Response bodies: gzip larger JSON when the browser accepts it (the board's poll would otherwise send hundreds of KB
// every few seconds to the phone). Built-in zlib, no dependencies.
import zlib from 'node:zlib';

const MIN_GZIP = 1024;

/** The bytes to send and the extra headers for them. */
export function encodeBody(text, acceptEncoding) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
  if (buf.length < MIN_GZIP || !/\bgzip\b/.test(String(acceptEncoding || ''))) return { body: buf, headers: {} };
  return { body: zlib.gzipSync(buf), headers: { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } };
}
