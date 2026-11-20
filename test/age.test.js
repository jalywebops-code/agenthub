import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardsForAge } from '../lib/status.js';

const now = new Date(2026, 10, 17, 15, 0, 0).getTime(); // 17 Nov 2026, 15:00 local
const day = 86400000;
const c = (id, status, ago) => ({ id, status, lastActivity: now - ago });
const ids = (cards) => cards.map((x) => x.id);

test('blocked and running always show; others by age', () => {
  const cards = [c('blocked-90d', 'blocked', 90 * day), c('working-90d', 'working', 90 * day), c('idle-8d', 'idle', 8 * day), c('idle-90d', 'idle', 90 * day)];
  assert.deepEqual(ids(cardsForAge(cards, '7d', now)), ['blocked-90d', 'working-90d']);
  assert.deepEqual(ids(cardsForAge(cards, '30d', now)), ['blocked-90d', 'working-90d', 'idle-8d']);
  assert.deepEqual(ids(cardsForAge(cards, 'all', now)), ['blocked-90d', 'working-90d', 'idle-8d', 'idle-90d']);
});

test('today means since local midnight', () => {
  const minuteAgo = c('m', 'idle', 60000);
  const lastNight = { id: 'y', status: 'idle', lastActivity: new Date(2026, 10, 16, 23, 0, 0).getTime() };
  assert.deepEqual(ids(cardsForAge([minuteAgo, lastNight], 'today', now)), ['m']);
});

test('an unknown age behaves as 7 days', () => {
  const cards = [c('idle-3d', 'idle', 3 * day), c('idle-8d', 'idle', 8 * day)];
  assert.deepEqual(ids(cardsForAge(cards, 'bogus', now)), ['idle-3d']);
});

test('review cards always show (they never outlive 24 h), even from before midnight under today', () => {
  const lastEvening = { id: 'r', status: 'review', lastActivity: new Date(2026, 10, 16, 20, 0, 0).getTime() };
  assert.deepEqual(ids(cardsForAge([lastEvening], 'today', now)), ['r']);
});
