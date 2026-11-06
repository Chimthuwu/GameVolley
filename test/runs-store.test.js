'use strict';
// Tests for lib/runs-store.js — the file operations behind rename/delete/move.
// Run with: npm test   (node --test, no external deps)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/runs-store.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-runs-'));
}

// Lays down a run the way main.js does: a body file plus sidecars.
function seedRun(dir, stamp, { final = 'the prompt', title = 'My volley', project = '', idea = 'the idea', meta = {} } = {}) {
  fs.writeFileSync(path.join(dir, `${stamp}-final.md`), final);
  fs.writeFileSync(path.join(dir, `${stamp}.title`), title);
  fs.writeFileSync(path.join(dir, `${stamp}.idea`), idea);
  fs.writeFileSync(path.join(dir, `${stamp}.meta.json`), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, `${stamp}.md`), `# VolleyPrompt ${stamp}\n\n## Idea\n\n${idea}\n`);
  return `${stamp}-final.md`;
}

test('isValidRunName rejects traversal and wrong shapes', () => {
  assert.equal(store.isValidRunName('2026-01-01-00-00-00-final.md'), true);
  assert.equal(store.isValidRunName('2026-01-01-00-00-00-draft.md'), true);
  assert.equal(store.isValidRunName('../../etc/passwd'), false);
  assert.equal(store.isValidRunName('a/b-final.md'), false);
  assert.equal(store.isValidRunName('a\\b-final.md'), false);
  assert.equal(store.isValidRunName('..final.md'), false);
  assert.equal(store.isValidRunName('notes.txt'), false);
  assert.equal(store.isValidRunName(null), false);
  assert.equal(store.isValidRunName(42), false);
});

test('listRuns returns final and draft runs, newest first', () => {
  const dir = tmpDir();
  seedRun(dir, '2026-01-01-00-00-00', { title: 'Older' });
  seedRun(dir, '2026-02-02-00-00-00', { title: 'Newer' });
  fs.writeFileSync(path.join(dir, '2026-03-03-00-00-00-draft.md'), 'partial');

  const items = store.listRuns(dir);
  assert.equal(items.length, 3);
  assert.equal(items[0].name, '2026-03-03-00-00-00-draft.md');
  assert.equal(items[0].incomplete, true);
  assert.equal(items[1].title, 'Newer');
  assert.equal(items[2].title, 'Older');
});

test('listRuns returns [] for a missing directory instead of throwing', () => {
  assert.deepEqual(store.listRuns(path.join(tmpDir(), 'nope')), []);
});

test('readRun returns final, idea, meta and log', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00', { meta: { project: 'Game' } });
  const got = store.readRun(dir, name);
  assert.equal(got.final, 'the prompt');
  assert.equal(got.idea, 'the idea');
  assert.equal(got.meta.project, 'Game');
  assert.match(got.log, /## Idea/);
});

test('readRun falls back to the run log when the idea sidecar is missing', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00', { idea: 'logged idea' });
  fs.unlinkSync(path.join(dir, '2026-01-01-00-00-00.idea'));
  assert.equal(store.readRun(dir, name).idea, 'logged idea');
});

test('readRun returns null for an unknown or unsafe name', () => {
  const dir = tmpDir();
  assert.equal(store.readRun(dir, '../../secrets.md'), null);
  assert.equal(store.readRun(dir, 'missing-final.md'), null);
});

test('renameRun writes the new title sidecar', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00', { title: 'Old name' });
  assert.equal(store.renameRun(dir, name, 'New name'), true);
  assert.equal(fs.readFileSync(path.join(dir, '2026-01-01-00-00-00.title'), 'utf8'), 'New name');
  assert.equal(store.listRuns(dir)[0].title, 'New name');
});

test('renameRun creates the title sidecar when the run had none', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '2026-01-01-00-00-00-final.md'), 'x');
  assert.equal(store.renameRun(dir, '2026-01-01-00-00-00-final.md', 'Fresh'), true);
  assert.equal(fs.readFileSync(path.join(dir, '2026-01-01-00-00-00.title'), 'utf8'), 'Fresh');
});

