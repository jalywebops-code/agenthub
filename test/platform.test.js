// macOS and Linux differences (lib/platform.js) and the Linux service (lib/service.js), step F.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePs, namesOf, environValue, isHomeInterface } from '../lib/platform.js';
import { unitFromList, fillTemplate } from '../lib/service.js';
import { ROOT } from '../lib/config.js';

test('ps output on macOS: the name is a full path and may hold spaces', () => {
  const procs = parsePs('  101     1 /opt/homebrew/bin/tmux\n  202   101 /Applications/Some App.app/Contents/MacOS/Some App\n', true);
  assert.deepEqual(procs.get(101), { ppid: 1, comm: '/opt/homebrew/bin/tmux', args: '' });
  assert.equal(procs.get(202).comm, '/Applications/Some App.app/Contents/MacOS/Some App');
});

test('ps output on Linux: a short name, then the whole command line', () => {
  const procs = parsePs('  300   1 tmux: server   tmux new-session -s x\n  301 300 node    node /home/you/.local/bin/claude hello\n  302 300 codex   codex -c x\n', false);
  assert.equal(procs.get(301).comm, 'node');
  assert.deepEqual(namesOf(procs.get(301)), ['node', 'node', 'claude']);
  assert.ok(namesOf(procs.get(302)).includes('codex'));
});

test('an environment variable from /proc/<pid>/environ', () => {
  const raw = 'HOME=/home/you\0CLAUDE_CONFIG_DIR=/home/you/.claude-work\0PATH=/usr/bin\0';
  assert.equal(environValue(raw, 'CLAUDE_CONFIG_DIR'), '/home/you/.claude-work');
  assert.equal(environValue(raw, 'MISSING'), '');
  assert.equal(environValue('XCLAUDE_CONFIG_DIR=/x\0', 'CLAUDE_CONFIG_DIR'), '');
});

test('home network interfaces: en0 on a Mac; eth0, enp3s0, wlan0, wlp2s0 on Linux, never tailscale0 or docker0', () => {
  assert.equal(isHomeInterface('en0', true), true);
  assert.equal(isHomeInterface('utun4', true), false);
  for (const n of ['eth0', 'enp3s0', 'wlan0', 'wlp2s0']) assert.equal(isHomeInterface(n, false), true, n);
  for (const n of ['tailscale0', 'docker0', 'lo', 'br-1234', 'veth0a1']) assert.equal(isHomeInterface(n, false), false, n);
});

test('the AgentHub unit in systemctl list-units, never its helper', () => {
  const list = 'dbus.service loaded active running D-Bus\nagenthub-hermes-dashboard.service loaded active running x\nagenthub.service loaded active running AgentHub board\n';
  assert.equal(unitFromList(list), 'agenthub');
  assert.equal(unitFromList('my-agenthub.service loaded active running x\n'), 'my-agenthub');
  assert.equal(unitFromList('other.service loaded\n'), '');
});

test('systemd templates fill completely, with values as they are (no XML escaping)', () => {
  const board = fs.readFileSync(path.join(ROOT, 'systemd/agenthub.service.template'), 'utf8');
  const filled = fillTemplate(board, { LABEL: 'agenthub', NODE: '/usr/bin/node', ROOT: '/home/you/a&b', PATH: '/usr/bin:/bin' }, { xml: false });
  assert.doesNotMatch(filled, /__[A-Z]+__/);
  assert.match(filled, /ExecStart=\/usr\/bin\/node \/home\/you\/a&b\/server\.js/);
  const hermes = fs.readFileSync(path.join(ROOT, 'systemd/agenthub-hermes-dashboard.service.template'), 'utf8');
  assert.doesNotMatch(fillTemplate(hermes, { LABEL: 'agenthub-hermes-dashboard', HOME: '/home/you', ROOT: '/home/you/agenthub', PORT: 9119 }, { xml: false }), /__[A-Z]+__/);
});
