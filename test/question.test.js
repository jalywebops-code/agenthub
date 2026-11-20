import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectPrompt } from '../lib/tmux.js';
import { questionFromMenu, questionFromReply, checkChoice, replyChoiceMessage, stillAsking } from '../lib/choices.js';
import { fakeTmux } from './helpers/fake-tmux.js';

// Never a real tmux: every command is recorded instead.
fakeTmux();

const screen = (name) => fs.readFileSync(new URL(`./fixtures/menus/${name}.txt`, import.meta.url), 'utf8').replace(/\s+$/g, '');
const REPLY = 'Which exporter?\n1. Patch the CSV writer\n2. Switch to the shared exporter';

test('menu without yes/no becomes a question', () => {
  const q = questionFromMenu(detectPrompt(screen('claude-single')));
  assert.equal(q.kind, 'menu');
  assert.deepEqual(q.options.slice(0, 3), ['Apple', 'Banana', 'Mango']);
  assert.equal(q.freeText, 3);
  assert.equal(q.text, 'Which fruit should we use for this AgentHub test?');
  assert.equal(q.unsupported, '');
});

test('permission menu is not a question', () => {
  assert.equal(questionFromMenu(detectPrompt(screen('claude-trust'))), null);
  assert.equal(questionFromMenu(null), null);
});

test('unsupported menus still become a question that says so', () => {
  assert.match(questionFromMenu(detectPrompt(screen('codex-numbered'))).unsupported, /update menu/);
});

test('reply options become a question', () => {
  const q = questionFromReply(REPLY, 'Which exporter?\n1. Patch…');
  assert.equal(q.kind, 'reply');
  assert.deepEqual(q.options, ['Patch the CSV writer', 'Switch to the shared exporter']);
  assert.equal(q.expect, 'Which exporter?\n1. Patch…');
  assert.equal(replyChoiceMessage(q, 1), '2) Switch to the shared exporter');
  assert.equal(questionFromReply('All done.', 'All done.'), null);
});

test('choose route refuses a stale expect', () => {
  const card = { question: questionFromReply(REPLY, 'end') };
  assert.match(checkChoice(card, { expect: 'other', pick: 0, confirm: true }), /question changed/);
  assert.match(checkChoice(card, { expect: 'end', pick: 9, confirm: true }), /not on the card/);
  assert.match(checkChoice(card, { expect: 'end', pick: [0, 1], confirm: true }), /not on the card/);
  assert.match(checkChoice(card, { expect: 'end', pick: 0 }), /Not confirmed/);
  assert.match(checkChoice({}, { expect: 'end', pick: 0, confirm: true }), /no question/);
  assert.equal(checkChoice(card, { expect: ' end ', pick: 1, confirm: true }), null);
});

test('choose route refuses the free-text row and unsupported questions', () => {
  const single = { question: questionFromMenu(detectPrompt(screen('claude-single'))) };
  assert.match(checkChoice(single, { expect: single.question.expect, pick: 3, confirm: true }), /Type your answer/);
  const update = { question: questionFromMenu(detectPrompt(screen('codex-numbered'))) };
  assert.match(checkChoice(update, { expect: update.question.expect, pick: 1, confirm: true }), /can't be answered from the board/);
});

test('multi questions take a list of picks', () => {
  const card = { question: { kind: 'clarify', text: 'Colours?', options: ['Red', 'Green', 'Blue'], multi: true, freeText: -1, unsupported: '', expect: 'Colours?' } };
  assert.equal(checkChoice(card, { expect: 'Colours?', pick: [0, 2], confirm: true }), null);
  assert.match(checkChoice(card, { expect: 'Colours?', pick: [], confirm: true }), /not on the card/);
  assert.match(checkChoice(card, { expect: 'Colours?', pick: [0, 0], confirm: true }), /not on the card/);
});

const yesQuestion = () => screen('claude-single')
  .replace('1. Apple', '1. Yes, only the tests').replace('2. Banana', '2. Yes, everything').replace('3. Mango', '3. No, leave it');

test('a question-tool menu with "Yes…" options is still a question', () => {
  const q = questionFromMenu(detectPrompt(yesQuestion()));
  assert.ok(q, 'question built');
  assert.deepEqual(q.options.slice(0, 3), ['Yes, only the tests', 'Yes, everything', 'No, leave it']);
});

test('the Codex update menu is never answerable from the board', () => {
  const q = questionFromMenu(detectPrompt(screen('codex-numbered')));
  assert.notEqual(q.unsupported, '');
  assert.match(checkChoice({ question: q }, { expect: q.expect, pick: 0, confirm: true }), /can't be answered from the board/);
});

test('stillAsking: only when the agent spoke last and its reply end is unchanged', () => {
  const end = 'Which exporter?\n1. Patch the CSV writer\n2. Switch to the shared exporter';
  assert.equal(stillAsking([{ role: 'you', text: 'go' }, { role: 'agent', text: `Some work.\n\n${end}` }], end), true);
  assert.equal(stillAsking([{ role: 'agent', text: end }, { role: 'you', text: '2) Switch' }], end), false);
  assert.equal(stillAsking([{ role: 'agent', text: 'Done. Anything else?' }], end), false);
  assert.equal(stillAsking([], end), false);
});

test('plan approval becomes a question with all its options', () => {
  const q = questionFromMenu(detectPrompt(screen('claude-plan-approval')));
  assert.deepEqual(q.options, ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change']);
  assert.equal(q.freeText, 2);
  assert.equal(q.planApproval, true);
});

test('a typed answer is accepted only on the free-text row with text', () => {
  const card = { question: questionFromMenu(detectPrompt(screen('claude-single'))) };
  const e = card.question.expect;
  assert.equal(checkChoice(card, { expect: e, pick: 3, text: 'Kiwi', confirm: true }), null);
  assert.match(checkChoice(card, { expect: e, pick: 3, text: '  ', confirm: true }), /Type your answer/);
  assert.match(checkChoice(card, { expect: e, pick: 0, text: 'Kiwi', confirm: true }), /only for/);
});

test('a pick-several menu takes a list of picks', () => {
  const card = { question: questionFromMenu(detectPrompt(screen('claude-multi'))) };
  assert.equal(card.question.multi, true);
  assert.equal(checkChoice(card, { expect: card.question.expect, pick: [0, 2], confirm: true }), null);
  assert.match(checkChoice(card, { expect: card.question.expect, pick: [3], confirm: true }), /not on the card/);
});

test('an unanswerable menu is still a question (so Approve is never offered for it)', () => {
  const s = screen('claude-single').replace('1. Apple', '1. Yes, deploy now').replace('4. Type something.', '4. Kiwi');
  const q = questionFromMenu(detectPrompt(s));
  assert.ok(q);
  assert.notEqual(q.unsupported, '');
});
