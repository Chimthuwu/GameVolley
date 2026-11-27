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

// Console noise that is NOT the game's fault: favicon 404s, and Electron's own
// dev-mode security banner (emitted for ANY page without a CSP meta, including
// every preview we serve — it is environment noise, not a runtime error).
const NOISE = [/favicon\.ico/i, /electron security warning/i, /insecure content-security-policy/i];
// The preview's console levels: 2 is a warning, 3 is an error (console.error, an
// uncaught exception or an unhandled promise rejection). Only errors fail a build.
const WARNING_LEVEL = 2;
const ERROR_LEVEL = 3;

// A game that logs inside its main loop repeats one message many times. Each
// different message is listed once, with how often it happened.
function collapse(messages, max = 10) {
  const seen = new Map();
  for (const m of messages) seen.set(m, (seen.get(m) || 0) + 1);
  const out = [...seen].map(([m, n]) => (n > 1 ? `${m} (×${n})` : m));
  return out.length > max ? [...out.slice(0, max), `…and ${out.length - max} more different messages`] : out;
}

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

// Waits for preview readiness + error-level console output. Keeps listening for
// the whole settle window (Q4) so a crash thrown seconds after load — on first
// spawn or first collision — is still caught. Never hangs: the timeout resolves
// with whatever we saw. Defaults: settle 5 s after ready, hard timeout 20 s.
function waitForPreview(preview, { timeoutMs = 20000, settleMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const errors = [];
    const consoleWarnings = [];
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
      resolve({ ready, errors, consoleWarnings });
    };
    const onConsole = (m) => {
      const level = typeof m === 'object' ? m.level : m;
      const msg = typeof m === 'object' ? m.message : String(m);
      if (NOISE.some((re) => re.test(msg))) return;
      if (level >= ERROR_LEVEL) errors.push(msg);
      else if (level === WARNING_LEVEL) consoleWarnings.push(msg);
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

async function validateProject({ root, preview = null, entryFile = 'index.html', runBuildStep = true, emit = () => {}, runtime = {} }) {
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
    const r = await waitForPreview(preview, runtime);
    if (!r.ready) blocking.push('Preview never reported ready');
    collapse(r.errors).forEach((e) => blocking.push(`Runtime error: ${e}`));
    const warned = collapse(r.consoleWarnings);
    warned.forEach((w) => warnings.push(`Console warning: ${w}`));
    if (warned.length) emit({ type: 'stage', stage: 'testing', detail: `console warnings, not blocking: ${warned.slice(0, 3).join(' · ')}` });
    checks.push('runtime');
    // 4b. Playtest probe (Q5): the canvas must actually change over time and the
    // page must react to input. A frozen/blank canvas is a blocking finding.
    if (typeof preview.playtestProbe === 'function') {
      const probe = await preview.playtestProbe().catch(() => null);
      if (probe && probe.ran) {
        emit({ type: 'playtest', canvas: probe.canvas, changed: probe.changed, rafTicks: probe.rafTicks, pageVisible: probe.pageVisible, empty: probe.empty, uniform: probe.uniform });
        if (!probe.canvas) warnings.push('Playtest probe: no <canvas> found; DOM-only games pass but are not visually verified');
        else if (probe.rafTicks !== undefined && probe.rafTicks <= 1) warnings.push('Playtest probe inconclusive: the page produced no animation frames (window hidden or compositor stalled)');
        else if (probe.changed === false && probe.empty) blocking.push('Playtest probe: the canvas was never drawn to (all pixels transparent) — the game is blank');
        else if (probe.changed === false && probe.uniform) warnings.push('Playtest probe: canvas is painted but static — check that the game updates over time and reacts to input');
        else if (probe.changed === false) warnings.push('Playtest probe: canvas did not change during the probe window — the game may be static or unresponsive');
        checks.push('playtest');
      }
    }
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