test('renameRun rejects an empty name and an unsafe run name', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00', { title: 'Keep' });
  assert.equal(store.renameRun(dir, name, '   '), false);
  assert.equal(store.renameRun(dir, name, ''), false);
  assert.equal(store.renameRun(dir, '../x-final.md', 'Hacked'), false);
  assert.equal(fs.readFileSync(path.join(dir, '2026-01-01-00-00-00.title'), 'utf8'), 'Keep');
});

test('renameRun collapses whitespace and caps the title length', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00');
  store.renameRun(dir, name, '  spaced   out  ');
  assert.equal(fs.readFileSync(path.join(dir, '2026-01-01-00-00-00.title'), 'utf8'), 'spaced out');
  store.renameRun(dir, name, 'x'.repeat(500));
  assert.equal(fs.readFileSync(path.join(dir, '2026-01-01-00-00-00.title'), 'utf8').length, store.MAX_TITLE);
});

test('deleteRun removes the body and every sidecar', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00');
  assert.equal(store.deleteRun(dir, name), true);
  for (const f of ['2026-01-01-00-00-00-final.md', '2026-01-01-00-00-00.title', '2026-01-01-00-00-00.idea', '2026-01-01-00-00-00.meta.json', '2026-01-01-00-00-00.md']) {
    assert.equal(fs.existsSync(path.join(dir, f)), false, `${f} should be gone`);
  }
  assert.equal(store.listRuns(dir).length, 0);
});

test('deleteRun leaves other runs untouched', () => {
  const dir = tmpDir();
  seedRun(dir, '2026-01-01-00-00-00');
  const keep = seedRun(dir, '2026-02-02-00-00-00');
  store.deleteRun(dir, '2026-01-01-00-00-00-final.md');
  assert.equal(store.listRuns(dir).length, 1);
  assert.equal(store.listRuns(dir)[0].name, keep);
});

test('deleteRun refuses an unsafe name and deletes nothing', () => {
  const dir = tmpDir();
  seedRun(dir, '2026-01-01-00-00-00');
  assert.equal(store.deleteRun(dir, '../evil-final.md'), false);
  assert.equal(store.listRuns(dir).length, 1);
});

test('deleteRun on a draft removes the draft and its sidecars', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '2026-01-01-00-00-00-draft.md'), 'partial');
  fs.writeFileSync(path.join(dir, '2026-01-01-00-00-00.title'), 'Stopped');
  assert.equal(store.deleteRun(dir, '2026-01-01-00-00-00-draft.md'), true);
  assert.equal(fs.existsSync(path.join(dir, '2026-01-01-00-00-00-draft.md')), false);
  assert.equal(fs.existsSync(path.join(dir, '2026-01-01-00-00-00.title')), false);
});

test('moveRun sets the project on the run meta', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00');
  assert.equal(store.moveRun(dir, name, 'Platformer'), true);
  assert.equal(store.listRuns(dir)[0].meta.project, 'Platformer');
});

test('moveRun can move a run back to the ungrouped bucket', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00', { meta: { project: 'Game' } });
  store.moveRun(dir, name, '');
  assert.equal(store.listRuns(dir)[0].meta.project, '');
});

test('moveRun creates meta.json when the run has none', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '2026-01-01-00-00-00-final.md'), 'x');
  store.moveRun(dir, '2026-01-01-00-00-00-final.md', 'Game');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '2026-01-01-00-00-00.meta.json'), 'utf8'));
  assert.equal(meta.project, 'Game');
});

test('moveRun preserves other meta fields', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00', { meta: { score: 91, outcome: 'used' } });
  store.moveRun(dir, name, 'Game');
  const meta = store.listRuns(dir)[0].meta;
  assert.equal(meta.score, 91);
  assert.equal(meta.outcome, 'used');
  assert.equal(meta.project, 'Game');
});

