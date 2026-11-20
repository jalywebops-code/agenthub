// Settings → Projects (step C4): groups and left-out folders from any device, the projects folder only on the computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, defaultSetup } from '../lib/setup.js';

const HOME = '/Users/you';
const checks = { home: HOME, isExecutable: () => true, isDir: (p) => ['/Users/you/work', '/Users/you/projects'].includes(p), findOnPath: () => true };
const at = (projects, local = false) => applyChanges(defaultSetup(), { projects }, { local, checks });

test('groups and the left-out list can be changed from any device', () => {
  const { setup, error } = at({ groups: [{ label: 'Website', folders: ['site', 'site-api'], kanbanBoards: ['web'] }, { label: 'Notes', folders: [], kanbanBoards: ['notes'] }], ignore: ['scratch', 'scratch'] });
  assert.equal(error, undefined);
  assert.deepEqual(setup.projects.groups, [{ label: 'Website', folders: ['site', 'site-api'], kanbanBoards: ['web'] }, { label: 'Notes', folders: [], kanbanBoards: ['notes'] }]);
  assert.deepEqual(setup.projects.ignore, ['scratch']);
  assert.equal(setup.projects.root, defaultSetup().projects.root); // untouched
});

test('the projects folder: on the computer only, an existing folder in the home folder', () => {
  assert.match(at({ root: '~/work' }).error, /only be changed on the computer/);
  assert.equal(at({ root: '/Users/you/work' }, true).setup.projects.root, '~/work');
  assert.match(at({ root: '~/missing' }, true).error, /no folder/);
  assert.match(at({ root: '/tmp' }, true).error, /inside your home folder/);
});

test('a group needs a unique name and something in it; a folder is in one group at most', () => {
  assert.match(at({ groups: [{ label: '', folders: ['a'] }] }).error, /1 to 40/);
  assert.match(at({ groups: [{ label: 'A', folders: ['x'] }, { label: 'a', folders: ['y'] }] }).error, /Two projects/);
  assert.match(at({ groups: [{ label: 'A', folders: [] }] }).error, /at least one folder/);
  assert.match(at({ groups: [{ label: 'A', folders: ['x'] }, { label: 'B', folders: ['x'] }] }).error, /in two projects/);
});

test('folder and board names are plain names, never paths', () => {
  for (const bad of ['../etc', 'a/b', '.hidden', '']) {
    assert.ok(at({ groups: [{ label: 'A', folders: [bad] }] }).error, bad);
    assert.ok(at({ ignore: [bad] }).error, bad);
  }
  assert.ok(at({ groups: [{ label: 'A', folders: ['x'], color: 'red' }] }).error);
});
