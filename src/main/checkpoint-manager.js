// checkpoint-manager.js
//
// Provides reversible snapshots of a project so a failed AI iteration can never
// destroy a previously working version.
//
// Two strategies:
//   1. Git project  -> `git stash push -u` (creates a stash, never touches the
//      user's commit history or branch). Restore = `git stash apply <ref>`.
//   2. No Git       -> copy the tree (excluding heavy/ignored dirs) into
//      `.gamevolley/checkpoints/<id>/`. Restore = copy back.
//
// Neither path force-pushes, rewrites history, or deletes the user's own commits.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage',
  'vendor', 'venv', '.venv', '__pycache__', '.idea', '.vscode', '.gamevolley',
]);

function isGit(projectPath) {
  try { return fs.statSync(path.join(projectPath, '.git')).isDirectory(); }
  catch { return false; }
}

function execGit(projectPath, args) {
  const { execFileSync } = require('node:child_process');
  return execFileSync('git', args, {
    cwd: projectPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function copyDir(src, dest, onFile) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const name = entry.name;
    if (IGNORED_DIRS.has(name) || name.startsWith('.')) {
      if (name !== '.git') continue;
    }
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (entry.isDirectory()) copyDir(s, d, onFile);
    else if (entry.isFile()) { fs.copyFileSync(s, d); onFile && onFile(name); }
  }
}

function removeDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) removeDir(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

class CheckpointManager {
  constructor() {
    this.namespace = '.gamevolley/checkpoints';
  }

  isGit(projectPath) { return isGit(projectPath); }

  // Create a checkpoint. Returns { id, kind: 'git'|'copy', ref, label, createdAt }.
  async create(projectPath, label = 'checkpoint') {
    const id = crypto.randomBytes(4).toString('hex');
    const createdAt = Date.now();
    if (isGit(projectPath)) {
      try {
        const out = execGit(projectPath, ['stash', 'push', '-u', '-m', `gamevolley:${id}:${label}`]);
        const ref = (out.match(/stash@\{\d+\}/) || ['stash@{0}'])[0];
        return { id, kind: 'git', ref, label, createdAt };
      } catch (e) {
        // Git may refuse with "No local changes to save" — treat as an empty checkpoint.
        if (/no local changes/i.test(String(e.stderr || e.message || ''))) {
          return { id, kind: 'git', ref: null, label, createdAt, empty: true };
        }
        throw e;
      }
    }
    const dest = path.join(projectPath, this.namespace, id);
    copyDir(projectPath, dest);
    return { id, kind: 'copy', ref: id, label, createdAt };
  }

  async list(projectPath) {
    if (isGit(projectPath)) {
      try {
        const raw = execGit(projectPath, ['stash', 'list']);
        return raw.split('\n').filter(Boolean).map((line) => {
          const m = line.match(/^(stash@\{\d+\}):\s*On\s+\S+:\s*gamevolley:(\w+):(.*)$/);
          if (!m) return null;
          return { id: m[1], kind: 'git', ref: line.match(/^(stash@\{\d+\})/)[1], label: m[2] };
        }).filter(Boolean);
      } catch { return []; }
    }
    const dir = path.join(projectPath, this.namespace);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((n) => fs.statSync(path.join(dir, n)).isDirectory())
      .map((id) => ({ id, kind: 'copy', ref: id, label: id }));
  }

  async restore(projectPath, id) {
    if (isGit(projectPath)) {
      const list = await this.list(projectPath);
      const found = list.find((c) => c.id === id);
      if (!found || !found.ref) throw new Error('Checkpoint not found in git stash.');
      try {
        execGit(projectPath, ['stash', 'apply', found.ref]);
      } catch (e) {
        if (!/already up to date|no changes|nothing to commit/i.test(String(e.stderr || e.message || ''))) throw e;
      }
      return { ok: true, kind: 'git' };
    }
    const src = path.join(projectPath, this.namespace, id);
    if (!fs.existsSync(src)) throw new Error('Checkpoint folder not found.');
    copyDir(src, projectPath);
    return { ok: true, kind: 'copy' };
  }

  async remove(projectPath, id) {
    if (isGit(projectPath)) {
      const list = await this.list(projectPath);
      const found = list.find((c) => c.id === id);
      if (found && found.ref) {
        try { execGit(projectPath, ['stash', 'drop', found.ref]); } catch {}
      }
      return { ok: true };
    }
    const dir = path.join(projectPath, this.namespace, id);
    removeDir(dir);
    return { ok: true };
  }
}

module.exports = CheckpointManager;
