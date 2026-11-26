// checkpoint-manager.js
//
// Reversible snapshots of a project so a failed AI iteration can never destroy
// a previously working version.
//
// Design (v2 — replaces the git-stash approach):
// - NEVER touches the user's working tree state (the old `git stash push -u`
//   MOVED uncommitted work out of the tree mid-build; a crash between stash and
//   restore left the project empty of the user's edits).
// - NEVER relies on git (a stash only holds tracked+untracked diffs, and the
//   copy fallback never deleted files created after the checkpoint).
// - Snapshot = full file copy + sha256 manifest, stored OUTSIDE the project
//   (default: os.tmpdir()/gamevolley-checkpoints; the app sets userData).
// - Restore = (1) MOVE files that did not exist at checkpoint time into a
//   recovery folder, (2) copy back anything missing or changed (hash-verified),
//   keeping a copy of every version it replaces in that same recovery folder.
//   Restore never destroys the only copy of anything: it cannot know whether a
//   new file came from the agent, the user, or another program.
//
// Known limitation: empty directories are not tracked.
// Backwards compatibility: checkpoints made by the old copy-based manager
// under <project>/.gamevolley/checkpoints are no longer listed (different
// storage location); they remain on disk untouched.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage',
  'vendor', 'venv', '.venv', '__pycache__', '.idea', '.vscode', '.gamevolley',
]);

// Checkpoint ids are the 8 hex characters create() generates. Anything else is
// refused before it can be used to build a path.
const ID_RE = /^[0-9a-f]{8}$/;

async function walk(root, dir = root, out = [], unreadable = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (e) {
    if (e.code !== 'ENOENT') unreadable.push(path.relative(root, dir) || '.');
    return out;
  }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, abs, out, unreadable);
    else if (e.isFile()) out.push(path.relative(root, abs)); // symlinks skipped on purpose
  }
  return out;
}

async function sha(file) {
  try {
    return crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');
  } catch { return null; }
}

// Copy a file and prove the copy matches before anyone touches the original.
async function keepCopy(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
  const copied = await sha(dst);
  if (copied === null || copied !== await sha(src)) throw new Error(`Could not safely copy ${src}`);
}

class CheckpointManager {
  constructor({ snapshotRoot = null } = {}) {
    this.snapshotRoot = snapshotRoot || path.join(os.tmpdir(), 'gamevolley-checkpoints');
    // Legacy flag kept so callers probing git-ness still get a boolean.
    this.legacyGitProbe = false;
  }

  setSnapshotRoot(dir) { this.snapshotRoot = dir; }

  // All checkpoints for one project live under snapshotRoot/<projectHash>/<id>.
  _projectDir(projectPath) {
    const h = crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 16);
    return path.join(this.snapshotRoot, h);
  }

  isGit() { return false; } // v2 never uses git

  // Create a checkpoint. Returns { id, kind: 'copy', ref, label, createdAt, manifest }.
  async create(projectPath, label = 'checkpoint') {
    const id = crypto.randomBytes(4).toString('hex');
    const createdAt = Date.now();
    const dir = path.join(this._projectDir(projectPath), id);
    const manifest = {};
    const unreadable = [];
    const files = await walk(projectPath, projectPath, [], unreadable);
    // An incomplete snapshot would make restore treat the missed files as new.
    if (unreadable.length) throw new Error(`Cannot snapshot the project: could not read ${unreadable.slice(0, 3).join(', ')}`);
    for (const rel of files) {
      const dst = path.join(dir, 'files', rel);
      await keepCopy(path.join(projectPath, rel), dst);
      manifest[rel] = await sha(dst);
    }
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ label, createdAt, manifest }));
    return { id, kind: 'copy', ref: id, label, createdAt, manifest };
  }

  async list(projectPath) {
    const dir = this._projectDir(projectPath);
    let ids;
    try { ids = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const id of ids) {
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(dir, id, 'manifest.json'), 'utf8'));
        out.push({ id, kind: 'copy', ref: id, label: meta.label || id, createdAt: meta.createdAt });
      } catch {}
    }
    return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  _checkpointDir(projectPath, id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Unknown checkpoint.');
    return path.join(this._projectDir(projectPath), id);
  }

  // Load the full checkpoint record (with manifest) by id.
  async get(projectPath, id) {
    const dir = this._checkpointDir(projectPath, id);
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    return { id, kind: 'copy', ref: id, label: meta.label, createdAt: meta.createdAt, manifest: meta.manifest, dir };
  }

  async restore(projectPath, id) {
    const cp = await this.get(projectPath, id);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recoveryDir = path.join(this._projectDir(projectPath), 'recovered',
      `${stamp}-${crypto.randomBytes(2).toString('hex')}`);
    const moved = [];    // not in the checkpoint: moved to recoveryDir
    const replaced = []; // changed since the checkpoint: old version kept in recoveryDir
    // 1. Set aside files that did not exist at checkpoint time.
    for (const rel of await walk(projectPath)) {
      if (Object.hasOwn(cp.manifest, rel)) continue;
      const abs = path.join(projectPath, rel);
      await keepCopy(abs, path.join(recoveryDir, rel));
      await fsp.rm(abs, { force: true });
      moved.push(rel);
    }
    // 2. Put back anything missing or changed (hash-verified).
    for (const [rel, hash] of Object.entries(cp.manifest)) {
      const abs = path.join(projectPath, rel);
      if (await sha(abs) === hash) continue;
      if (fs.existsSync(abs)) {
        await keepCopy(abs, path.join(recoveryDir, rel)); // throws rather than overwrite unsaved work
        replaced.push(rel);
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.copyFile(path.join(cp.dir, 'files', rel), abs);
    }
    return { ok: true, kind: 'copy', label: cp.label, moved, replaced, recoveryDir: moved.length || replaced.length ? recoveryDir : null };
  }

  async remove(projectPath, id) {
    await fsp.rm(this._checkpointDir(projectPath, id), { recursive: true, force: true });
    return { ok: true };
  }
}

// One plain sentence about what a restore did, for the activity log and history.
function describeRestore(result) {
  const r = result || {};
  const parts = [`Rolled back to "${r.label || 'checkpoint'}".`];
  const moved = (r.moved || []).length;
  const replaced = (r.replaced || []).length;
  if (moved) parts.push(`${moved} newer file(s) moved out of the project.`);
  if (replaced) parts.push(`${replaced} changed file(s) put back.`);
  if (r.recoveryDir) parts.push(`Nothing was deleted: the newer versions are in ${r.recoveryDir}`);
  return parts.join(' ');
}

module.exports = CheckpointManager;
module.exports.describeRestore = describeRestore;