test('renameProject renames the group for every member run', () => {
  const dir = tmpDir();
  seedRun(dir, '2026-01-01-00-00-00', { meta: { project: 'Game' } });
  seedRun(dir, '2026-02-02-00-00-00', { meta: { project: 'Game' } });
  seedRun(dir, '2026-03-03-00-00-00', { meta: { project: 'Other' } });

  assert.equal(store.renameProject(dir, 'Game', 'Arcade'), 2);
  const byName = Object.fromEntries(store.listRuns(dir).map((r) => [r.name, r.meta.project]));
  assert.equal(byName['2026-01-01-00-00-00-final.md'], 'Arcade');
  assert.equal(byName['2026-02-02-00-00-00-final.md'], 'Arcade');
  assert.equal(byName['2026-03-03-00-00-00-final.md'], 'Other');
});

test('renameProject on the ungrouped bucket moves those runs into a named group', () => {
  const dir = tmpDir();
  seedRun(dir, '2026-01-01-00-00-00', { meta: {} });
  assert.equal(store.renameProject(dir, '', 'Loose Ends'), 1);
  assert.equal(store.listRuns(dir)[0].meta.project, 'Loose Ends');
});

test('renameProject rejects an empty target name', () => {
  const dir = tmpDir();
  seedRun(dir, '2026-01-01-00-00-00', { meta: { project: 'Game' } });
  assert.equal(store.renameProject(dir, 'Game', '  '), 0);
  assert.equal(store.listRuns(dir)[0].meta.project, 'Game');
});

test('deleteProject ungroups its runs instead of destroying them', () => {
  const dir = tmpDir();
  seedRun(dir, '2026-01-01-00-00-00', { meta: { project: 'Game' } });
  seedRun(dir, '2026-02-02-00-00-00', { meta: { project: 'Game' } });
  seedRun(dir, '2026-03-03-00-00-00', { meta: { project: 'Other' } });

  assert.equal(store.deleteProject(dir, 'Game'), 2);
  assert.equal(store.listRuns(dir).length, 3, 'runs must survive');
  const byName = Object.fromEntries(store.listRuns(dir).map((r) => [r.name, r.meta.project]));
  assert.equal(byName['2026-01-01-00-00-00-final.md'], '');
  assert.equal(byName['2026-02-02-00-00-00-final.md'], '');
  assert.equal(byName['2026-03-03-00-00-00-final.md'], 'Other');
});

test('deleteProject on the ungrouped bucket is a no-op', () => {
  const dir = tmpDir();
  seedRun(dir, '2026-01-01-00-00-00', { meta: {} });
  assert.equal(store.deleteProject(dir, ''), 0);
});

test('listProjects reports each group with its member count', () => {
  const dir = tmpDir();
  seedRun(dir, '2026-01-01-00-00-00', { meta: { project: 'Game' } });
  seedRun(dir, '2026-02-02-00-00-00', { meta: { project: 'Game' } });
  seedRun(dir, '2026-03-03-00-00-00', { meta: { project: 'Site' } });
  seedRun(dir, '2026-04-04-00-00-00', { meta: {} });

  const projects = store.listProjects(dir);
  const byName = Object.fromEntries(projects.map((p) => [p.name, p.count]));
  assert.equal(byName.Game, 2);
  assert.equal(byName.Site, 1);
  assert.equal(byName['Other volleys'], 1);
});

test('updateRun only accepts whitelisted outcome and a string project', () => {
  const dir = tmpDir();
  const name = seedRun(dir, '2026-01-01-00-00-00', { meta: { project: 'Game' } });
  assert.equal(store.updateRun(dir, name, { outcome: 'used', project: 'Site' }), true);
  let meta = store.listRuns(dir)[0].meta;
  assert.equal(meta.outcome, 'used');
  assert.equal(meta.project, 'Site');

  store.updateRun(dir, name, { outcome: 'hacked', evil: 'x' });
  meta = store.listRuns(dir)[0].meta;
  assert.equal(meta.outcome, 'used');
  assert.equal(meta.evil, undefined);
});
