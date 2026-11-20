// Suggested reply: when you open Reply / Answer on a card that needs you, the box comes
// pre-filled with the reply you'd most likely send, like Claude Code's Tab suggestion. Written by the same one-shot,
// tool-less side chat Ask uses, only when you ask for it (never in the background), and cached per agent message.
import crypto from 'node:crypto';
import { config } from './config.js';
import { CLAUDE_IDS } from './names.js';

const MAX = 300;

/** What the side chat is asked: the end of the agent's message, its question and its choices, and how to answer. */
export function suggestPrompt(card) {
  const end = String(card.lastReply || card.replyEnd || '').slice(-1500);
  const options = card.question?.options?.length ? `\nChoices it offered: ${card.question.options.join(' / ')}` : '';
  return [
    'You draft the next message the user will send to one of their AI agents. The user is busy and direct: short, plain words.',
    `The chat is "${card.title || ''}". The agent's last message ends with:`,
    '"""', end, '"""',
    card.ask ? `It asks: ${card.ask}${options}` : options,
    'Write the single reply the user would most likely send next (usually one short sentence; if it asks to go ahead or',
    'confirm, a short go-ahead; if it offers choices, pick the sensible one in plain words).',
    'Output only the reply text: no quotes, no label, no explanation.',
  ].filter(Boolean).join('\n');
}

/** The side chat's answer as one plain reply: no quotes or "Reply:" label, trimmed, at most 300 characters. */
export function cleanSuggestion(text) {
  let s = String(text || '').trim().replace(/^(suggested )?reply:\s*/i, '').trim();
  if (/^["“'].*["”']$/s.test(s)) s = s.slice(1, -1).trim();
  return s.slice(0, MAX);
}

/** One suggestion per agent message: the key changes when the agent says something new. */
export function suggestKey(card) {
  const h = crypto.createHash('sha1').update(String(card.replyEnd || card.lastReply || '')).digest('hex').slice(0, 16);
  return `${card.id}:${h}`;
}

/**
 * Which agent writes it: the account chosen in Settings (`chosen`) when it is still on; otherwise a Claude Code
 * account's cards on that same account and everything else on the first Claude Code account in the setup.
 * `ids` / `first` / `chosen` default to this install's setup (tests pass their own).
 */
export function suggestAgent(card, ids = CLAUDE_IDS, first = config.claudeAccounts[0]?.id, chosen = config.suggest.agent) {
  if (chosen && ids.has(chosen)) return chosen;
  return ids.has(card.harness) ? card.harness : first;
}
