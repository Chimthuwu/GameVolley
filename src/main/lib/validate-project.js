// validate-project.js
//
// The execution gate between Developer and Critic. A build is only allowed to
// complete when this says ok:true — the Critic's verdict alone can never
// complete a build.
//
// Checks:
//   1. Entry point exists and every local file it references exists.
//   2. Syntax check on classic scripts (ES modules are covered by the runtime check).
//   3. `npm run build` IF the project defines one (timeouts + output caps are
//      damage limiters, NOT a sandbox — the script runs with the user's
//      privileges; documented limitation).
//   4. Runtime health: the embedded preview must report ready and emit no
//      error-level console messages. Reload the preview first so validation
//      never reads stale state.
//   5. Heuristic game checklist — WARNINGS only (DOM games differ).
//
// Everything here is read-only for the project except the optional build step.

const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');

const NOISE = [/favicon\.ico/i];
const CHECKLIST = [
  ['game loop', /requestAnimationFrame|setAnimationLoop|setInterval/],
  ['input handling', /addEventListener\(\s*['"](key|pointer|mouse|touch|click)/i],
  ['win/lose state', /game\s*over|gameOver|victory|youWin|gameState|state\s*=/i],
];

async function exists(p) { return fs.access(p).then(() => true, () => false); }

function runBuild(root, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'],
      { cwd: root, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}\n${stderr}`.slice(-8000), timedOut: Boolean(err && err.killed) }));
  });
}

// Waits for preview readiness + error-level console output. Never hangs: the
// timeout resolves with whatever we saw.
function waitForPreview(preview, { timeoutMs = 8000, settleMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const errors = [];
    let ready = false;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (preview.off) {
        preview.off('preview:console', onConsole);
        preview.off('preview:ready', onReady);
        preview.off('preview:fail', onFail);
      }
      clearTimeout(timer);
      resolve({ ready, errors });
    };
    const onConsole = (m) => {
      const level = typeof m === 'object' ? m.level : m;
      const msg = typeof m === 'object' ? m.message : String(m);
      if (level >= 2 && !NOISE.some((re) => re.test(msg))) errors.push(msg);
    };
    const onReady = () => { ready = true; setTimeout(done, settleMs); }; // let runtime errors surface
    const onFail = (e) => { errors.push(`Failed to load: ${(e && e.message) || e}`); done(); };
    const timer = setTimeout(done, timeoutMs);
    if (preview.on) {
      preview.on('preview:console', onConsole);
      preview.on('preview:ready', onReady);
      preview.on('preview:fail', onFail);
    }
  });
}

async function validateProject({ root, preview = null, entryFile = 'index.html', runBuildStep = true, emit = () => {} }) {
  const blocking = [];
  const warnings = [];
  const checks = [];

  // 1. Entry point and referenced local files.
  const entryAbs = path.join(root, entryFile);
  if (!(await exists(entryAbs))) {
    blocking.push(`Missing entry point: ${entryFile}`);
  } else {
    const html = await fs.readFile(entryAbs, 'utf8');
    for (const m of html.matchAll(/(?:src|href)=["'](?!https?:|data:|#|\/\/)([^"'?#]+)/g)) {
      if (!(await exists(path.join(root, m[1])))) blocking.push(`${entryFile} references missing file: ${m[1]}`);
    }
    checks.push('entry+references');
  }

  // 2. Best-effort syntax check for classic scripts.
  const jsFiles = await listJs(root);
  for (const f of jsFiles) {
    let code;
    try { code = await fs.readFile(f, 'utf8'); } catch { continue; }
    if (/^\s*(import|export)\s/m.test(code)) continue;
    try { new vm.Script(code, { filename: f }); } catch (e) {
      blocking.push(`Syntax error in ${path.relative(root, f)}: ${e.message}`);
    }
  }
  checks.push('syntax');

  // 3. Build, only if the project defines one. NOTE: this runs AI-generated
  // scripts with the user's privileges — the timeout/cap are damage limiters,
  // not a sandbox. runBuildStep=false disables it.
  let pkg = null;
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); } catch {}
  if (runBuildStep && pkg && pkg.scripts && pkg.scripts.build) {
    emit({ type: 'stage', stage: 'building' });
    const b = await runBuild(root);
    if (!b.ok) blocking.push(`Build failed${b.timedOut ? ' (timed out)' : ''}:\n${b.output}`);
    checks.push('build');
  }

  // 4. Runtime health.
  if (preview) {
    emit({ type: 'stage', stage: 'testing' });
    if (preview.reload) { try { preview.reload(); } catch {} }
    const r = await waitForPreview(preview);
    if (!r.ready) blocking.push('Preview never reported ready');
    r.errors.forEach((e) => blocking.push(`Runtime error: ${e}`));
    checks.push('runtime');
  } else {
    warnings.push('Runtime check skipped (no preview available); this is NOT proof the game runs');
  }

  // 5. Heuristic game checklist — warnings only.
  let allCode = '';
  for (const f of jsFiles) {
    try { allCode += await fs.readFile(f, 'utf8'); } catch {}
  }
  for (const [name, re] of CHECKLIST) if (!re.test(allCode)) warnings.push(`Checklist: no sign of ${name}`);

  return { ok: blocking.length === 0, blocking, warnings, checks };
}

async function listJs(root, dir = root, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (['node_modules', '.git', '.gamevolley', 'dist', 'build'].includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await listJs(root, abs, out);
    else if (/\.(c|m)?js$/.test(e.name)) out.push(abs);
  }
  return out;
}

module.exports = { validateProject, waitForPreview, runBuild, listJs };
