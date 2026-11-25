// Audit-quality regression harness (Q0, from the 2026-11-26 game-quality audit).
// Runs the REAL AgentManager + ProjectManager + ProviderDevAgent + PreviewManager
// (real Electron WebContentsView) against a scripted fake AI provider and asserts
// what the pipeline must and must not accept.
//
// Run with:  node_modules/.bin/electron tests/e2e/audit-quality.js
// (NOT part of `npm test` — it launches Electron.)
//
// Known-bad scenarios are asserted INVERTED (they must still be bad today) so the
// file passes now and turns red the moment a fix lands — at which point the
// inverted assertion must be flipped into a real one. Marked KNOWN-BAD below:
//   blank      — a black-canvas game still passes validation (fix: Q5 playtest probe)
//   lateCrash  — a runtime error 3s after load is still missed (fix: Q4 longer settle)
//   critic-loop— round-2 dev prompt still lacks the existing code (fix: Q2)
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const P = path.join(__dirname, '..', '..');
const AgentManager = require(path.join(P, 'src', 'main', 'agents', 'agent-manager.js'));
const ProjectManager = require(path.join(P, 'src', 'main', 'project-manager.js'));
const PreviewManager = require(path.join(P, 'src', 'main', 'preview-manager.js'));

const GAMES = {
  good: `<!doctype html><html><body style="margin:0;background:#111"><canvas id="c" width="640" height="400"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');let px=300,score=0,state='playing';const keys={};
addEventListener('keydown',e=>keys[e.key]=1);addEventListener('keyup',e=>keys[e.key]=0);
let orbs=[{x:100,y:100}],last=0;
function loop(t){const dt=Math.min(0.05,(t-last)/1000);last=t;if(keys.ArrowLeft)px-=300*dt;if(keys.ArrowRight)px+=300*dt;
x.fillStyle='#111';x.fillRect(0,0,640,400);x.fillStyle='#0ff';x.fillRect(px,360,40,10);
for(const o of orbs){o.y+=80*dt;x.fillStyle='#f0f';x.beginPath();x.arc(o.x,o.y,8,0,7);x.fill();if(o.y>360&&Math.abs(o.x-px-20)<30){score++;o.y=0;o.x=Math.random()*600}}
x.fillStyle='#fff';x.fillText('score '+score,10,20);requestAnimationFrame(loop)}requestAnimationFrame(loop);
</script></body></html>`,
  // Loop runs, nothing is ever drawn, no input handler at all: a "game" that is a black rectangle.
  blank: `<!doctype html><html><body><canvas id="c" width="640" height="400"></canvas><script>
const x=document.getElementById('c').getContext('2d');function loop(){requestAnimationFrame(loop)}requestAnimationFrame(loop);
</script></body></html>`,
  // Throws a runtime error 3s after load (e.g. a bug on first spawn/collision). Gate settles after ~1.5s.
  lateCrash: `<!doctype html><html><body><canvas id="c"></canvas><script>
function loop(){requestAnimationFrame(loop)}requestAnimationFrame(loop);
setTimeout(()=>{ undefinedFunctionCall(); },3000);
</script></body></html>`,
  // Perfectly normal game that creates an AudioContext on load (very common for "sound effects").
  audio: `<!doctype html><html><body><canvas id="c" width="300" height="200"></canvas><script>
const ac=new (window.AudioContext||window.webkitAudioContext)();
const x=document.getElementById('c').getContext('2d');let t0=0;
function loop(t){x.fillStyle='#0a0';x.fillRect(0,0,300,200);requestAnimationFrame(loop)}requestAnimationFrame(loop);
addEventListener('keydown',()=>ac.resume());
</script></body></html>`,
  // Uses a CDN script (Three.js style).
  cdn: `<!doctype html><html><body><script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script><script>
document.title = (typeof THREE!=='undefined')?'three-ok':'three-missing';
function loop(){requestAnimationFrame(loop)}requestAnimationFrame(loop);
</script></body></html>`,
  // Syntax-valid but references a missing local file.
  missingRef: `<!doctype html><html><body><script src="game.js"></script></body></html>`,
};

function devFiles(html) { return `=== FILE: index.html ===\n${html}\n=== END FILE ===`; }

