import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askOf, decisionsOf } from '../lib/util.js';

// Two numbered decisions with a "?" inside the list: the card used to show only item 2.
const TWO = 'Submit… opens the confirm screen.\n\nTwo things to decide:\n1. **Commit.** Should I commit this to `feature` together with the Submit… fix, as `feat: bigger cards (two per screen on phones, three on desktop), two-row desktop header; fix Submit… in reply boxes`?\n2. **Screenshot folder.** The browser tool saved its screenshots in a new `.playwright-mcp/` folder in the project. They show your card text, and git isn’t set to ignore that folder. Should I delete it and add it to `.gitignore` so it’s never committed?';

test('askOf keeps the intro and every item of a numbered list of questions', () => {
  const a = askOf(TWO);
  assert.match(a, /^Two things to decide:/);
  assert.match(a, /1\. \*\*Commit\.\*\*/);
  assert.match(a, /2\. \*\*Screenshot folder\.\*\*/);
  assert.ok(a.endsWith('never committed?'), a);
});

test('decisionsOf splits a list of questions into decisions with short labels', () => {
  const d = decisionsOf(askOf(TWO));
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => x.n), ['1', '2']);
  assert.deepEqual(d.map((x) => x.label), ['Commit', 'Screenshot folder']);
  assert.match(d[1].text, /^\*\*Screenshot folder\.\*\* The browser tool/);
});

test('decisionsOf keeps lines that continue an item, and labels plain items by their opening words', () => {
  const d = decisionsOf('I need two answers:\n1. Which host should we use for the API\n   and its preview builds?\n2) Keep the old domain?');
  assert.equal(d.length, 2);
  assert.match(d[0].text, /and its preview builds\?$/);
  assert.equal(d[1].label, 'Keep the old domain?');
  assert.equal(d[0].label, 'Which host should we use for…');
});

test('decisionsOf is empty for a single question or no list', () => {
  assert.deepEqual(decisionsOf('Should I use that design?'), []);
  assert.deepEqual(decisionsOf('One thing:\n1. Merge it?'), []);
  assert.deepEqual(decisionsOf(''), []);
});
