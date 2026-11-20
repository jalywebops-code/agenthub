// Reading when a usage limit resets from the agent's own message (lib/limits.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitOf } from '../lib/limits.js';

const NY = 'America/New_York';
// 1:00 pm in New York on 19 Nov 2026 (UTC-5).
const at = Date.UTC(2026, 10, 19, 18, 0);
const ny = (d, h, min = 0) => Date.UTC(2026, 10, d, h + 5, min); // a New York wall time in November

test('Claude Code: a 5-hour limit that resets later today, in the zone it names', () => {
  assert.deepEqual(limitOf("You've hit your 5-hour limit · resets 3:10pm (America/New_York)", at, 'UTC'), { label: '5-hour limit', resetsAt: ny(19, 15, 10) });
});

test('a reset time already past today means tomorrow', () => {
  assert.deepEqual(limitOf("You've hit your 5-hour limit · resets 2am (America/New_York)", at, 'UTC'), { label: '5-hour limit', resetsAt: ny(20, 2) });
});

test('a weekly limit with a date', () => {
  assert.deepEqual(limitOf("You've hit your weekly limit · resets Nov 21, 9am (America/New_York)", at, 'UTC'), { label: 'weekly limit', resetsAt: ny(21, 9) });
});

test('no zone in the message: the computer\'s zone', () => {
  assert.equal(limitOf('5-hour limit reached ∙ resets 3pm', at, NY).resetsAt, ny(19, 15));
});

test('the older "usage limit reached|<seconds>" form', () => {
  assert.deepEqual(limitOf('Claude AI usage limit reached|1795100400', at), { label: 'usage limit', resetsAt: 1795100400000 });
});

test('Codex: try again at a time, or in a while', () => {
  assert.equal(limitOf("You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.", at, NY).resetsAt, ny(19, 15, 5));
  assert.equal(limitOf("You've hit your usage limit. Try again in 2 hours 13 minutes.", at, NY).resetsAt, at + (2 * 60 + 13) * 60000);
});

test('a limit with no time given is still a limit (no reset known)', () => {
  assert.deepEqual(limitOf("You've hit your usage limit.", at, NY), { label: 'usage limit', resetsAt: 0 });
});

test('daylight saving: a reset after the clocks change uses the new offset', () => {
  // 31 Oct 2026, 11 pm New York (UTC-4); 2 am on 1 Nov is still before the change (which happens at 2 am).
  const before = Date.UTC(2026, 10, 1, 3, 0);
  assert.equal(limitOf("You've hit your 5-hour limit · resets 9am (America/New_York)", before, 'UTC').resetsAt, Date.UTC(2026, 10, 1, 14, 0));
});

test('ordinary replies are not limits', () => {
  assert.equal(limitOf('Done. The tests pass and the page is live.', at), null);
  assert.equal(limitOf('I added rate limiting to the login endpoint: 10 attempts per minute.', at), null);
  assert.equal(limitOf(`${'A long report. '.repeat(60)}You've hit your 5-hour limit · resets 3pm`, at), null);
});
