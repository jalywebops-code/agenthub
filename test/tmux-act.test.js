// What the board actually sends to a terminal (lib/tmux.js act): the keys and pasted text, recorded by a fake tmux.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { act, detectPrompt, _setCapture } from '../lib/tmux.js';
import { fakeTmux } from './helpers/fake-tmux.js';

const screen = (name) => fs.readFileSync(new URL(`./fixtures/menus/${name}.txt`, import.meta.url), 'utf8').replace(/\s+$/g, '');
const IDLE = '⏺ Done.\n\n────────────────────\n❯ \n────────────────────\n  agenthub │ ⎇ feature';
const tmux = fakeTmux();
beforeEach(() => { tmux.reset(); tmux.paneIs = 'claude'; _setCapture(async () => IDLE); });
after(() => _setCapture(null));

test('a reply is pasted as one piece through its own buffer, then Enter', async () => {
  await act('%7', { kind: 'reply', message: 'Yes, go ahead.\nThen run the tests.', expectPrompt: false, expectText: '' });
  assert.deepEqual(tmux.pasted(), ['Yes, go ahead.\nThen run the tests.']);
  const paste = tmux.calls.find((a) => a[0] === 'paste-buffer');
  assert.ok(paste.includes('-p') && paste.includes('-d') && paste.includes('%7'));
  assert.deepEqual(tmux.keys(), ['Enter']);
});

test('two replies never share a paste buffer', async () => {
  await Promise.all([
    act('%7', { kind: 'reply', message: 'first', expectPrompt: false, expectText: '' }),
    act('%8', { kind: 'reply', message: 'second', expectPrompt: false, expectText: '' }),
  ]);
  const names = tmux.calls.filter((a) => a[0] === 'set-buffer').map((a) => a[a.indexOf('-b') + 1]);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((n) => /^agenthub-[0-9a-f-]{36}$/.test(n)));
});

test('a reply is refused when the agent quit and the pane is back at a shell: nothing typed', async () => {
  tmux.paneIs = 'zsh';
  await assert.rejects(act('%7', { kind: 'reply', message: 'rm -rf build', expectPrompt: false, expectText: '' }), /no longer running/);
  assert.deepEqual(tmux.pasted(), []);
  assert.deepEqual(tmux.keys(), []);
});

test('control characters are removed before pasting (an escape could end the paste early)', async () => {
  await act('%7', { kind: 'reply', message: 'ok\u001b[201~\u0003 then\tmore', expectPrompt: false, expectText: '' });
  assert.deepEqual(tmux.pasted(), ['ok[201~ then\tmore']);
});

test('actions on one pane run one at a time', async () => {
  const order = [];
  _setCapture(async () => { order.push('read'); await new Promise((r) => setTimeout(r, 20)); return IDLE; });
  await Promise.all([1, 2].map((n) => act('%7', { kind: 'reply', message: `m${n}`, expectPrompt: false, expectText: '' })
    .then(() => order.push(`done${n}`))));
  assert.deepEqual(order, ['read', 'done1', 'read', 'done2']);
});

test('approve on a permission menu presses Enter on Yes and pastes nothing', async () => {
  const s = screen('claude-approval');
  _setCapture(async () => s);
  await act('%7', { kind: 'approve', expectPrompt: true, expectText: detectPrompt(s).text });
  assert.deepEqual(tmux.keys(), ['Enter']);
  assert.deepEqual(tmux.pasted(), []);
});

test('refusals press nothing: changed menu, plan approval, menu gone', async () => {
  const s = screen('claude-approval');
  _setCapture(async () => s);
  await assert.rejects(act('%7', { kind: 'approve', expectPrompt: true, expectText: 'a different menu' }), /changed/);
  const plan = screen('claude-plan-approval');
  _setCapture(async () => plan);
  await assert.rejects(act('%7', { kind: 'approve', expectPrompt: true, expectText: detectPrompt(plan).text }));
  _setCapture(async () => IDLE);
  await assert.rejects(act('%7', { kind: 'approve', expectPrompt: true, expectText: 'x' }), /gone/);
  assert.deepEqual(tmux.keys(), []);
  assert.deepEqual(tmux.pasted(), []);
});

test('new sessions only use a login shell that quotes the POSIX way', async () => {
  const { posixShell } = await import('../lib/tmux.js');
  for (const ok of ['/bin/zsh', '/bin/bash', '/usr/bin/dash', '/opt/homebrew/bin/bash', '/bin/sh']) assert.equal(posixShell(ok), ok);
  for (const bad of ['/opt/homebrew/bin/fish', '/bin/tcsh', 'zsh', '/bin/zsh; rm -rf ~', '/bin/zsh -c x', '']) assert.equal(posixShell(bad), '/bin/sh');
});

test('a new session passes the shell and its script as separate arguments (no second shell parses the quoting)', async () => {
  const { newSession } = await import('../lib/tmux.js');
  await newSession('demo', '/tmp', ['claude', "it's $(rm -rf ~) `x`"]);
  const call = tmux.calls.find((a) => a[0] === 'new-session');
  const at = call.indexOf('-lc');
  assert.match(call[at - 1], /^\/.*\/(sh|bash|zsh|dash|ksh)$/);
  assert.equal(call[at + 1], `'claude' 'it'\\''s $(rm -rf ~) \`x\`'`);
  assert.equal(call.length, at + 2);
});
