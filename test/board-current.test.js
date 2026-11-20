import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageIsCurrent } from '../lib/board.js';

// The page checks every 5 s but the board only changes every 30 s: an unchanged board is answered with no body.
test('pageIsCurrent: only the same read for the same time window counts as current', () => {
  const snap = { generatedAt: 1700000000000 };
  assert.equal(pageIsCurrent(snap, '1700000000000:7d', '7d'), true);
  assert.equal(pageIsCurrent(snap, '1700000000000:7d', 'today'), false, 'another window needs its own cards');
  assert.equal(pageIsCurrent(snap, '1699999999999:7d', '7d'), false, 'an older read');
  assert.equal(pageIsCurrent(snap, null, '7d'), false, 'first load');
  assert.equal(pageIsCurrent({ generatedAt: 0 }, '0:7d', '7d'), false, 'nothing read yet');
});
