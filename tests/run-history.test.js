'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runHistory = require('../src/main/run-history.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gv-history-'));
const info = {
  mode: 'create',
  instruction: 'A hedgehog platformer, no music',
  projectPath: path.join('C:', 'games', 'hedgehog'),
  roles: { creativeDirector: { provider: 'anthropic' }, developer: { agent: 'claude' }, critic: { provider: 'openrouter', model: 'x' } },
};

test('a finished run keeps the whole conversation and its outcome', () => {
  const dir = tmpDir();
  const rec = runHistory.startRun(dir, info);
  rec.record({ type: 'agent:output', role: 'developer', text: 'Writing ' });
  rec.record({ type: 'agent:output', role: 'developer', text: 'index.html' });
  rec.record({ type: 'brief', text: 'THE BRIEF' });
  rec.record({ type: 'review:result', severity: 'MED', message: 'jump feels floaty' });
  rec.record({ type: 'project:changed', operation: 'created', path: 'index.html' });
  rec.record({ type: 'game:done', result: { completed: true, verdict: 'SHIP', rounds: 2, knownIssues: [] } });
  rec.finish();

  const run = runHistory.readRun(dir, rec.id);
  assert.strictEqual(run.status, 'completed');
  assert.strictEqual(run.brief, 'THE BRIEF');
  assert.strictEqual(run.instruction, info.instruction);
  assert.strictEqual(run.projectName, 'hedgehog');
  assert.strictEqual(run.result.verdict, 'SHIP');
  assert.strictEqual(run.roles.critic.model, 'x');
  const outputs = run.entries.filter((e) => e.kind === 'output');
  assert.deepStrictEqual(outputs.map((e) => e.text), ['Writing index.html'], 'streamed chunks merge into one message');
  assert.ok(run.entries.some((e) => e.kind === 'finding' && e.severity === 'MED'));
  assert.ok(run.endedAt >= run.startedAt);
});

test('failed, stopped, unfinished and interrupted runs are told apart', () => {
  const dir = tmpDir();
  const failed = runHistory.startRun(dir, info);
  failed.record({ type: 'error', message: 'stream-json requires --verbose' });
  failed.finish();
  assert.strictEqual(runHistory.readRun(dir, failed.id).status, 'failed');
  assert.match(runHistory.readRun(dir, failed.id).error, /--verbose/);

  const stopped = runHistory.startRun(dir, info);
  stopped.record({ type: 'agent:cancelled' });
  stopped.finish();
  assert.strictEqual(runHistory.readRun(dir, stopped.id).status, 'stopped');

  const unfinished = runHistory.startRun(dir, info);
  unfinished.record({ type: 'game:done', result: { completed: false, reason: 'round limit' } });
  unfinished.finish();
  assert.strictEqual(runHistory.readRun(dir, unfinished.id).status, 'unfinished');

  // App closed mid-build: what happened so far is already on disk.
  const cut = runHistory.startRun(dir, info);
  cut.record({ type: 'agent:status', role: 'director', status: 'working', message: 'Writing the development brief…' });
  assert.strictEqual(runHistory.readRun(dir, cut.id, cut.id).status, 'running');
  const after = runHistory.readRun(dir, cut.id, null);
  assert.strictEqual(after.status, 'interrupted');
  assert.strictEqual(after.entries.length, 1);
  cut.finish();
});

test('a role-level error line does not mark the whole run failed', () => {
  const dir = tmpDir();
  const rec = runHistory.startRun(dir, info);
  rec.record({ type: 'error', role: 'developer', message: 'one tool call failed' });
  rec.record({ type: 'game:done', result: { completed: true } });
  rec.finish();
  assert.strictEqual(runHistory.readRun(dir, rec.id).status, 'completed');
});

test('list is newest first, searchable across messages, and skips broken files', () => {
  const dir = tmpDir();
  let t = Date.parse('2026-01-01T00:00:00Z');
  const a = runHistory.startRun(dir, { ...info, instruction: 'first' }, { now: () => t });
  a.record({ type: 'brief', text: 'contains the word Pineapple' });
  a.finish();
  t += 60000;
  const b = runHistory.startRun(dir, { ...info, mode: 'fix', instruction: 'second' }, { now: () => t });
  b.finish();
  fs.writeFileSync(path.join(dir, '20270101000000-zzzzzz.json'), '{not json');

  assert.deepStrictEqual(runHistory.listRuns(dir).map((r) => r.instruction), ['second', 'first']);
  assert.deepStrictEqual(runHistory.listRuns(dir, { query: 'pineapple' }).map((r) => r.instruction), ['first']);
  assert.deepStrictEqual(runHistory.listRuns(path.join(dir, 'missing')), []);
});

test('delete refuses the live run and ids that are not run ids', () => {
  const dir = tmpDir();
  const rec = runHistory.startRun(dir, info);
  assert.strictEqual(runHistory.deleteRun(dir, rec.id, rec.id).ok, false);
  assert.strictEqual(runHistory.deleteRun(dir, '../../key').ok, false);
  assert.strictEqual(runHistory.readRun(dir, '..\\..\\key'), null);
  rec.finish();
  assert.strictEqual(runHistory.deleteRun(dir, rec.id).ok, true);
  assert.strictEqual(runHistory.readRun(dir, rec.id), null);
});

test('oversized messages are clipped but keep their start and end', () => {
  const dir = tmpDir();
  const rec = runHistory.startRun(dir, info);
  rec.record({ type: 'agent:output', role: 'developer', text: 'START' + 'x'.repeat(runHistory.MAX_ENTRY_TEXT * 2) + 'END' });
  rec.finish();
  const text = runHistory.readRun(dir, rec.id).entries[0].text;
  assert.ok(text.length < runHistory.MAX_ENTRY_TEXT + 100);
  assert.ok(text.startsWith('START') && text.endsWith('END'));
});

test('a history folder that cannot be written never breaks a build', () => {
  const blocker = path.join(tmpDir(), 'a-file');
  fs.writeFileSync(blocker, '');
  const rec = runHistory.startRun(path.join(blocker, 'sub'), info);
  assert.doesNotThrow(() => { rec.record({ type: 'error', message: 'x' }); rec.finish(); });
});

test('main.js records every build and exposes history to the app', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /onEvent: emit,/);
  assert.match(main, /recorder\.finish\(\)/);
  for (const channel of ['agent:history:list', 'agent:history:read', 'agent:history:delete']) {
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), channel);
  }
});
