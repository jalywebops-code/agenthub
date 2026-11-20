import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipTail, replyEnd } from '../lib/util.js';

test('clipTail keeps short text', () => {
  assert.equal(clipTail('Which one?'), 'Which one?');
});

test('clipTail keeps the end', () => {
  const long = `${'Some earlier work was done here. '.repeat(60)}Which exporter should I use?`;
  const out = clipTail(long);
  assert.ok(out.endsWith('Which exporter should I use?'));
  assert.ok(out.startsWith('…'));
  assert.ok(out.length <= 601, `length ${out.length}`);
});

test('replyEnd returns the last paragraph', () => {
  assert.equal(replyEnd('Done the refactor.\n\nShould I also update the tests?'), 'Should I also update the tests?');
});

test('replyEnd keeps the question above a trailing code block / sign-off', () => {
  assert.ok(replyEnd('Which file?\n\n```\nfoo\n```').includes('Which file?'));
  assert.ok(replyEnd('Should I merge it?\n\nLet me know!').includes('Should I merge it?'));
});

test('replyEnd keeps the intro of a trailing list', () => {
  const out = replyEnd('Two options:\n1. Patch\n2. Switch');
  assert.ok(out.includes('Two options:'));
  assert.ok(out.includes('2. Switch'));
});

test('replyEnd is empty for no reply', () => {
  assert.equal(replyEnd(''), '');
});

test('replyEnd skips a long sign-off after the question', () => {
  const out = replyEnd("Should I refactor the exporter now?\n\nLet me know if you'd like any other changes before I proceed.");
  assert.ok(out.includes('Should I refactor the exporter now?'), out);
});

test('replyEnd skips a sign-off after a trailing code block', () => {
  const out = replyEnd('Which file should I edit?\n\n```\nfoo\n```\n\nThanks!');
  assert.ok(out.includes('Which file should I edit?'), out);
});

test('findLinks finds a local .html file given right after a label and colon (Hermes "MEDIA:")', async () => {
  const os = await import('node:os');
  const { findLinks } = await import('../lib/preview.js');
  assert.deepEqual(findLinks('MEDIA:/Users/you/boards/demo/comparison.html'), ['/Users/you/boards/demo/comparison.html']);
  assert.deepEqual(findLinks('Open ~/site/dist/index.html now'), [`${os.homedir()}/site/dist/index.html`]);
});
