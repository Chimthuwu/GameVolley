// executable-resolver.js
//
// Reliable CLI resolution for Windows. npm-installed CLIs often resolve to a
// `.cmd` / `.bat` shim, not the bare binary. We probe each candidate name with a
// harmless flag and return the first that launches. No shell, no user-controlled
// command strings.

const { spawnSync } = require('node:child_process');
const { spawnPlan } = require('../../../lib/win-spawn.js');

function isWindows() {
  return process.platform === 'win32';
}

// Try `bin`, `bin.cmd`, `bin.exe` (the shim forms) and report the first that
// runs `probeArg` without an OS-level error (e.g. ENOENT).
function resolveExecutable(binaries, probeArg = '--version') {
  const candidates = [];
  for (const b of binaries) {
    candidates.push(b);
    if (isWindows()) {
      candidates.push(`${b}.cmd`);
      candidates.push(`${b}.bat`);
    }
    candidates.push(`${b}.exe`);
  }
  for (const cand of candidates) {
    if (!cand) continue;
    try {
      // .cmd/.bat shim candidates need the cmd.exe launch plan (plain spawnSync
      // fails with EINVAL on modern Node); non-shims spawn directly as before.
      const plan = spawnPlan(cand, [probeArg], { timeout: 6000, windowsHide: true, stdio: 'ignore' });
      const r = spawnSync(plan.file, plan.args, plan.options);
      // r.error is set on ENOENT / spawn failure. A missing binary is not an error
      // for THIS candidate, but a present binary that exits non-zero still counts
      // (e.g. `--version` may not be supported but the binary exists).
      if (!r.error) return { binary: cand, resolved: true };
    } catch { /* keep trying */ }
  }
  return null;
}

// Run a short probe command and capture combined output (for auth checks).
function probe(binary, args, timeoutMs = 8000) {
  try {
    const plan = spawnPlan(binary, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' });
    const r = spawnSync(plan.file, plan.args, plan.options);
    return {
      ok: !r.error,
      code: r.status,
      stdout: (r.stdout || '').slice(0, 800),
      stderr: (r.stderr || '').slice(0, 800),
    };
  } catch (e) {
    return { ok: false, code: null, stdout: '', stderr: String(e.message || e) };
  }
}

module.exports = { resolveExecutable, probe, isWindows };
