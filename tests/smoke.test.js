// Smoke test: loads the real renderer (index.html + app.js) in jsdom, mocks the `pv`
// bridge, and verifies the multi-provider UI renders and wires up without errors.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

// Strip <script> tags so we control execution and can eval app.js ourselves.
const htmlNoScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');

const PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter', authType: 'api_key' },
  { id: 'anthropic', name: 'Anthropic', authType: 'api_key' },
  { id: 'openai', name: 'OpenAI', authType: 'api_key' },
  { id: 'google', name: 'Google Gemini', authType: 'api_key' },
  { id: 'ollama', name: 'Ollama (Local)', authType: 'local' },
];

function makePv() {
  const handler = (name) => {
    switch (name) {
      case 'hasKey': return () => Promise.resolve(false);
      case 'keyState': return () => Promise.resolve({ configured: false });
      case 'models':
        return () => Promise.resolve([{ id: 'openai/gpt-4o', perM: 0, isFree: true, isStealth: false, vision: true }]);
      case 'providersList': return () => Promise.resolve(PROVIDERS);
      case 'providersStatus':
        return () => Promise.resolve({ openrouter: { connected: false }, anthropic: { connected: false }, openai: { connected: false }, google: { connected: false }, ollama: { connected: false } });
      case 'providerCredsSave': return (_id, val) => Promise.resolve({ present: !!val, masked: val ? '••••1234' : '' });
      case 'providerConnect': return () => Promise.resolve({ ok: true, models: [{ id: 'm1', name: 'm1', isFree: true, supportsVision: true }] });
      case 'providerModels': return () => Promise.resolve([{ id: 'm1', name: 'm1', isFree: true, supportsVision: true }]);
      case 'runs': return () => Promise.resolve([]);
      case 'projects': return () => Promise.resolve([]);
      case 'openRun': return () => Promise.resolve({ final: '' });
      case 'utility': return () => Promise.resolve({ text: 'x', usage: { total_tokens: 1 }, elapsedMs: 1 });
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

  // Canvas getContext stub: jsdom has no 2D context, and app.js draws a metrics chart.
  if (window.HTMLCanvasElement) {
    const ctxStub = new Proxy({}, {
      get(_t, p) {
        if (p === 'measureText') return () => ({ width: 0 });
        if (p === 'getImageData') return () => ({ data: [] });
        if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: () => {} });
        if (p === 'canvas') return { width: 300, height: 150 };
        return () => {};
      },
      set() { return true; },
    });
    window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
  }

  try {
    window.eval(appJs);
  } catch (e) {
    errors.push('eval threw: ' + e.message);
  }

  // Let async init (populateProviderSelects) resolve.
  await new Promise((r) => setTimeout(r, 300));

  const $ = (id) => window.document.getElementById(id);
  const assert = (cond, label) => { if (!cond) errors.push('ASSERT FAILED: ' + label); else console.log('  ok: ' + label); };

  // 1. Provider selects populated (5 options each).
  for (const id of ['authorProvider', 'criticProvider', 'setWriterProvider', 'setCriticProvider', 'setFallbackProvider']) {
    const sel = $(id);
    assert(sel && sel.options.length === 5, `${id} has 5 provider options (got ${sel ? sel.options.length : 'none'})`);
  }
  // 2. Open the settings page -> renders provider cards.
  try { if (typeof window.openSettings === 'function') window.openSettings(); } catch (e) { errors.push('openSettings threw: ' + e.message); }
  await new Promise((r) => setTimeout(r, 300));
  const cards = window.document.querySelectorAll('#providerList .provider-card');
  assert(cards.length === 5, `#providerList rendered 5 provider cards (got ${cards.length})`);
  // 3. Simulate connecting Anthropic: type a key, click "Test & connect".
  const anthropicCard = [...cards].find((c) => c.querySelector('.provider-name')?.textContent === 'Anthropic');
  assert(!!anthropicCard, 'Anthropic card present');
  if (anthropicCard) {
    const inp = anthropicCard.querySelector('.provider-key');
    inp.value = 'sk-ant-test';
    const act = [...anthropicCard.querySelectorAll('button')].find((b) => /connect/i.test(b.textContent));
    assert(!!act, 'Anthropic connect button present');
    if (act) { act.click(); }
    await new Promise((r) => setTimeout(r, 300));
    const msg = anthropicCard.querySelector('.provider-msg');
    assert(msg && /connected/i.test(msg.textContent), 'Anthropic connect reported connected (msg: ' + (msg && msg.textContent) + ')');
  }

  console.log('\nProvider UI smoke test: ' + (errors.length ? 'FAILED' : 'PASSED'));
  if (errors.length) { errors.forEach((e) => console.log('  ✗ ' + e)); process.exit(1); }
  process.exit(0);
})();
