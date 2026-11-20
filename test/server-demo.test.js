// The HTTP server end to end, against the demo (made-up agents, nothing real touched): who it answers, which routes
// it refuses, and the guards in front of anything that would reach an agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDemo } from './helpers/demo-server.js';

let demo;
before(async () => { demo = await startDemo(); });
after(() => demo?.stop());
const board = async () => (await demo.request('GET', '/api/board?fresh=1')).json;
const card = async (pick) => (await board()).cards.find(pick);
const turns = async (id) => (await demo.request('GET', `/api/messages?id=${encodeURIComponent(id)}`)).json.messages.length;

test('answers only when addressed as this computer', async () => {
  assert.equal((await demo.request('GET', '/api/board', { headers: { host: `localhost:${demo.port}` } })).status, 200);
  assert.notEqual((await demo.request('GET', '/api/board', { headers: { host: `rebind.example:${demo.port}` } })).status, 200);
});

test('routes that touch the real computer are refused, even from its own page', async () => {
  for (const p of ['/api/install-service', '/api/setup', '/api/detect', '/api/pin', '/api/first-pin', '/api/restart-board', '/api/lane', '/api/upload', '/api/preview']) {
    const r = await demo.request('POST', p, { body: { confirm: true } });
    assert.equal(r.status, 403, p);
    assert.match(r.json.error, /Not in the demo/, p);
  }
  assert.equal((await demo.request('GET', '/api/welcome')).status, 403);
});

test('an action from another site, or with no origin, is refused', async () => {
  assert.equal((await demo.request('POST', '/api/refresh', { body: {}, headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await demo.request('POST', '/api/refresh', { body: {}, headers: { origin: null } })).status, 403);
});

test('approve: every guard answers before anything reaches the agent', async () => {
  const c = await card((x) => x.needsApproval);
  const before = await turns(c.id);
  const post = (body) => demo.request('POST', '/api/action', { body: { id: c.id, ...body } });
  assert.equal((await post({ kind: 'approve' })).status, 400); // not confirmed
  assert.equal((await post({ kind: 'reply', text: '', confirm: true })).status, 400); // empty reply
  assert.equal((await post({ kind: 'reply', text: 'x'.repeat(8001), confirm: true })).status, 400); // too long
  for (const kind of ['constructor', 'valueOf', '__proto__', 'toString']) assert.equal((await post({ kind, confirm: true })).status, 400, kind);
  assert.equal((await demo.request('POST', '/api/action', { body: { id: 'claude:nope', kind: 'approve', confirm: true } })).status, 404);
  assert.equal(await turns(c.id), before, 'nothing was sent');
  const ok = await post({ kind: 'approve', confirm: true, expectPrompt: true, expectText: c.pendingPrompt });
  assert.equal(ok.status, 200);
  assert.equal(await turns(c.id), before + 1);
});

test('answering a question: a stale or wrong answer is refused; the same answer twice is refused the second time', async () => {
  const c = await card((x) => x.question?.options?.length === 2);
  const post = (body) => demo.request('POST', '/api/choose', { body: { id: c.id, confirm: true, ...body } });
  assert.equal((await post({ pick: 5, expect: c.question.expect })).status >= 400, true);
  assert.equal((await post({ pick: 0, expect: 'a different question' })).status >= 400, true);
  const first = await post({ pick: 0, expect: c.question.expect });
  assert.equal(first.status, 200, first.text);
  const again = await post({ pick: 0, expect: c.question.expect });
  assert.equal(again.status >= 400, true, 'the second answer must not be sent');
});

test('static files stay inside public/', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/icons/../../package.json']) {
    const r = await demo.request('GET', p);
    assert.ok(!r.text.includes('"name": "agenthub"'), p);
  }
  const page = await demo.request('GET', '/');
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
});

test('malformed input is answered 400, never a server error', async () => {
  assert.equal((await demo.request('POST', '/api/action', { raw: '{oops', headers: { 'content-type': 'application/json', origin: demo.origin } })).status, 400);
  assert.equal((await demo.request('POST', '/api/action', { raw: 'null', headers: { 'content-type': 'application/json', origin: demo.origin } })).status, 400);
  assert.notEqual((await demo.request('GET', '/api/board', { headers: { cookie: `agenthub_auth_${demo.port}=%E0%A4%A` } })).status, 500);
  assert.equal((await demo.request('GET', '/api/commands?harness=constructor')).status, 404);
});
