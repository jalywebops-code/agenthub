import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listProjects, projectForPath } from '../lib/projects.js';

// An example install's grouping (the real one lives in each install's .data/setup.json).
const data = {
  projects: [
    { label: 'Notes', folders: ['notes'], kanbanBoards: ['notes'] },
    { label: 'Shop', folders: ['shop-api', 'shop-web'], kanbanBoards: ['shop'] },
  ],
  ignore: ['docs', 'general', 'holding-tank'],
};
const root = '/Users/you/projects';
const entries = [
  ['shop-api', true], ['shop-web', true], ['demo-app', true], ['demo-app-extension', true], ['docs', true],
  ['.git', true], ['archive.zip', false], ['.worktrees', true], ['notes', true],
];
const readdir = () => entries.map(([name, dir]) => ({ name, isDirectory: () => dir }));
const ctx = () => ({ root, kanbanRoot: '/Users/you/.hermes/kanban/boards', home: '/Users/you', data, known: new Set(listProjects({ root, data, readdir }).flatMap((p) => p.folders)) });

test('listProjects: mapped projects keep their names; other folders become projects; junk is skipped', () => {
  const list = listProjects({ root, data, readdir });
  const labels = list.map((p) => p.label);
  assert.ok(labels.includes('Shop'));
  assert.deepEqual(list.find((p) => p.label === 'Shop').folders, ['shop-api', 'shop-web']);
  assert.ok(labels.includes('demo-app') && labels.includes('demo-app-extension'));
  for (const junk of ['docs', '.git', 'archive.zip', '.worktrees']) assert.ok(!labels.includes(junk), junk);
  assert.equal(labels.filter((l) => l === 'Notes').length, 1, 'mapped folder not listed twice');
});

test('projectForPath groups chats into projects', () => {
  const c = ctx();
  assert.equal(projectForPath(`${root}/demo-app-extension/src`, c), 'demo-app-extension');
  assert.equal(projectForPath(`${root}/.worktrees/demo-app-try-codex`, c), 'demo-app');
  assert.equal(projectForPath(`${root}/shop-web`, c), 'Shop');
  assert.equal(projectForPath('/Users/you', c), 'Home');
  assert.equal(projectForPath('/Users/you/Cursor-Projects/foo/bar', c), 'foo');
  assert.equal(projectForPath('/Users/you/.hermes/kanban/boards/notes/task-1', c), 'Notes');
  assert.equal(projectForPath('/Users/you/.hermes/kanban/boards/research-lab', c), 'research-lab');
  assert.equal(projectForPath('', c), 'No project');
});

test('chats inside hidden app folders are named after their own folder', () => {
  const c = ctx();
  assert.equal(projectForPath('/Users/you/.codex/worktrees/a1b2/agenthub', c), 'agenthub');
  assert.equal(projectForPath('/Users/you/.hermes', c), 'Hermes');
  assert.equal(projectForPath('/Users/you/.hermes/profiles/builder', c), 'builder');
});
