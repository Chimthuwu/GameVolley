'use strict';
/* Desktop scaffold writer. All path and overwrite checks live here, not in the renderer. */
const fs = require('fs');
const path = require('path');
const scaffold = require('../src/shared/scaffold.js');

function existingFiles(destination) {
  const found = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  walk(destination, '');
  return found;
}

// Returns { count, files }. Refuses to touch a non-empty destination unless merge=true.
function writeFiles(destination, files, merge) {
  const root = String(destination == null ? '' : destination).trim();
  if (!root) throw new Error('Pick a destination folder first');
  const existing = existingFiles(root);
  const plan = scaffold.planWrite(files, root, existing, !!merge);
  const absoluteRoot = path.resolve(root);
  for (const file of plan.files) {
    if (!scaffold.isValidPath(file.path)) throw new Error(`Unsafe scaffold path: ${file.path}`);
    const target = path.resolve(absoluteRoot, file.path.split('/').join(path.sep));
    if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep)) {
      throw new Error(`Scaffold path escapes the destination: ${file.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
  return { count: plan.files.length, files: plan.files.map((f) => f.path), preview: plan.preview };
}

module.exports = { existingFiles, writeFiles };
