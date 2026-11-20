// Multiple-choice questions on cards: options an agent wrote at the end of its reply.
// Only a shortcut for typing the answer; nothing here ever sends on its own.
import { replyEnd, askOf } from './util.js';

const ITEM = /^\s*(?:(\d+)[.)]|([A-Za-z])[.)]|([-•*]))\s+(\S.*)$/;
const ASKS = /\b(which|prefer|choose|pick|option|should i|want me to)\b/i;
// A question AFTER the list must ask between the items, not just be any question ("Want me to open a PR?" isn't one).
const CHOICE = /\b(which|prefer|choose|pick|option|either)\b|\bor\b/i;
const asks = (l) => l.endsWith('?') || ASKS.test(l);
const MAX_OPTIONS = 6;

function styleOf(m) {
  return m[1] ? 'number' : (m[2] ? 'letter' : 'bullet');
}

/**
 * Options listed at the end of a reply, when they are a question: the line before or after the list asks
 * (ends in "?" or says which/prefer/choose/…). 2 to 6 items. Returns { text, options: [{ key, label }] } or null.
 */
export function replyOptions(text) {
  let t = String(text || '').replace(/[ \t]+\n/g, '\n').trim();
  while (t.endsWith('```')) {
    const open = t.lastIndexOf('```', t.length - 4);
    if (open === -1) break;
    t = t.slice(0, open).trim();
  }
  const lines = t.split('\n');
  // The list must be near the end: at most two non-empty lines after it (the question, a sign-off).
  let last = -1;
  let after = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ITEM.test(lines[i])) { last = i; break; }
    if (lines[i].trim()) after.unshift(lines[i].trim());
    if (after.length > 2) return null;
  }
  if (last === -1) return null;
  let first = last;
  while (first > 0 && ITEM.test(lines[first - 1])) first--;
  const matches = lines.slice(first, last + 1).map((l) => ITEM.exec(l));
  if (matches.length < 2 || matches.length > MAX_OPTIONS) return null;
  const style = styleOf(matches[0]);
  if (!matches.every((m) => styleOf(m) === style)) return null;

  const intro = lines.slice(Math.max(0, first - 2), first).map((l) => l.trim()).filter(Boolean).pop() || '';
  // A list introduced as a report ("Here's what I did:", "Summary:") is never a choice.
  if (intro && !asks(intro)) return null;
  const question = after.find((l) => l.endsWith('?') && CHOICE.test(l))
    || (intro && asks(intro) ? intro : '')
    || '';
  if (!question) return null;

  const options = matches.map((m, i) => ({
    key: m[1] || (m[2] ? m[2] : String(i + 1)),
    label: m[4].trim(),
  }));
  return { text: question, options };
}

/** The reply sent when you tap an option, e.g. "B) Remove it" (just the text for options written inline). */
export function optionMessage(opt) {
  return opt.key ? `${opt.key}) ${opt.label}` : opt.label;
}

/**
 * Choices written inside the question sentence itself: "Which should I take next: A, B, or C?" (a colon list) or
 * "Should I A or B?", "Did you mean A, B, or C?". Returns [] when the last question has none ("or not" doesn't count).
 */
