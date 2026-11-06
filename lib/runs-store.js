'use strict';
// File operations behind the sidebar's rename / delete / move actions.
//
// Everything here operates on ONE run directory that holds a flat set of files per run:
//
//   <stamp>-final.md      the finished prompt (-draft.md when the user hit Stop)
//   <stamp>.title         the display title shown in the sidebar
//   <stamp>.idea          the original idea
//   <stamp>.meta.json     project, outcome, score, snapshots, model pair
//   <stamp>.md            the run log
//
// The renderer must never touch the disk itself, so every mutation lives here and is
// exposed to the UI through IPC. Kept free of Electron imports so it can be unit-tested
// with plain `node --test`.

const fs = require('fs');
const path = require('path');

const MAX_TITLE = 120;
const MAX_PROJECT = 80;
const OUTCOMES = ['used', 'edited', 'failed', 'unused'];

// The name of a run body file, e.g. "2026-01-02-03-04-05-final.md".
function isRunBody(name) {
  return typeof name === 'string' && (name.endsWith('-final.md') || name.endsWith('-draft.md'));
}

// Only exact, expected file names are accepted — no separators, no traversal, no
// arbitrary extensions. Everything that reaches disk goes through this.
function isValidRunName(name) {
  if (!isRunBody(name)) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return path.basename(name) === name;
}

function stampOf(name) {
  const suffix = name.endsWith('-draft.md') ? '-draft.md' : '-final.md';
  return name.slice(0, -suffix.length);
}

function sidecars(stamp) {
  return [`${stamp}.title`, `${stamp}.idea`, `${stamp}.meta.json`, `${stamp}.md`];
}

function readMeta(dir, stamp) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${stamp}.meta.json`), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMeta(dir, stamp, meta) {
  try {
    fs.writeFileSync(path.join(dir, `${stamp}.meta.json`), JSON.stringify(meta, null, 2));
    return true;
  } catch {
    return false;
  }
}

// "Other volleys" is the display name for runs with no project set.
const UNGROUPED = 'Other volleys';

function listRuns(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter(isRunBody)
    .map((f) => {
      const isDraft = f.endsWith('-draft.md');
      const stamp = stampOf(f);
      let title = '';
      try { title = fs.readFileSync(path.join(dir, `${stamp}.title`), 'utf8').trim(); } catch {}
      return {
        name: f,
        title,
        path: path.join(dir, f),
        incomplete: isDraft,
        meta: readMeta(dir, stamp),
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function readRun(dir, name) {
  if (!isValidRunName(name)) return null;
  let final = '';
  try { final = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; }
  const stamp = stampOf(name);
  let idea = '';
  try {
    idea = fs.readFileSync(path.join(dir, `${stamp}.idea`), 'utf8');
  } catch {
    // Runs saved before idea sidecars existed logged the idea in the run log's `## Idea` section.
    try {
      const logTxt = fs.readFileSync(path.join(dir, `${stamp}.md`), 'utf8');
      const m = logTxt.match(/^## Idea\n\n([\s\S]*?)(?=\n## |$)/m);
      if (m) idea = m[1];
    } catch {}
  }
  let log = '';
  try { log = fs.readFileSync(path.join(dir, `${stamp}.md`), 'utf8'); } catch {}
  return { final, idea, meta: readMeta(dir, stamp), log };
}

// Renames the run by rewriting its title sidecar. The filename stamp is the run's
// identity (and its sort order), so it is deliberately left alone.
function renameRun(dir, name, title) {
  if (!isValidRunName(name)) return false;
  if (typeof title !== 'string') return false;
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (!clean) return false;
  const stamp = stampOf(name);
  try {
    fs.writeFileSync(path.join(dir, `${stamp}.title`), clean);
    return true;
  } catch {
    return false;
  }
}

// Deletes the run body and every sidecar belonging to it.
function deleteRun(dir, name) {
  if (!isValidRunName(name)) return false;
  const stamp = stampOf(name);
  let removed = false;
  for (const file of [name, ...sidecars(stamp)]) {
    try {
      fs.unlinkSync(path.join(dir, file));
      removed = true;
    } catch {
      // A missing sidecar is not an error — the body may be all that's there.
    }
  }
  return removed;
}

// Moves a run into a project group. An empty project puts it back in "Other volleys".
function moveRun(dir, name, project) {
  if (!isValidRunName(name)) return false;
  if (typeof project !== 'string') return false;
  const stamp = stampOf(name);
  const meta = readMeta(dir, stamp);
  meta.project = project.replace(/\s+/g, ' ').trim().slice(0, MAX_PROJECT);
  return writeMeta(dir, stamp, meta);
}

// Renames a project group: every run in the old group gets the new name.
function renameProject(dir, from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return 0;
  const clean = to.replace(/\s+/g, ' ').trim().slice(0, MAX_PROJECT);
  if (!clean) return 0;
  let moved = 0;
  for (const run of listRuns(dir)) {
    if ((run.meta?.project || '') !== from) continue;
    if (moveRun(dir, run.name, clean)) moved++;
  }
  return moved;
}

// "Deletes" a project by ungrouping its runs — the volleys themselves are never lost.
function deleteProject(dir, name) {
  if (typeof name !== 'string' || !name) return 0;
  let moved = 0;
  for (const run of listRuns(dir)) {
    if ((run.meta?.project || '') !== name) continue;
    if (moveRun(dir, run.name, '')) moved++;
  }
  return moved;
}

// The set of project groups in the sidebar, with member counts.
function listProjects(dir) {
  const counts = new Map();
  for (const run of listRuns(dir)) {
    const name = run.meta?.project || '';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({
    name: name || UNGROUPED,
    key: name,
    count,
  }));
}

// Patches the mutable fields of a run's meta. Only known keys are written.
function updateRun(dir, name, patch) {
  if (!isValidRunName(name)) return false;
  const stamp = stampOf(name);
  const meta = readMeta(dir, stamp);
  if (patch && OUTCOMES.includes(patch.outcome)) meta.outcome = patch.outcome;
  if (patch && typeof patch.project === 'string') meta.project = patch.project.slice(0, MAX_PROJECT);
  return writeMeta(dir, stamp, meta);
}

module.exports = {
  MAX_TITLE,
  MAX_PROJECT,
  UNGROUPED,
  isValidRunName,
  listRuns,
  readRun,
  renameRun,
  deleteRun,
  moveRun,
  renameProject,
  deleteProject,
  listProjects,
  updateRun,
};
