// project-manager.js
//
// The real local development workspace. Unlike the old VolleyPrompt folder
// "context" picker (which read files into a prompt), this module performs
// filesystem operations against a SELECTED project directory on behalf of the
// coding agents. All paths are validated so nothing can escape the project root,
// and writes are reported so the UI can show what changed.
//
// Treats repository content as untrusted DATA, never as instructions or paths
// that may escape the sandbox.

const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const CheckpointManager = require('./checkpoint-manager.js');

// Reused from the original folder-protection logic, extended for the workspace.
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage',
  'vendor', 'venv', '.venv', '__pycache__', '.idea', '.vscode', '.gamevolley',
]);
const IGNORED_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.env', '.env.local', '.env.production',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);
const IGNORED_FILE_PATTERNS = [
  /\.lock$/i, /\.map$/i, /\.min\.(js|css)$/i, /\.(pem|key|crt|pfx|p12)$/i,
];
const ALLOWED_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.html', '.htm',
  '.css', '.scss', '.sass', '.json', '.md', '.txt', '.markdown', '.yaml',
  '.yml', '.toml', '.xml', '.svg', '.sql', '.sh', '.bat', '.ps1', '.env.example',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.php', '.vue',
  '.svelte', '.glsl', '.wgsl', '.txt',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file read
const MAX_TREE_FILES = 600;
const MAX_SUMMARY_BYTES = 48 * 1024;

function isPathIgnored(relPath) {
  const segs = String(relPath).split(/[\\/]/);
  const base = segs[segs.length - 1];
  if (segs.slice(0, -1).some((s) => IGNORED_DIRS.has(s) || s.startsWith('.'))) return true;
  if (base.startsWith('.')) return true;
  if (IGNORED_FILES.has(base)) return true;
  if (IGNORED_FILE_PATTERNS.some((rx) => rx.test(base))) return true;
  return false;
}

function isExtAllowed(relPath) {
  const base = path.basename(relPath);
  if (IGNORED_FILES.has(base)) return false;
  if (IGNORED_FILE_PATTERNS.some((rx) => rx.test(base))) return false;
  const ext = path.extname(base).toLowerCase();
  return ALLOWED_EXT.has(ext);
}

class ProjectManager {
  constructor(eventSink) {
    this.active = null;
    this.checkpoints = new CheckpointManager();
    this._watcher = null;
    this._emit = typeof eventSink === 'function' ? eventSink : () => {};
  }

