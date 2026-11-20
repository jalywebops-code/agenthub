// Usage limits: when an agent stops because its account hit a usage limit, read when the limit resets
// from the agent's own message, so the card can offer "Continue at <reset>".
//
// Claude Code writes, as the chat's last reply:
//   "You've hit your 5-hour limit · resets 3:10pm (America/New_York)"
//   "You've hit your weekly limit · resets Nov 21, 9am (America/New_York)"   (a date when the reset isn't today)
// and older versions "5-hour limit reached ∙ resets 3pm" or "Claude AI usage limit reached|<unix seconds>".
// Codex writes "You've hit your usage limit. … try again at 3:05 PM." or "… try again in 2 hours 13 minutes."
// (Codex's wording is from its public messages; it has not been seen on this computer yet.)

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Minutes east of UTC for `zone` at the instant `t` (ms). */
function zoneOffsetMin(t, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
}

/** The calendar day (y, m 0-based, d) it is in `zone` at instant `t`. */
function dayIn(t, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day };
}

/** The instant (ms) of a wall-clock time in `zone`. */
function wallTime({ y, m, d, h, min }, zone) {
  const guess = Date.UTC(y, m, d, h, min);
  const first = guess - zoneOffsetMin(guess, zone) * 60000;
  return guess - zoneOffsetMin(first, zone) * 60000; // a second pass settles a daylight-saving change
}

/** "3:10pm" / "2am" / "3:05 PM" → { h, min } in 24 hours, or null. */
function clockOf(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(text.trim());
  if (!m) return null;
  let h = +m[1] % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  return { h, min: +(m[2] || 0) };
}

/**
 * When a "resets …" phrase means, as seen from `at` (when the agent wrote it) in `zone`: today's time, or the next
 * day's if that has passed; a date ("Nov 21, 9am") is taken as given.
 */
function resetInstant(phrase, zone, at) {
  const dated = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?(.+)$/i.exec(phrase.trim());
  if (dated && MONTHS.includes(dated[1].toLowerCase())) {
    const clock = clockOf(dated[3]);
    if (!clock) return null;
    const today = dayIn(at, zone);
    const m = MONTHS.indexOf(dated[1].toLowerCase());
    const y = m < today.m - 6 ? today.y + 1 : today.y; // "Jan 2" written in late December
    return wallTime({ y, m, d: +dated[2], ...clock }, zone);
  }
  const clock = clockOf(phrase);
  if (!clock) return null;
  const today = dayIn(at, zone);
  let t = wallTime({ ...today, ...clock }, zone);
  if (t <= at) t = wallTime({ ...dayIn(at + 24 * 3600e3, zone), ...clock }, zone);
  return t;
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const validZone = (z) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };

/**
 * The usage limit an agent's last reply reports, or null: { label, resetsAt } (resetsAt in ms; 0 when the message
 * gives no time). `at` is when the reply was written; `zone` the computer's time zone when the message names none.
 */
export function limitOf(reply, at = Date.now(), zone = localZone()) {
  const text = String(reply || '').trim();
  if (!text || text.length > 600) return null; // a limit notice is one short line, never a long report

  let m = /hit your ([\w\s-]*?)\s*limit\s*[·∙•.,-]?\s*resets\s+(.+?)\s*(?:\(([^)]+)\))?\s*\.?$/i.exec(text)
    || /^([\w\s-]*?)\s*limit reached\s*[·∙•.,-]?\s*resets\s+(.+?)\s*(?:\(([^)]+)\))?\s*\.?$/i.exec(text);
  if (m) {
    const tz = m[3] && validZone(m[3]) ? m[3] : zone;
    const label = `${(m[1] || 'usage').trim() || 'usage'} limit`;
    return { label, resetsAt: resetInstant(m[2], tz, at) || 0 };
  }
  m = /usage limit reached\|(\d{9,11})/i.exec(text);
  if (m) return { label: 'usage limit', resetsAt: +m[1] * 1000 };
  if (/hit your usage limit|usage limit reached|rate limit reached/i.test(text)) {
    const atClock = /try again at\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i.exec(text);
    if (atClock) return { label: 'usage limit', resetsAt: resetInstant(atClock[1], zone, at) || 0 };
    const inTime = /try again in\s+(?:(\d+)\s*days?)?[\s,]*(?:(\d+)\s*hours?)?[\s,]*(?:(\d+)\s*min(?:ute)?s?)?/i.exec(text);
    if (inTime && (inTime[1] || inTime[2] || inTime[3])) {
      return { label: 'usage limit', resetsAt: at + ((+inTime[1] || 0) * 1440 + (+inTime[2] || 0) * 60 + (+inTime[3] || 0)) * 60000 };
    }
    return { label: 'usage limit', resetsAt: 0 };
  }
  return null;
}

/** When to send Continue after a reset: two minutes later, so the account is surely open again. */
export const RESET_MARGIN_MS = 2 * 60 * 1000;
