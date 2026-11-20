// Plan usage per agent (lib/usage.js): where Claude keeps each account's sign-in, and reading the usage windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keychainService, claudeWindows, codexWindows, codexUsage } from '../lib/usage.js';

test('the Keychain item: its own name for ~/.claude, a hash of the folder for any other', () => {
  assert.equal(keychainService('/h/.claude', '/h'), 'Claude Code-credentials');
  assert.equal(keychainService('/h/.claude/', '/h'), 'Claude Code-credentials');
  assert.match(keychainService('/h/.claude-work', '/h'), /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.notEqual(keychainService('/h/.claude-work', '/h'), keychainService('/h/.claude-other', '/h'));
});

const now = Date.UTC(2026, 10, 19, 20, 0);

test("Claude's reply: the 5-hour session and the week", () => {
  const body = {
    five_hour: { utilization: 10, resets_at: '2026-11-19T23:09:59.633486+00:00' },
    seven_day: { utilization: 4, resets_at: '2026-11-21T17:59:59.633505+00:00' },
    seven_day_opus: null,
  };
  assert.deepEqual(claudeWindows(body, now), [
    { name: 'Session', used: 10, resetsAt: Date.parse('2026-11-19T23:09:59.633Z') },
    { name: 'Week', used: 4, resetsAt: Date.parse('2026-11-21T17:59:59.633Z') },
  ]);
});

test('a window whose reset has passed counts as fresh', () => {
  assert.equal(claudeWindows({ five_hour: { utilization: 97, resets_at: '2026-11-19T19:00:00Z' } }, now)[0].used, 0);
});

test("Codex's rate_limits: a week window (and a session one when the plan has it)", () => {
  assert.deepEqual(codexWindows({ primary: { used_percent: 69.0, window_minutes: 10080, resets_at: 1795464111 }, secondary: null }, now),
    [{ name: 'Week', used: 69, resetsAt: 1795464111000 }]);
  const both = codexWindows({ primary: { used_percent: 12, window_minutes: 300, resets_at: 1795464111 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1795464111 } }, now);
  assert.deepEqual(both.map((w) => w.name), ['Session', 'Week']);
});

test("Codex's usage is read from its newest session log", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-usage-'));
  const d = new Date();
  const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const later = Math.round(Date.now() / 1000) + 3600;
  fs.writeFileSync(path.join(dir, 'rollout-x.jsonl'), [
    { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 20, window_minutes: 10080, resets_at: later } } } },
    { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 33, window_minutes: 10080, resets_at: later } } } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const u = await codexUsage(root);
  assert.equal(u.windows[0].used, 33);
  assert.equal(u.why, '');
  assert.match((await codexUsage(path.join(root, 'none'))).why, /not recorded/);
});