export function inlineOptions(text) {
  const plain = String(text || '').replace(/\*\*|__|`/g, '');
  const questions = plain.match(/[^.!?\n]*\?/g);
  const q = (questions ? questions[questions.length - 1] : '').trim();
  if (!q) return [];
  const clean = (list) => {
    const out = list.map((o) => o.replace(/^(or|and)\s+/i, '').replace(/\?$/, '').trim()).filter(Boolean);
    return out.length >= 2 && out.length <= 6 && out.every((o) => o.length <= 80 && !/^(not|no)$/i.test(o)) ? out : [];
  };
  const colon = /:\s*(.+)\?$/.exec(q);
  if (colon && /,|\bor\b/.test(colon[1])) return clean(colon[1].split(/\s*,\s*(?:or\s+|and\s+)?|\s+or\s+/));
  // "Should I A or B?", "Did you mean A, B, or C?", "Would you prefer A or B?": the list after the lead words.
  const lead = /^(?:should i|shall i|did you mean|do you mean|(?:do|did) you want(?: me)? to|do you want|would you like(?: me)? to|would you prefer|do you prefer|want me to)\s+(.+)\?$/i.exec(q);
  if (!lead || !/\bor\b/.test(lead[1])) return [];
  return clean(lead[1].split(/\s*,\s*(?:or\s+)?|\s+or\s+/));
}

const normalize = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/**
 * A terminal menu as a card question, or null. Yes/No permission menus stay with Approve / Changes.
 * `options` keeps every menu row in key order; `freeText` marks the "Type something" row the board never picks.
 */
export function questionFromMenu(prompt) {
  if (!prompt) return null;
  // A question tool's menu (it has a free-text row) or a plan approval is a question even with "Yes" options;
  // plain Yes/No permission menus stay with Approve / Changes.
  // A menu marked not answerable stays a question too, so the card says "answer it in the terminal" and never
  // offers Approve on it.
  if (!prompt.unsupported && prompt.yes !== -1 && prompt.freeText === -1 && !prompt.planApproval) return null;
  return {
    kind: 'menu',
    text: prompt.review || prompt.question || '',
    options: prompt.labels || prompt.options,
    multi: !!prompt.multi,
    freeText: prompt.freeText ?? -1,
    planApproval: !!prompt.planApproval,
    unsupported: prompt.unsupported || '',
    expect: prompt.text,
  };
}

/** Options written at the end of a reply as a card question, or null. `expect` is the card's reply end. */
export function questionFromReply(lastReply, replyEndText) {
  const r = replyOptions(lastReply);
  if (!r) {
    // No list: choices written inside the question sentence ("…: A, B, or C?"), sent back as plain text.
    const ask = askOf(lastReply);
    const inline = ask ? inlineOptions(ask) : [];
    if (!inline.length) return null;
    const text = (ask.replace(/\*\*|__|`/g, '').match(/[^.!?\n]*\?/g) || [ask]).pop().trim();
    return { kind: 'reply', text, options: inline, keys: inline.map(() => ''), multi: false, freeText: -1,
      unsupported: '', expect: replyEndText || text };
  }
  return {
    kind: 'reply',
    text: r.text,
    options: r.options.map((o) => o.label),
    keys: r.options.map((o) => o.key),
    multi: false,
    freeText: -1,
    unsupported: '',
    expect: replyEndText || r.text,
  };
}

/** The reply sent for option `pick` of a reply question, e.g. "2) Switch to the shared exporter". */
export function replyChoiceMessage(q, pick) {
  return optionMessage({ key: q.keys[pick], label: q.options[pick] });
}

/**
 * True only if the agent's latest message is still the one whose end was shown (`expect`), i.e. nobody has
 * answered or moved the conversation on since. `msgs` are the lane's fresh recent messages, oldest first.
 */
export function stillAsking(msgs, expect) {
  const last = (msgs || []).filter((m) => String(m.text || '').trim()).pop();
  return !!last && last.role === 'agent' && normalize(replyEnd(last.text)) === normalize(expect);
}

/** Why an answer can't be sent (a message to show), or null when it is safe to send. */
export function checkChoice(card, body) {
  const q = card?.question;
  if (!q) return 'This card has no question to answer any more. Refresh.';
  if (body?.confirm !== true) return 'Not confirmed.';
  if (normalize(body.expect) !== normalize(q.expect)) return 'The question changed since you looked. Nothing was sent. Refresh.';
  if (q.unsupported) return `This question can't be answered from the board (${q.unsupported}). Answer it in the terminal.`;
  const pick = body.pick;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  // Your own words go only into the menu's free-text row ("Type something", "Tell Claude what to change").
  if (!q.multi && q.freeText !== -1 && pick === q.freeText) {
    if (!text) return 'Type your answer first.';
    return text.length > 2000 ? 'That answer is too long.' : null;
  }
  if (text) return 'Typed answers are only for the "type your own" row.';
  const valid = (i) => Number.isInteger(i) && i >= 0 && i < q.options.length && i !== q.freeText;
  const ok = q.multi
    ? Array.isArray(pick) && pick.length > 0 && new Set(pick).size === pick.length && pick.every(valid)
    : valid(pick);
  return ok ? null : 'That option is not on the card any more. Refresh.';
}
