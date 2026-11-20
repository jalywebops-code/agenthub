import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyOptions, optionMessage, questionFromReply } from '../lib/choices.js';

test('replyOptions finds a numbered choice', () => {
  const r = replyOptions('Which exporter?\n1. Patch the CSV writer\n2. Switch to the shared exporter');
  assert.equal(r.text, 'Which exporter?');
  assert.deepEqual(r.options, [{ key: '1', label: 'Patch the CSV writer' }, { key: '2', label: 'Switch to the shared exporter' }]);
});

test('replyOptions finds lettered options with the question after', () => {
  const r = replyOptions('A) Keep it\nB) Remove it\n\nWhich do you prefer?');
  assert.deepEqual(r.options.map((o) => o.key), ['A', 'B']);
  assert.equal(r.text, 'Which do you prefer?');
});

test('replyOptions ignores a numbered report', () => {
  assert.equal(replyOptions("Here's what I did:\n1. Fixed the parser\n2. Added tests"), null);
});

test('replyOptions ignores one item and more than six', () => {
  assert.equal(replyOptions('Which one?\n1. Only this'), null);
  const seven = ['Pick one?', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `${n}. Item ${n}`)].join('\n');
  assert.equal(replyOptions(seven), null);
});

test('replyOptions numbers bullets', () => {
  const r = replyOptions('Want me to:\n- ship it\n- wait');
  assert.deepEqual(r.options.map((o) => o.key), ['1', '2']);
});

test('optionMessage formats the reply', () => {
  assert.equal(optionMessage({ key: 'B', label: 'Remove it' }), 'B) Remove it');
});

test('replyOptions ignores a report followed by an unrelated question', () => {
  assert.equal(replyOptions("Here's what I did:\n1. Fixed the parser\n2. Added tests\n\nWant me to open a PR?"), null);
  assert.equal(replyOptions("Summary:\n- Renamed the module\n- Updated imports\n\nAnything else you'd like me to look at?"), null);
});

test('replyOptions keeps a real choice asked after the list', () => {
  assert.ok(replyOptions('A) Keep it\nB) Remove it\n\nShould I keep it or remove it?'));
});

test('inlineOptions: choices written inside the question sentence', async () => {
  const { inlineOptions } = await import('../lib/choices.js');
  assert.deepEqual(inlineOptions('The GitHub setup is done. Which one should I take next: the OpenClaw reply test, tmux reply verification, or the Pi display?'),
    ['the OpenClaw reply test', 'tmux reply verification', 'the Pi display']);
  assert.deepEqual(inlineOptions('Should I use the header design or the sidebar?'), ['use the header design', 'the sidebar']);
  assert.deepEqual(inlineOptions('Can I open a separate Chrome window?'), []);
  assert.deepEqual(inlineOptions('I fixed the parser, the tests, and the docs.'), []);
  assert.deepEqual(inlineOptions('Should I merge it or not?'), []);
});

test('inlineOptions: "Did you mean A, B, or C?" (the real Hermes card, bold choices)', async () => {
  const { inlineOptions } = await import('../lib/choices.js');
  const ask = '“Approved. Go ahead.” doesn’t identify the next action, so I haven’t changed anything. Did you mean **test the board’s two-tap OpenClaw UI**, move to **tmux replies**, or start the **Pi display**?';
  assert.deepEqual(inlineOptions(ask), ['test the board’s two-tap OpenClaw UI', 'move to tmux replies', 'start the Pi display']);
  assert.deepEqual(inlineOptions('Do you want the dark theme, the light theme, or both?'), ['the dark theme', 'the light theme', 'both']);
  assert.deepEqual(inlineOptions('Would you prefer Postgres or SQLite?'), ['Postgres', 'SQLite']);
  // Not choices: a plain yes/no question, and a comma inside one thing.
  assert.deepEqual(inlineOptions('Did you mean the file I sent yesterday?'), []);
  assert.deepEqual(inlineOptions('Do you want me to fix the parser, then run the tests?'), []);
});

test('questionFromReply falls back to inline options and sends the option text', () => {
  const reply = 'The GitHub setup is done.\n\nWhich one should I take next: the OpenClaw reply test, tmux reply verification, or the Pi display?';
  const q = questionFromReply(reply, 'END');
  assert.equal(q.kind, 'reply');
  assert.deepEqual(q.options, ['the OpenClaw reply test', 'tmux reply verification', 'the Pi display']);
  assert.equal(q.expect, 'END');
  assert.equal(optionMessage({ key: '', label: 'the Pi display' }), 'the Pi display');
});
