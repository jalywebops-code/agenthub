// Demo mode (lib/demo.js): made-up agents whose cards cover every state, and act like real ones when you answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoLane, demoUsage } from '../lib/demo.js';

const KEYS = ['claude', 'claude-work', 'codex', 'hermes', 'openclaw'];
const all = async () => (await Promise.all(KEYS.map((k) => createDemoLane(k, k).collect()))).flatMap((r) => r.cards);

test('the demo shows an approval, a question with options, running, idle and done chats', async () => {
  const cards = await all();
  assert.ok(cards.some((c) => c.needsApproval && c.pendingPrompt));
  assert.ok(cards.some((c) => c.question && c.question.options.length === 2));
  for (const s of ['working', 'idle', 'done', 'waiting']) assert.ok(cards.some((c) => c.status === s), s);
  assert.ok(cards.every((c) => c.id && c.title && c.cwd && c.harness));
});

test('answering a demo card sets its agent working', async () => {
  const lane = createDemoLane('codex', 'Codex');
  const card = (await lane.collect()).cards.find((c) => c.question);
  await lane.choose(card, { pick: 0, text: '' });
  const now = (await lane.collect()).cards.find((c) => c.id === card.id);
  assert.equal(now.status, 'working');
  assert.equal((await lane.messages(card)).at(-1).role, 'you');
});

test('demo usage: a ring for each Claude account and Codex', () => {
  const u = demoUsage(0);
  assert.deepEqual(Object.keys(u).sort(), ['claude', 'claude-work', 'codex']);
  assert.ok(u['claude-work'].windows[0].used > 80);
});

test('the demo answers only as localhost, only its own page acts, and real-computer routes are refused', async () => {
  const { demoRefusal } = await import('../lib/demo.js');
  const ok = { method: 'POST', path: '/api/action', host: '127.0.0.1:4410', origin: 'http://127.0.0.1:4410', port: 4410 };
  assert.equal(demoRefusal(ok), '');
  assert.equal(demoRefusal({ ...ok, host: 'localhost:4410', origin: 'http://localhost:4410' }), '');
  assert.equal(demoRefusal({ ...ok, method: 'GET', path: '/', origin: undefined }), '');
  // A site whose name points at 127.0.0.1 (DNS rebinding): the Host header gives it away.
  assert.match(demoRefusal({ ...ok, host: 'evil.example:4410', origin: 'http://evil.example:4410' }), /only answers/);
  assert.match(demoRefusal({ ...ok, origin: 'http://evil.example' }), /cross-origin/);
  assert.match(demoRefusal({ ...ok, origin: undefined }), /cross-origin/);
  for (const p of ['/api/install-service', '/api/restart-board', '/api/detect', '/api/setup', '/api/pin', '/api/first-pin', '/api/preview', '/api/upload', '/api/lane']) {
    assert.match(demoRefusal({ ...ok, path: p }), /Not in the demo/, p);
  }
  assert.match(demoRefusal({ ...ok, method: 'GET', path: '/api/welcome' }), /Not in the demo/);
});

test('the demo server shows nothing from the real computer: setup, addresses, versions', async () => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const os = await import('node:os');
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, AGENTHUB_DEMO: '1', AGENTHUB_PORT: String(port) }, stdio: 'ignore' });
  try {
    const get = async (p) => {
      for (let i = 0; i < 50; i++) {
        try { return await (await fetch(`http://127.0.0.1:${port}${p}`)).json(); } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      throw new Error('demo did not start');
    };
    const setup = JSON.stringify(await get('/api/setup'));
    const home = os.homedir();
    // Every path it shows is inside the demo's own temp folder.
    const paths = setup.match(/"(\/[^"]+)"/g) || [];
    assert.ok(paths.every((q) => !q.startsWith(`"${home}`) || q.includes('agenthub-demo-')), paths.filter((q) => q.startsWith(`"${home}`)).join(' '));
    for (const a of Object.values(os.networkInterfaces()).flat()) {
      if (a && !a.internal) assert.ok(!setup.includes(a.address), `address ${a.address} shown`);
    }
    const versions = await get('/api/versions');
    assert.equal(versions.claude.version, '2.1.0');
  } finally {
    child.kill('SIGTERM');
  }
});
