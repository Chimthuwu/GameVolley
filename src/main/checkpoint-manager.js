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
// - Restore = (1) delete files that did not exist at checkpoint time,
//   (2) copy back anything missing or changed (hash-verified).
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

async function walk(root, dir = root, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, abs, out);
    else if (e.isFile()) out.push(path.relative(root, abs)); // symlinks skipped on purpose
  }
  return out;
}

async function sha(file) {
  try {
    return crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');
  } catch { return null; }
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
    for (const rel of await walk(projectPath)) {
      const src = path.join(projectPath, rel);
      const dst = path.join(dir, 'files', rel);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
      manifest[rel] = await sha(src);
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

  // Load the full checkpoint record (with manifest) by id.
  async get(projectPath, id) {
    const dir = path.join(this._projectDir(projectPath), String(id));
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    return { id, kind: 'copy', ref: id, label: meta.label, createdAt: meta.createdAt, manifest: meta.manifest, dir };
  }

  async restore(projectPath, id) {
    const cp = await this.get(projectPath, id);
    // 1. Delete files that did not exist at checkpoint time.
    for (const rel of await walk(projectPath)) {
      if (!(rel in cp.manifest)) await fsp.rm(path.join(projectPath, rel), { force: true });
    }
    // 2. Put back anything missing or changed (hash-verified).
    for (const [rel, hash] of Object.entries(cp.manifest)) {
      const abs = path.join(projectPath, rel);
      const current = await sha(abs);
      if (current !== hash) {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.copyFile(path.join(cp.dir, 'files', rel), abs);
      }
    }
    return { ok: true, kind: 'copy' };
  }

  async remove(projectPath, id) {
    const dir = path.join(this._projectDir(projectPath), String(id));
    await fsp.rm(dir, { recursive: true, force: true });
    return { ok: true };
  }
}

module.exports = CheckpointManager;