  // ---- path safety ----
  resolveProjectPath(relativePath) {
    if (!this.active) throw new Error('No active project. Open or create one first.');
    const root = path.resolve(this.active.path);
    // Normalise and reject anything that escapes the root.
    const target = path.resolve(root, String(relativePath || ''));
    const rel = path.relative(root, target);
    if (rel === '' || rel === '.') return target;
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes the project directory: ${relativePath}`);
    }
    return target;
  }

  // ---- open / create ----
  async openProject(projectPath) {
    const resolved = path.resolve(projectPath);
    let stat;
    try { stat = await fs.stat(resolved); } catch { throw new Error(`Cannot open "${projectPath}" — folder not found.`); }
    if (!stat.isDirectory()) throw new Error('Selected project must be a directory.');
    this.active = { name: path.basename(resolved), path: resolved };
    this._emit({ type: 'project:opened', name: this.active.name, path: resolved });
    return this.getActive();
  }

  async createProject(projectPath, { idea = '', parent = null } = {}) {
    const resolved = path.resolve(projectPath);
    await fs.mkdir(resolved, { recursive: true });
    // Record metadata so the workspace can show the original idea later.
    const metaPath = path.join(resolved, '.gamevolley', 'meta.json');
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: path.basename(resolved),
      createdAt: Date.now(),
      idea,
    }, null, 2), 'utf8');
    this.active = { name: path.basename(resolved), path: resolved };
    this._emit({ type: 'project:opened', name: this.active.name, path: resolved });
    return this.getActive();
  }

  getActive() {
    return this.active ? { name: this.active.name, path: this.active.path } : null;
  }

  // ---- tree / read / write ----
  async listFiles(relativePath = '') {
    const root = this.resolveProjectPath(relativePath);
    const out = [];
    let count = 0;
    const walk = async (dir, prefix) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (IGNORED_DIRS.has(e.name) || e.name === '.gamevolley') continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (isPathIgnored(rel)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          out.push({ path: rel, type: 'dir' });
          if (count < MAX_TREE_FILES) await walk(full, rel);
        } else if (e.isFile()) {
          if (!isExtAllowed(rel)) continue;
          let size = 0;
          try { size = (await fs.stat(full)).size; } catch {}
          out.push({ path: rel, type: 'file', size, ext: path.extname(e.name).toLowerCase() });
          if (++count >= MAX_TREE_FILES) break;
        }
      }
    };
    await walk(root, '');
    return out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
  }

  async readFile(relativePath) {
    const full = this.resolveProjectPath(relativePath);
    let stat;
    try { stat = await fs.stat(full); } catch { throw new Error(`File not found: ${relativePath}`); }
    if (stat.isDirectory()) throw new Error(`Path is a directory, not a file: ${relativePath}`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File too large to read (${Math.round(stat.size / 1024)} KB): ${relativePath}`);
    }
    return fs.readFile(full, 'utf8');
  }

  async writeFile(relativePath, content, { emit = true } = {}) {
    const full = this.resolveProjectPath(relativePath);
    if (isPathIgnored(relativePath)) throw new Error(`Refusing to write protected path: ${relativePath}`);
    if (!isExtAllowed(relativePath)) {
      // Allow writing the gamevolley metadata file specifically.
      if (!relativePath.startsWith('.gamevolley/')) {
        throw new Error(`File type not allowed for writing: ${relativePath}`);
      }
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    if (emit) this._emit({ type: 'project:changed', path: relativePath, operation: 'modified' });
    return { path: relativePath, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async deleteFile(relativePath, { explicit = false } = {}) {
    if (!explicit) throw new Error('Delete requires explicit confirmation (explicit: true).');
    const full = this.resolveProjectPath(relativePath);
    if (isPathIgnored(relativePath)) throw new Error(`Refusing to delete protected path: ${relativePath}`);
    try { await fs.unlink(full); }
    catch (e) { throw new Error(`Could not delete ${relativePath}: ${e.message}`); }
    this._emit({ type: 'project:changed', path: relativePath, operation: 'deleted' });
    return true;
  }

  async createDir(relativePath) {
    const full = this.resolveProjectPath(relativePath);
    await fs.mkdir(full, { recursive: true });
    return true;
  }

  // ---- entry-point & project understanding ----
  async detectEntryPoint() {
    if (!this.active) throw new Error('No active project.');
    const root = this.active.path;
    const pkgPath = path.join(root, 'package.json');
    let pkg = null;
    try { pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')); } catch {}

    if (pkg && pkg.scripts) {
      const dev = pkg.scripts.dev || pkg.scripts.start;
      if (dev) {
        const lower = dev.toLowerCase();
        let port = 5173;
        if (/--port\s+(\d+)/.test(lower)) port = Number(lower.match(/--port\s+(\d+)/)[1]);
        else if (/vite/.test(lower)) port = 5173;
        else if (/next/.test(lower)) port = 3000;
        else if (/webpack/.test(lower)) port = 8080;
        return { type: 'devserver', command: 'npm run dev', url: `http://localhost:${port}`, framework: lower.includes('vite') ? 'vite' : lower.includes('next') ? 'next' : 'unknown' };
      }
    }
    for (const cand of ['index.html', 'src/index.html', 'public/index.html', 'game/index.html', 'dist/index.html']) {
      try { if ((await fs.stat(path.join(root, cand))).isFile()) return { type: 'file', path: cand }; } catch {}
    }
    // Fall back to any html file at root.
    let entries = [];
    try { entries = await fs.readdir(root); } catch {}
    const html = entries.find((f) => f.toLowerCase().endsWith('.html'));
    if (html) return { type: 'file', path: html };
    return null;
  }

  // Compact, model-friendly summary: tree + entry point + manifest excerpts.
  async getProjectSummary() {
    const tree = await this.listFiles();
    const entry = await this.detectEntryPoint().catch(() => null);
    const root = this.active.path;
    let manifest = '';
    for (const f of ['package.json', 'README.md', 'index.html', 'game.js', 'main.js', 'src/main.js']) {
      if (manifest.length > MAX_SUMMARY_BYTES) break;
      try {
        const t = await fs.readFile(path.join(root, f), 'utf8');
        manifest += `\n--- ${f} ---\n${t.slice(0, 1500)}\n`;
      } catch {}
    }
    return { name: this.active.name, entry, tree, manifest: manifest.slice(0, MAX_SUMMARY_BYTES) };
  }

  // Snapshot file contents/hashes for change detection around an agent run.
  async snapshotHashes() {
    const root = this.active.path;
    const map = {};
    const walk = async (dir, prefix) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (IGNORED_DIRS.has(e.name) || e.name === '.gamevolley') continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (isPathIgnored(rel)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, rel);
        else if (e.isFile() && isExtAllowed(rel)) {
          try {
            const buf = await fs.readFile(full);
            map[rel] = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
          } catch {}
        }
      }
    };
    await walk(root, '');
    return map;
  }

  diffSnapshots(before, after) {
    const changed = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      if (before[k] !== after[k]) {
        changed.push({ path: k, operation: !before[k] ? 'created' : !after[k] ? 'deleted' : 'modified' });
      }
    }
    return changed;
  }

  // ---- watch ----
  watch(onChange) {
    this.stopWatch();
    if (!this.active) return;
    try {
      this._watcher = fss.watch(this.active.path, { recursive: true }, (event, filename) => {
        if (!filename) return;
        if (isPathIgnored(filename)) return;
        onChange && onChange({ type: 'project:changed', path: String(filename).split(/[\\/]/).join('/'), operation: event === 'rename' ? 'modified' : 'modified' });
      });
    } catch {}
  }

  stopWatch() {
    if (this._watcher) { try { this._watcher.close(); } catch {} this._watcher = null; }
  }

  // ---- checkpoints (delegated) ----
  checkpoint() { return this.checkpoints; }
}

module.exports = ProjectManager;
