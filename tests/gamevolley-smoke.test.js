// GameVolley renderer smoke test: loads the real index.html + gamevolley.js in
// jsdom with a mocked `pv` bridge and verifies the workspace renders, the Create /
// Improve / Fix and preview controls are wired, view-switching works, and the
// canonical Gemini provider id is consistent.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const gvJs = fs.readFileSync(path.join(ROOT, 'renderer', 'gamevolley.js'), 'utf8');
const historyJs = fs.readFileSync(path.join(ROOT, 'renderer', 'gamevolley-history.js'), 'utf8');
const RUN = {
  id: '20260101000000-abcdef', startedAt: 1767225600000, endedAt: 1767225660000, status: 'failed', mode: 'create',
  instruction: 'A hedgehog game <img src=x onerror=alert(1)>', projectName: 'hedgehog', projectPath: '/tmp/gvproj', roles: {},
  brief: 'THE DIRECTOR BRIEF', result: null, error: 'boom',
  entries: [
    { kind: 'output', role: 'director', text: 'THE DIRECTOR BRIEF' },
    { kind: 'output', role: 'developer', text: 'building files' },
    { kind: 'finding', severity: 'HIGH', text: 'no jump' },
  ],
};
let parkedBounds = null;
const htmlNoScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');

let gameEventSink = null; // captured GameVolley event listener

// Provider set reflects the REAL ids (gemini is canonical, not 'google').
const PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter', authType: 'api_key' },
  { id: 'anthropic', name: 'Claude (Claude Code CLI)', authType: 'cli', cliBinaries: ['claude'] },
  { id: 'openai', name: 'OpenAI', authType: 'api_key' },
  { id: 'gemini', name: 'Google Gemini (CLI)', authType: 'cli', cliBinaries: ['gemini', 'agy'] },
  { id: 'ollama', name: 'Ollama (Local)', authType: 'local' },
];

function makePv() {
  const handler = (name) => {
    switch (name) {
      case 'hasKey': return () => Promise.resolve(false);
      case 'keyState': return () => Promise.resolve({ configured: false });
      case 'models': return () => Promise.resolve([{ id: 'openai/gpt-4o', perM: 0, isFree: true, vision: true }]);
      case 'providersList': return () => Promise.resolve(PROVIDERS);
      case 'providersStatus': return () => Promise.resolve({ openrouter: { connected: false }, anthropic: { installed: false, cli: true }, openai: { connected: false }, gemini: { installed: false, cli: true }, ollama: { connected: false } });
      case 'providerCredsSave': return (_id, v) => Promise.resolve({ present: !!v, masked: v ? '••••' : '' });
      case 'providerConnect': return () => Promise.resolve({ ok: true, cli: false, models: [{ id: 'm1' }] });
      case 'providerModels': return () => Promise.resolve([{ id: 'm1' }]);
      case 'runs': return () => Promise.resolve([]);
      case 'projects': return () => Promise.resolve([]);
      case 'openRun': return () => Promise.resolve({ final: '' });
      case 'utility': return () => Promise.resolve({ text: 'x', usage: { total_tokens: 1 }, elapsedMs: 1 });
      // GameVolley surface:
      case 'projectGetActive': return () => Promise.resolve(null);
      case 'codingStatus': return () => Promise.resolve({ codex: { available: false, authenticated: false }, claude: { available: true, authenticated: true }, gemini: { available: false, authenticated: false } });
      case 'openDir': return () => Promise.resolve('/tmp/gvproj');
      case 'projectCreate': return (_p, _o) => Promise.resolve({ name: 'gvproj', path: '/tmp/gvproj' });
      case 'projectOpen': return (_p) => Promise.resolve({ name: 'gvproj', path: '/tmp/gvproj' });
      case 'projectListFiles': return () => Promise.resolve([]);
      case 'previewLoad': return () => Promise.resolve({ ok: true, entry: { type: 'file', path: 'index.html' } });
      case 'projectSummary': return () => Promise.resolve({ name: 'gvproj' });
      case 'projectEntry': return () => Promise.resolve({ type: 'file', path: 'index.html' });
      case 'checkpointList': return () => Promise.resolve([]);
      case 'agentStart': return () => Promise.resolve({ ok: true, started: true });
      case 'agentCancel': return () => Promise.resolve({ ok: true });
      case 'agentHistoryList': return () => Promise.resolve([RUN]);
      case 'agentHistoryRead': return () => Promise.resolve(RUN);
      case 'previewSetBounds': return (r) => { parkedBounds = r; return Promise.resolve({ ok: true }); };
      case 'gameOnEvent': return (cb) => { gameEventSink = cb; };
      default: return () => Promise.resolve({ ok: true });
    }
  };
  return new Proxy({}, { get: (_t, name) => handler(name) });
}

