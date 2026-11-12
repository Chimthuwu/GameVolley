// commit-files.js
//
// Atomic-ish staged writer for model-produced files. Everything is validated
// and staged BEFORE the first project file is touched; if any copy fails the
// restore() callback puts the project back, so a late failure can never leave
// a half-changed project.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveInside } = require('./safe-path.js');

async function commitFiles(root, files, restore) {
  // Preflight everything before touching disk.
  const seen = new Set();
  const targets = files.map((f) => {
    const abs = resolveInside(root, f.path);
    if (seen.has(abs)) throw new Error(`Duplicate path in response: "${f.path}"`);
    seen.add(abs);
    if (typeof f.content !== 'string') throw new Error(`Bad content for "${f.path}"`);
    return { abs, content: f.content };
  });

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-stage-'));
  try {
    for (const [i, t] of targets.entries()) await fs.writeFile(path.join(stage, String(i)), t.content);
    for (const [i, t] of targets.entries()) {
      await fs.mkdir(path.dirname(t.abs), { recursive: true });
      // Symlink containment: the REAL path of the parent dir we write into must
      // stay inside the REAL project root (defeats in-project symlink escapes).
      const realRoot = await fs.realpath(path.resolve(root)).catch(() => path.resolve(root));
      const parentReal = await fs.realpath(path.dirname(t.abs)).catch(() => null);
      if (parentReal && parentReal !== realRoot && !parentReal.startsWith(realRoot + path.sep)) {
        throw new Error(`Symlink escape writing "${t.abs}"`);
      }
      await fs.copyFile(path.join(stage, String(i)), t.abs);
    }
  } catch (err) {
    if (restore) await restore().catch(() => {});
    throw err;
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { commitFiles };
