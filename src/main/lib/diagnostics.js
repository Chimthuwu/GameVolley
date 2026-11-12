// diagnostics.js
//
// Persists raw model output and failure evidence under
// <project>/.gamevolley/diagnostics/ so a bad response is never silently
// discarded — the user can always inspect what the model actually said.

const fs = require('node:fs/promises');
const path = require('node:path');

async function saveDiagnostic(root, kind, text, meta = {}) {
  const dir = path.join(root, '.gamevolley', 'diagnostics');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${kind}.txt`);
  await fs.writeFile(file, `${JSON.stringify(meta)}\n\n${text}`);
  return file;
}

module.exports = { saveDiagnostic };
