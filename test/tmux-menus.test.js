import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectPrompt, act, _setCapture } from '../lib/tmux.js';
import { fakeTmux } from './helpers/fake-tmux.js';

// Never a real tmux: every command is recorded instead.
fakeTmux();

// Same trimming as capture() does on a live pane.
const screen = (name) => fs.readFileSync(new URL(`./fixtures/menus/${name}.txt`, import.meta.url), 'utf8').replace(/\s+$/g, '');

test('claude-single parses three options', () => {
  const p = detectPrompt(screen('claude-single'));
  assert.ok(p, 'menu detected');
  assert.deepEqual(p.options.slice(0, 3), ['Apple', 'Banana', 'Mango']);
  assert.equal(p.unsupported, '');
  assert.equal(p.selected, 0);
  assert.ok(!p.options.some((o) => /Crisp|Soft|Juicy|Chat about/.test(o)), 'descriptions and the chat row are not options');
});

test('free-text row is marked', () => {
  const p = detectPrompt(screen('claude-single'));
  assert.equal(p.freeText, 3);
  assert.match(p.options[3], /^Type something/);
});

// Pick-several and tabbed question sets are answered from the board now.
test('claude-multi is a pick-several menu, not refused', () => {
  const p = detectPrompt(screen('claude-multi'));
  assert.equal(p.unsupported, '');
  assert.equal(p.multi, true);
  assert.deepEqual(p.labels.slice(0, 3), ['Red', 'Green', 'Blue']);
  assert.equal(p.freeText, 3);
});

test('claude-tabs shows the current tab question, not refused', () => {
  assert.equal(detectPrompt(screen('claude-tabs')).unsupported, '');
  assert.equal(detectPrompt(screen('claude-plan-tabs-q1')).question, 'Which fruit do you want?');
  assert.equal(detectPrompt(screen('claude-tabs-q2')).question, 'Which size do you want?');
});

test('permission menu keeps yes/no', () => {
  const p = detectPrompt(screen('claude-trust'));
  assert.equal(p.yes, 1);
  assert.equal(p.unsupported, '');
  assert.equal(p.freeText, -1);
});

test('codex numbered menu is a menu without yes', () => {
  const p = detectPrompt(screen('codex-numbered'));
  assert.equal(p.options.length, 3);
  assert.equal(p.yes, -1);
});

test('choose refuses a changed menu', async () => {
  _setCapture(async () => screen('claude-single'));
  await assert.rejects(act('%1', { kind: 'choose', index: 1, expectPrompt: true, expectText: 'something else' }), /changed since you looked/);
});

