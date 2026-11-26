'use strict';
// run-history.js — saved history of GameVolley builds (Create / Improve / Fix).
//
// One JSON file per run, kept in the app's userData folder (not inside the game
// project), so every run is listed no matter which project is open. The file is
// written while the build is still going: closing the app mid-run keeps
// everything up to that point.
//
// Free of Electron imports so it can be unit-tested with plain `node --test`.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 3000;
const MAX_ENTRY_TEXT = 120000;
const FLUSH_MS = 1000;
const ID_RE = /^[0-9]{14}-[a-z0-9]{6}$/;

const MODES = ['create', 'improve', 'fix'];

// Keep the start and the end of an oversized message: the end usually holds the
// verdict or the error.
function clip(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= MAX_ENTRY_TEXT) return s;
  const half = Math.floor(MAX_ENTRY_TEXT / 2);
  return `${s.slice(0, half)}\n[… ${s.length - half * 2} characters left out …]\n${s.slice(-half)}`;
}

function newId(now) {
  const stamp = new Date(now).toISOString().replace(/\D/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${stamp}-${rand}`;
}

function fileFor(dir, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return path.join(dir, `${id}.json`);
}

// Write to a temp file then rename, so a crash never leaves a half-written run.
function writeRun(dir, run) {
  const file = fileFor(dir, run.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run), 'utf8');
  fs.renameSync(tmp, file);
}

// Turns one orchestration event into a change to the run record.
// Returns true when the change is worth saving immediately.
function applyEvent(run, ev, now) {
  const entries = run.entries;
  const push = (entry) => {
    entries.push({ at: now, ...entry });
    if (entries.length > MAX_ENTRIES) entries.splice(1, entries.length - MAX_ENTRIES);
  };
  switch (ev.type) {
    case 'agent:output': {
      if (!ev.text) return false;
      // Streaming arrives token by token: merge it into one message per speaker.
      const last = entries[entries.length - 1];
      if (last && last.kind === 'output' && last.role === ev.role) last.text = clip(last.text + ev.text);
      else push({ kind: 'output', role: ev.role, text: clip(ev.text) });
      return false;
    }
    case 'agent:status':
      push({ kind: 'status', role: ev.role, status: ev.status, text: clip(ev.message || '') });
      return true;
    case 'brief':
      run.brief = clip(ev.text);
      return true;
    case 'review:result':
      push({ kind: 'finding', role: 'critic', severity: ev.severity, text: clip(ev.message) });
      return false;
    case 'progress':
      push({ kind: 'phase', text: `${ev.phase} (round ${ev.round}/${ev.maxRounds})` });
      return false;
    case 'stage':
      push({ kind: 'note', role: ev.role, text: clip(`${ev.stage}${ev.detail ? ` (${ev.detail})` : ''}`) });
      return false;
    case 'project:changed':
      push({ kind: 'file', text: `${ev.operation} ${ev.path}` });
      return false;
    case 'validation:failed':
      push({ kind: 'error', text: clip(`Validation failed in round ${ev.round}:\n${(ev.blocking || []).join('\n')}`) });
      return true;
    case 'kept-attempt':
    case 'restored':
      push({ kind: 'note', text: clip(ev.message || `Restored checkpoint "${ev.label || ev.checkpoint}"`) });
      return false;
    case 'preview:error':
      push({ kind: 'error', text: clip(`Preview error: ${ev.message || ev.code || 'unknown'}`) });
      return false;
    case 'error':
      push({ kind: 'error', role: ev.role, text: clip(ev.message) });
      // A build-level error (no role) ends the run; a role's error line does not.
      if (!ev.role) { run.status = 'failed'; run.error = clip(ev.message); }
      return true;
    case 'game:done': {
      const r = ev.result || {};
      run.status = r.completed === false ? 'unfinished' : 'completed';
      run.result = {
        verdict: r.verdict || null,
        rounds: r.rounds || null,
        reason: r.reason || null,
        knownIssues: r.knownIssues || [],
      };
      return true;
    }
    case 'agent:cancelled':
      run.status = 'stopped';
      return true;
    default:
      return false;
  }
}

// Records one build. Saving is best-effort: a full disk must never break a build.
function startRun(dir, info = {}, { now = Date.now, flushMs = FLUSH_MS } = {}) {
  const startedAt = now();
  const roles = info.roles || {};
  const run = {
    id: newId(startedAt),
    startedAt,
    endedAt: null,
    status: 'running',
    mode: MODES.includes(info.mode) ? info.mode : 'create',
    instruction: String(info.instruction || ''),
    projectPath: String(info.projectPath || ''),
    projectName: info.projectPath ? path.basename(String(info.projectPath)) : '',
    roles: {
      director: { provider: roles.creativeDirector?.provider || null, model: roles.creativeDirector?.model || null },
      developer: { provider: roles.developer?.agent || null, model: roles.developer?.model || null },
      critic: { provider: roles.critic?.provider || null, model: roles.critic?.model || null },
    },
    maxRounds: info.maxRounds || null,
    brief: '',
    result: null,
    error: null,
    entries: [],
  };

  let timer = null;
  let finished = false;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    try { writeRun(dir, run); } catch { /* history is best-effort */ }
  };
  flush();

  return {
    id: run.id,
    record(ev) {
      if (finished || !ev || !ev.type) return;
      if (applyEvent(run, ev, now())) flush();
      else if (!timer) {
        timer = setTimeout(flush, flushMs);
        if (timer.unref) timer.unref();
      }
    },
    finish() {
      if (finished) return;
      finished = true;
      run.endedAt = now();
      if (run.status === 'running') run.status = 'stopped';
      flush();
    },
  };
}

function loadFile(file) {
  try {
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    return run && typeof run === 'object' && Array.isArray(run.entries) ? run : null;
  } catch {
    return null;
  }
}

// A run still marked "running" that isn't the live one was cut off by the app closing.
function settleStatus(run, activeId) {
  if (run.status === 'running' && run.id !== activeId) run.status = 'interrupted';
  return run;
}

function readRun(dir, id, activeId = null) {
  const file = fileFor(dir, id);
  const run = file ? loadFile(file) : null;
  return run ? settleStatus(run, activeId) : null;
}

// Newest first. `query` searches the request, project, brief and every message.
function listRuns(dir, { activeId = null, query = '' } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  for (const name of names.sort().reverse()) {
    if (!name.endsWith('.json')) continue;
    const run = readRun(dir, name.slice(0, -5), activeId);
    if (!run) continue;
    if (q) {
      const haystack = [run.instruction, run.projectName, run.projectPath, run.brief, ...run.entries.map((e) => e.text)];
      if (!haystack.some((t) => String(t || '').toLowerCase().includes(q))) continue;
    }
    out.push({
      id: run.id,
      startedAt: run.startedAt,
      mode: run.mode,
      status: run.status,
      instruction: run.instruction.slice(0, 300),
      projectName: run.projectName,
      projectPath: run.projectPath,
    });
  }
  return out;
}

function deleteRun(dir, id, activeId = null) {
  const file = fileFor(dir, id);
  if (!file) return { ok: false, message: 'Unknown run.' };
  if (id === activeId) return { ok: false, message: 'That build is still running. Stop it first.' };
  try { fs.unlinkSync(file); return { ok: true }; }
  catch (e) { return { ok: false, message: e.message }; }
}

module.exports = { startRun, readRun, listRuns, deleteRun, MAX_ENTRY_TEXT };
