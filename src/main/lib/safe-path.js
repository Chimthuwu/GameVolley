// safe-path.js
//
// Central path validator for MODEL-PROVIDED relative paths. Everything a model
// emits as a file path goes through resolveInside() before it is ever written
// to disk: no absolute paths, no drive letters, no traversal, no reserved
// folders (.git / node_modules / .gamevolley), no null bytes.

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
  const firstSeg = rel.split(path.sep)[0];
  if (RESERVED.has(firstSeg)) {
    throw new Error(`Path targets reserved folder: "${relPath}"`);
  }
  return abs;
}

module.exports = { resolveInside, RESERVED };
