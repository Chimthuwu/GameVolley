// agent-process.js
//
// Shared helper that spawns a coding-agent CLI in the project directory, streams
// its stdout/stderr as events, enforces an idle timeout, and honours an
// AbortController. It NEVER constructs a shell string from user input — every
// argument is passed as an array element to spawn().

const { spawn } = require('node:child_process');
const { spawnPlan, isWindowsShim } = require('../../../lib/win-spawn.js');

function streamProcess({
  binary,
  args,
  cwd,
  stdinText = null,
  signal = null,
  onOutput = () => {},
  onDiagnostic = () => {},
  idleMs = 180000,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Windows .cmd/.bat shims must go through cmd.exe (see lib/win-spawn.js);
      // everything else spawns directly with array args — never a shell string.
      const plan = spawnPlan(binary, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child = spawn(plan.file, plan.args, plan.options);
    } catch (e) {
      return reject(new Error(`${binary} failed to start: ${e.message}`));
    }

    let buf = '';
    let stderr = '';
    let aborted = false;
    let stalled = false;
    let idle = null;

    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { stalled = true; try { child.kill('SIGTERM'); } catch {} }, idleMs);
    };

    const onAbort = () => {
      aborted = true;
      try { child.kill('SIGTERM'); } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (e) => {
      clearTimeout(idle);
      reject(new Error(`${binary} process error: ${e.message}`));
    });

    child.stderr.on('data', (d) => {
      arm();
      const s = d.toString();
      stderr += s;
      onDiagnostic(s);
    });

    let allOutput = '';
    child.stdout.on('data', (d) => {
      arm();
      buf += d.toString();
      // Emit line-by-line so the UI gets readable chunks, not raw blobs.
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) { allOutput += line + '\n'; onOutput(line); }
      }
    });

    child.on('close', (code) => {
      clearTimeout(idle);
      const tail = buf.trim();
      if (tail) { allOutput += tail + '\n'; onOutput(tail); }
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) return resolve({ exitCode: code, aborted: true, output: allOutput });
      if (stalled) return reject(new Error(`${binary} stopped responding (no output for ${idleMs / 1000}s).`));
      if (code !== 0) {
        const s = stderr.trim();
        if (/not\s*logged|login|unauthor|auth|401|403|API key/i.test(s)) {
          return reject(new Error(`${binary} is not authenticated. Run its official login flow (e.g. "${binary} login") in a terminal, then retry.`));
        }
        return resolve({ exitCode: code, aborted: false, output: allOutput, error: s.slice(0, 400) || `exit code ${code}` });
      }
      resolve({ exitCode: 0, aborted: false, output: allOutput });
    });

    if (stdinText != null) {
      try { child.stdin.write(stdinText); } catch {}
      try { child.stdin.end(); } catch {}
    }
    arm();
  });
}

module.exports = { streamProcess, isWindowsShim };