test('choose refuses the free-text row and unsupported menus', async () => {
  _setCapture(async () => screen('claude-single'));
  const single = detectPrompt(screen('claude-single'));
  await assert.rejects(act('%1', { kind: 'choose', index: 3, expectPrompt: true, expectText: single.text }), /can't be answered from the board/);
  await assert.rejects(act('%1', { kind: 'choose', index: 9, expectPrompt: true, expectText: single.text }), /can't be answered from the board|no option/);
  _setCapture(async () => screen('claude-multi'));
  const multi = detectPrompt(screen('claude-multi'));
  await assert.rejects(act('%1', { kind: 'choose', index: 0, expectPrompt: true, expectText: multi.text }), /tick boxes/);
});

test('choose refuses the Codex update menu', async () => {
  _setCapture(async () => screen('codex-numbered'));
  const p = detectPrompt(screen('codex-numbered'));
  await assert.rejects(act('%1', { kind: 'choose', index: 0, expectPrompt: true, expectText: p.text }), /can't be answered from the board/);
});

test('approve refuses a question-tool menu even when an option starts with Yes', async () => {
  const s = screen('claude-single').replace('1. Apple', '1. Yes, only the tests');
  _setCapture(async () => s);
  await assert.rejects(act('%1', { kind: 'approve', expectPrompt: true, expectText: detectPrompt(s).text }), /question, not a permission prompt/);
});

// A long command: the "$ touch …" line becomes 15 lines, pushing the question far above the options.
const longCodex = () => screen('codex-approval').replace('  $ touch agenthub-approval-test.txt',
  ['  $ node -e "', ...Array.from({ length: 14 }, (_, i) => `    console.log('step ${i + 1} of a long command');`)].join('\n'));

test('codex approval: the request says what is asked and what will run', () => {
  const p = detectPrompt(screen('codex-approval'));
  assert.equal(p.request.ask, 'Would you like to run the following command?');
  assert.match(p.request.detail, /\$ touch agenthub-approval-test\.txt/);
  assert.match(p.request.detail, /Reason: /);
  assert.doesNotMatch(`${p.request.ask}\n${p.request.detail}`, /earlier lines cut/);
});

test('codex approval with a long command keeps the question and the whole command', () => {
  const p = detectPrompt(longCodex());
  assert.equal(p.request.ask, 'Would you like to run the following command?');
  assert.match(p.request.detail, /step 1 of a long command/);
  assert.match(p.request.detail, /step 14 of a long command/);
});

test('a command that contains its own question line is not summarised (falls back to the raw screen)', () => {
  const spoof = screen('codex-approval').replace('  $ touch agenthub-approval-test.txt',
    '  $ rm -rf ~/important && echo "\n  Would you like to run the following command?\n  $ touch harmless.txt"');
  assert.equal(detectPrompt(spoof).request, null);
});

test('planted tool or separator lines inside a command cannot narrow the summary', () => {
  const bullet = screen('codex-approval').replace('  $ touch agenthub-approval-test.txt',
    '  $ rm -rf ~/important\n• Running touch harmless.txt\n  Would you like to run the following command?\n  $ touch harmless.txt');
  assert.equal(detectPrompt(bullet).request, null);
  const sep = screen('codex-approval').replace('  $ touch agenthub-approval-test.txt',
    '  $ rm -rf ~/important\n────────────\n  $ touch harmless.txt');
  assert.equal(detectPrompt(sep).request, null);
});

test('plan approval menus are never pressed by Approve', async () => {
  for (const name of ['claude-plan-approval', 'codex-plan-approval']) {
    const p = detectPrompt(screen(name));
    assert.equal(p.planApproval, true, name);
    _setCapture(async () => screen(name));
    await assert.rejects(act('%1', { kind: 'approve', expectPrompt: true, expectText: p.text }), /plan approval/, name);
  }
  assert.equal(detectPrompt(screen('claude-plan-approval')).freeText, 2);
});

test('the review screen is a Submit / Cancel menu that shows the answers', () => {
  const p = detectPrompt(screen('claude-tabs-submit'));
  assert.deepEqual(p.labels, ['Submit answers', 'Cancel']);
  assert.match(p.review, /Review your answers/);
  assert.match(p.review, /→ Large/);
});

test('codex plan question labels drop the description', () => {
  assert.deepEqual(detectPrompt(screen('codex-plan-question')).labels, ['Apple (Recommended)', 'Banana', 'None of the above']);
});

test('typed answers only go into the free-text row of the same menu', async () => {
  const single = detectPrompt(screen('claude-single'));
  _setCapture(async () => screen('claude-single'));
  await assert.rejects(act('%1', { kind: 'type', index: 0, message: 'Kiwi', expectPrompt: true, expectText: single.text }), /free-text row/);
  await assert.rejects(act('%1', { kind: 'type', index: 3, message: 'Kiwi', expectPrompt: true, expectText: 'changed' }), /changed since you looked/);
});

test('pick-several refuses a changed menu and the free-text row', async () => {
  const multi = detectPrompt(screen('claude-multi'));
  _setCapture(async () => screen('claude-multi'));
  await assert.rejects(act('%1', { kind: 'multi', indexes: [0], expectPrompt: true, expectText: 'changed' }), /changed since you looked/);
  await assert.rejects(act('%1', { kind: 'multi', indexes: [3], expectPrompt: true, expectText: multi.text }), /free-text row|not on the menu/);
});

// Live incident (2026-11-17): with the highlight on the unnumbered "Next" row the menu wasn't seen, so End typed into it.
const onNext = () => screen('claude-multi-tab-freetext')
  .replace('❯ 4. [ ] /exit', '  4. [ ] Type something').replace(/^ {5}Next$/m, '❯    Next');

test('a menu whose highlight is on a row the board cannot read still counts as a menu', async () => {
  const p = detectPrompt(onNext());
  assert.ok(p, 'menu detected');
  _setCapture(async () => onNext());
  await assert.rejects(act('%1', { kind: 'reply', message: '/exit', expectPrompt: false, expectText: '' }), /menu/);
  const chat = screen('claude-single').replace('❯ 1. Apple', '  1. Apple').replace('  4. Chat about this', '❯ 4. Chat about this');
  assert.ok(detectPrompt(chat), 'highlight on "Chat about this" still a menu');
  assert.notEqual(detectPrompt(chat).unsupported, '');
});

test('a menu whose answer row already has text typed in it is not answered from the board', () => {
  const p = detectPrompt(screen('claude-multi-tab-freetext'));
  assert.equal(p.freeText, -1, 'never guessed by position');
  assert.match(p.unsupported, /already typed/);
});

// Final review (step 2) fixes.
test('a long command cannot push the real question out and fake its own summary', () => {
  const padding = Array.from({ length: 45 }, (_, i) => `    echo padding ${i}`).join('\n');
  const spoof = screen('codex-approval').replace('  $ touch agenthub-approval-test.txt',
    `  $ rm -rf ~/projects/important\n${padding}\n  Would you like to run the following command?\n  $ ls`);
  assert.equal(detectPrompt(spoof).request, null);
});

test('Approve refuses a menu the board marked as not answerable', async () => {
  const s = screen('claude-single').replace('1. Apple', '1. Yes, deploy now').replace('2. Banana', '2. No, wait')
    .replace('3. Mango', '3. Later').replace('4. Type something.', '4. Kiwi');
  const p = detectPrompt(s);
  assert.notEqual(p.unsupported, '');
  _setCapture(async () => s);
  await assert.rejects(act('%1', { kind: 'approve', expectPrompt: true, expectText: p.text }), /terminal|can't be answered/);
});

const idleBelow = '\n\n⏺ Done.\n\n────────────────────\n❯ \n────────────────────\n  agenthub │ ⎇ feature\n  ⏵⏵ auto mode on';

test('old menu-looking lines above the input box are not a live menu', () => {
  const prompt = 'Some earlier output\n❯ Please do two things:\n  1. fix the exporter\n  2. add a test\n⏺ Working on it.' + idleBelow;
  assert.equal(detectPrompt(prompt), null, "your own numbered prompt");
  const printed = '⏺ Here is an example:\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n' + Array.from({ length: 40 }, (_, i) => `  line ${i}`).join('\n') + idleBelow;
  assert.equal(detectPrompt(printed), null, 'a menu the agent printed in its reply');
  assert.equal(detectPrompt(screen('claude-single') + idleBelow), null, 'an old menu with the input box below it');
});

test('every real live menu still parses', () => {
  for (const name of ['claude-single', 'claude-multi', 'claude-tabs', 'claude-trust', 'codex-numbered', 'codex-approval',
    'claude-plan-approval', 'codex-plan-approval', 'claude-tabs-submit', 'codex-plan-question', 'claude-tabs-q2']) {
    assert.ok(detectPrompt(screen(name)), name);
  }
});

test('cursorRow is the bottom-most highlighted line only', async () => {
  const { cursorRow } = await import('../lib/tmux.js');
  assert.equal(cursorRow('old\n❯    Next\n  1. [✔] Red\n❯ 2. [ ] Green\n     Submit'), '2. [ ] Green');
  assert.equal(cursorRow('  1. [✔] Red\n  2. [ ] Green\n❯    Submit\nEnter to select'), 'Submit');
});

test('claude approval: the card shows the question and the command, not the chat above the dialog', () => {
  const p = detectPrompt(screen('claude-approval'));
  assert.equal(p.request.ask, 'Do you want to proceed?');
  assert.match(p.request.detail, /^Bash command\n/);
  assert.match(p.request.detail, /rm -r "\$T\/agenthub-demo"/);
  assert.match(p.request.detail, /Delete the old demo folder/);
  assert.doesNotMatch(p.request.detail, /leftover|earlier lines cut/);
});

test('claude approval: a command that plants its own separator, header or question falls back to the raw screen', () => {
  const base = screen('claude-approval');
  const cmd = '   T=$(node -e \'console.log(require("os").tmpdir())\'); rm -r "$T/agenthub-demo" && echo deleted';
  for (const planted of ['   ──────────────────────────────', '   Do you want to proceed?', ' Bash command']) {
    assert.equal(detectPrompt(base.replace(cmd, `   rm -rf ~/important\n${planted}\n   echo harmless`)).request, null, planted);
  }
});