async function runScenario(name, html, criticScript) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-audit-'));
  const log = { calls: [], events: [] };
  let devCalls = 0, criticCalls = 0;
  const fake = {
    getModels: async () => [{ id: 'fake', isFree: true }],
    chat: async ({ system, messages }) => {
      const sys = String(system || '');
      const user = messages[messages.length - 1].content;
      if (/Creative Director/.test(sys)) { log.calls.push({ role: 'director', user }); return { text: 'BRIEF: a small arcade game. FILE PLAN: index.html' }; }
      if (/QA Critic/.test(sys)) {
        criticCalls++;
        log.calls.push({ role: 'critic', n: criticCalls, userLen: user.length, user });
        return { text: criticScript(criticCalls) };
      }
      devCalls++;
      log.calls.push({ role: 'dev', n: devCalls, user, systemLen: sys.length });
      return { text: devFiles(html) };
    },
  };
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  const pm = new ProjectManager(() => {});
  try { pm.checkpoints.setSnapshotRoot(path.join(tmp, '_cp')); } catch {}
  const preview = new PreviewManager({ window: win, onEvent: () => {} });
  const mgr = new AgentManager({
    providers: { getProvider: () => fake }, agents: {}, projectManager: pm,
    hooks: {
      loadPreview: ({ projectPath, entry }) => preview.loadProject({ projectPath, entry }).catch(() => {}),
      getPreview: () => preview,
    },
  });
  const proj = path.join(tmp, 'game'); fs.mkdirSync(proj, { recursive: true });
  const t0 = Date.now();
  let out, err;
  try {
    out = await mgr.createGame({
      idea: 'test', projectPath: proj,
      roles: { creativeDirector: { provider: 'x' }, critic: { provider: 'x' }, developer: { agent: 'prov:fake' } },
      signal: new AbortController().signal, maxRounds: 3,
      onEvent: (e) => log.events.push(e),
    });
  } catch (e) { err = e; }
  const val = log.events.filter((e) => e.type === 'validation:failed').map((e) => e.blocking);
  await preview.close();
  win.destroy();
  return { name, ms: Date.now() - t0, completed: out && out.completed, rounds: out && out.rounds, err: err && err.message, validationFailures: val, devCalls, criticCalls, log, projFiles: fs.existsSync(proj) ? fs.readdirSync(proj) : [] };
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const errors = [];
  const flipped = [];
  const assert = (cond, label) => { if (!cond) errors.push('ASSERT FAILED: ' + label); else console.log('  ok: ' + label); };
  // Inverted assertion for a KNOWN-BAD behaviour: passes while the behaviour is
  // still bad, fails once a fix lands (flip it into a real assertion then).
  const assertKnownBad = (badStillTrue, label) => {
    if (badStillTrue) console.log('  ok (KNOWN-BAD, expected-fail): ' + label);
    else { flipped.push(label); errors.push('FLIPPED — behaviour was fixed, update this harness: ' + label); }
  };
  const shipAt1 = () => 'Looks great.\nVERDICT: SHIP';

  const results = [];
  for (const k of ['good', 'blank', 'lateCrash', 'audio', 'cdn', 'missingRef']) {
    const r = await runScenario(k, GAMES[k], shipAt1);
    results.push(r);
    console.log(`\n=== ${k} === completed=${r.completed} rounds=${r.rounds} err=${r.err || '-'} ms=${r.ms}`);
    console.log('  validation failures per round:', JSON.stringify(r.validationFailures));
    console.log('  files left in project after run:', JSON.stringify(r.projFiles));

    if (k === 'good' || k === 'audio' || k === 'cdn') {
      assert(r.completed === true, `${k}: a working game completes the pipeline`);
    } else if (k === 'missingRef') {
      assert(r.completed !== true, 'missingRef: a game referencing a missing file must not complete');
    } else if (k === 'blank') {
      assertKnownBad(r.completed === true, 'blank: black-canvas game still passes validation (Q5 must fail it)');
    } else if (k === 'lateCrash') {
      assertKnownBad(r.completed === true, 'lateCrash: runtime error 3s after load still missed (Q4 must fail it)');
    }
  }

  // Scenario: critic always finds a MED issue -> does round 2 dev prompt contain the existing code?
  const r2 = await runScenario('critic-loop', GAMES.good, (n) => '[MED] enemies are too slow\nVERDICT: NEEDS-WORK');
  console.log(`\n=== critic-loop === completed=${r2.completed} rounds=${r2.rounds} devCalls=${r2.devCalls} files=${JSON.stringify(r2.projFiles)}`);
  const dev2 = r2.log.calls.filter((c) => c.role === 'dev')[1];
  assertKnownBad(dev2 && !/requestAnimationFrame/.test(dev2.user), 'critic-loop: round-2 dev prompt still lacks the existing code (Q2 must include it)');

  try { fs.writeFileSync(path.join(os.tmpdir(), 'gv-audit-results.json'), JSON.stringify(results.map(({ log, ...r }) => r), null, 2)); } catch {}

  console.log('\nAudit-quality harness: ' + (errors.length ? 'FAILED' : 'PASSED'));
  if (flipped.length) console.log('  (flipped known-bad assertions — flip them into real assertions in this file)');
  errors.forEach((e) => console.log('  x ' + e));
  app.quit();
  process.exitCode = errors.length ? 1 : 0;
});
