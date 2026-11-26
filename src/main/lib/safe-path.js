// safe-path.js
//
// Central path validator for MODEL-PROVIDED relative paths. Everything a model
// emits as a file path goes through resolveInside() before it is ever written
// to disk: no absolute paths, no drive letters, no traversal, no reserved
// folders (.git / node_modules / .gamevolley, at any depth), no null bytes.

const path = require('node:path');

const RESERVED = new Set(['.git', 'node_modules', '.gamevolley']);

function resolveInside(root, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) throw new Error('Empty file path from model');
  const p = relPath.trim().replace(/\\/g, '/');
  if (p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    throw new Error(`Unsafe path from model: "${relPath}"`);
  }
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, p);
  const rel = path.relative(rootAbs, abs);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project: "${relPath}"`);
  }
  // Checked at every depth, and the way Windows reads names: case doesn't matter,
  // trailing dots and spaces are ignored, "GIT~1" is a short name for ".git", and
  // ":" opens a hidden data stream.
  for (const segment of rel.split(path.sep)) {
    const name = segment.replace(/[. ]+$/, '').toLowerCase();
    if (RESERVED.has(name) || /^(git|gamevo|node_m)~\d+$/.test(name) || segment.includes(':')) {
      throw new Error(`Path targets reserved folder: "${relPath}"`);
    }
  }
  return abs;
}

module.exports = { resolveInside, RESERVED };