(async () => {
  const errors = [];
  const dom = new JSDOM(htmlNoScripts, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  window.pv = makePv();
  window.scrollTo = () => {};
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.confirm = () => true;
  window.onerror = (msg) => errors.push('window.onerror: ' + msg);
  process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e && e.message || e)));
  if (window.HTMLCanvasElement) {
    const ctxStub = new Proxy({}, { get(_t, p) { if (p === 'measureText') return () => ({ width: 0 }); if (p === 'getImageData') return () => ({ data: [] }); if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: () => {} }); if (p === 'canvas') return { width: 300, height: 150 }; return () => {}; }, set() { return true; } });
    window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
  }

  try { window.eval(appJs); } catch (e) { errors.push('app.js eval threw: ' + e.message); }
  try { window.eval(historyJs); } catch (e) { errors.push('gamevolley-history.js eval threw: ' + e.message); }
  try { window.eval(gvJs); } catch (e) { errors.push('gamevolley.js eval threw: ' + e.message); }

  await new Promise((r) => setTimeout(r, 400));

  const $ = (id) => window.document.getElementById(id);
  const assert = (cond, label) => { if (!cond) errors.push('ASSERT FAILED: ' + label); else console.log('  ok: ' + label); };

  assert($('gameRoot'), 'GameVolley workspace (#gameRoot) is present');
  assert($('gvCreate') && typeof $('gvCreate').onclick === 'function', 'Create Game button is wired');
  assert($('gvImprove') && typeof $('gvImprove').onclick === 'function', 'Improve button is wired');
  assert($('gvFix') && typeof $('gvFix').onclick === 'function', 'Fix Bug button is wired');
  assert($('gvStop') && typeof $('gvStop').onclick === 'function', 'Stop button is wired');
  assert($('gvReload') && typeof $('gvReload').onclick === 'function', 'Preview Reload is wired');
  assert($('gvFull') && typeof $('gvFull').onclick === 'function', 'Preview Fullscreen is wired');
  assert($('gvOpenFolder') && typeof $('gvOpenFolder').onclick === 'function', 'Open Folder is wired');

  // Build history: opens from the header, shows the saved conversation, closes again.
  assert($('gvHistoryBtn') && typeof $('gvHistoryBtn').onclick === 'function', 'History button is wired');
  await $('gvHistoryBtn').onclick();
  assert(!$('gvHistory').classList.contains('hidden'), 'History screen opens');
  assert(parkedBounds && parkedBounds.x > window.innerWidth, 'game preview is moved out of the way of the History screen');
  assert($('gvHistoryList').children.length === 1, 'saved run is listed');
  const shown = $('gvHistoryView').textContent;
  assert(shown.includes('A hedgehog game') && shown.includes('building files') && shown.includes('no jump') && shown.includes('boom'), 'run detail shows request, messages, findings and error');
  assert(shown.split('THE DIRECTOR BRIEF').length === 2, 'Director brief is shown once');
  assert(!$('gvHistoryView').querySelector('img'), 'saved text is never rendered as HTML');
  assert(window.GvHistoryUI.transcript(RUN).includes('## What happened'), 'transcript can be copied');
  $('gvHistoryReuse').onclick();
  assert($('gvIdea').value === RUN.instruction && $('gvHistory').classList.contains('hidden'), 'Reuse request fills the idea box and closes History');

  // View switching.
  $('tabVolley').onclick();
  assert(window.document.body.classList.contains('view-volley'), 'clicking Volley tab switches view');
  $('tabGame').onclick();
  assert(window.document.body.classList.contains('view-game'), 'clicking GameVolley tab switches back');

  // Provider id consistency: the director/critic selects must offer 'gemini'.
  const dirOpts = Array.from($('gvDirector').options).map((o) => o.value);
  assert(dirOpts.includes('gemini'), 'Gemini provider id is present and consistent');
  assert(!dirOpts.includes('google'), 'legacy "google" id is gone');

  // Empty / disconnected state.
  assert($('gvProjectName').textContent === 'No project open', 'empty state shows "No project open"');

  // Coding-agent status wired into the developer select (claude available, others disabled).
  const devOpts = Array.from($('gvDeveloper').options);
  const claude = devOpts.find((o) => o.value === 'claude');
  const codex = devOpts.find((o) => o.value === 'codex');
  assert(claude && !claude.disabled, 'installed coding agent (claude) is selectable');
  assert(codex && codex.disabled, 'uninstalled coding agent (codex) is disabled');

  // Event handler is registered and tolerant of known event types.
  const sink = gameEventSink;
  assert(typeof sink === 'function', 'gameOnEvent registered a listener');
  try { sink({ type: 'review:result', severity: 'MED', message: 'too dark' }); sink({ type: 'game:done', result: { rounds: 1 } }); } catch (e) { errors.push('event handler threw: ' + e.message); }

  // The end-of-build message must match the outcome.
  const lastLog = () => $('gvActivity').lastElementChild.textContent;
  sink({ type: 'game:done', result: { completed: true, rounds: 2, knownIssues: [] } });
  assert(lastLog().includes('Build complete in 2 round') && $('gvStatus').classList.contains('ok'), 'passing build reports success');
  sink({ type: 'game:done', result: { completed: false, rounds: 3, reason: 'Did not pass within the round limit', knownIssues: ['no jump'] } });
  assert(!lastLog().includes('Build complete') && lastLog().includes('didn’t pass after 3 round'), 'failed build is not reported as complete');
  assert(lastLog().includes('Did not pass within the round limit') && lastLog().includes('no jump'), 'failed build shows the reason and remaining issues');
  assert($('gvStatus').classList.contains('err') && !$('gvStatus').textContent.startsWith('Done'), 'failed build status line is an error');

  console.log('\nGameVolley smoke test: ' + (errors.length ? 'FAILED' : 'PASSED'));
  if (errors.length) { errors.forEach((e) => console.log('  x ' + e)); process.exit(1); }
  process.exit(0);
})();
