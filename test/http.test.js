import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodeBody } from '../lib/http.js';

const big = JSON.stringify({ cards: Array.from({ length: 200 }, (_, i) => ({ id: i, title: 'A chat title', reply: 'Some reply text '.repeat(10) })) });

test('large JSON is gzipped when the browser accepts it, and decodes back the same', () => {
  const { body, headers } = encodeBody(big, 'gzip, deflate, br');
  assert.equal(headers['Content-Encoding'], 'gzip');
  assert.ok(body.length < big.length / 5, `${body.length} vs ${big.length}`);
  assert.equal(zlib.gunzipSync(body).toString(), big);
});

test('no gzip when not accepted or the body is small', () => {
  assert.equal(encodeBody(big, '').headers['Content-Encoding'], undefined);
  assert.equal(encodeBody('{"ok":true}', 'gzip').headers['Content-Encoding'], undefined);
});
