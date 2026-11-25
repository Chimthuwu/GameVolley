// Theme preset regression test (T1/T2): loads the built renderer bundle in jsdom,
// clicks every preset swatch and asserts that every themed var in THEME_VARS is
// set, that the active swatch is marked, that sliders act as offsets on the
// chosen preset, and that Reset reproduces the preset exactly.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const htmlNoScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');

const PRESETS = ['synthwave', 'midnight', 'emerald', 'ember', 'mono', 'light'];
// The 16 vars a preset must define (mirrors THEME_VARS in src/shared/app-core.js).
const THEME_VARS = ['--bg', '--bg-glow', '--card', '--titlebar-from', '--panel', '--panel-hi', '--field', '--bg-wash', '--line', '--line-glow', '--neon-cyan', '--neon-magenta', '--neon-green', '--neon-purple', '--txt', '--dim'];

// Mirrors the smoke test's pv bridge: `models` must resolve to an array because
// refreshVisionHints feeds it straight into MODEL_ROWS.
const PROVIDERS = [{ id: 'openrouter', name: 'OpenRouter', authType: 'api_key', paid: true }];
function makePv() {
  const handler = (name) => {
    switch (name) {
      case 'hasKey': return () => Promise.resolve(false);
      case 'keyState': return () => Promise.resolve({ configured: false });
      case 'models': return () => Promise.resolve([{ id: 'openai/gpt-4o', perM: 0, isFree: true, isStealth: false, vision: true }]);
      case 'providersList': return () => Promise.resolve(PROVIDERS);
      case 'providersStatus': return () => Promise.resolve({});
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
    console.log('eval threw: ' + e.message);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 200));

  const doc = window.document;
  const assert = (cond, label) => { if (!cond) errors.push('ASSERT FAILED: ' + label); else console.log('  ok: ' + label); };
  const inline = () => doc.documentElement.style;
  const val = (name) => inline().getPropertyValue(name).trim();

  // Swatch row exists with one button per preset.
  const swatches = [...doc.querySelectorAll('#themeSwatches .theme-swatch')];
  assert(swatches.length === PRESETS.length, `swatch row has ${PRESETS.length} swatches (got ${swatches.length})`);
  assert(swatches.every((b) => PRESETS.includes(b.dataset.themePreset)), 'every swatch maps to a known preset');

  // Every preset sets ALL themed vars and flips color-scheme correctly.
  for (const preset of PRESETS) {
    const btn = swatches.find((b) => b.dataset.themePreset === preset);
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
    const missing = THEME_VARS.filter((v) => !val(v));
    assert(missing.length === 0, `${preset}: all ${THEME_VARS.length} themed vars set (missing: ${missing.join(', ') || 'none'})`);
    const scheme = inline().getPropertyValue('color-scheme').trim();
    assert(scheme === (preset === 'light' ? 'light' : 'dark'), `${preset}: color-scheme is ${preset === 'light' ? 'light' : 'dark'} (got '${scheme}')`);
    const activeBtns = doc.querySelectorAll('#themeSwatches .theme-swatch.active');
    assert(activeBtns.length === 1 && activeBtns[0].dataset.themePreset === preset, `${preset}: exactly its swatch is marked active`);
    assert(window.localStorage.getItem('themePreset') === preset, `${preset}: choice persisted to localStorage`);
  }

  // Known values: synthwave bg is the shipped default; light bg is readable-light.
  swatches.find((b) => b.dataset.themePreset === 'synthwave').click();
  await new Promise((r) => setTimeout(r, 20));
  assert(val('--bg') === '#080610', `synthwave --bg reproduces the preset verbatim (got '${val('--bg')}')`);
  swatches.find((b) => b.dataset.themePreset === 'light').click();
  await new Promise((r) => setTimeout(r, 20));
  assert(val('--bg') === '#f5f3f9', `light --bg reproduces the preset verbatim (got '${val('--bg')}')`);

  // Sliders act as offsets on the chosen preset.
  const hue = doc.getElementById('themeHue');
  hue.value = '90';
  hue.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const shifted = val('--neon-cyan');
  assert(shifted && shifted !== '#007f9e' && /hsl\(/i.test(shifted), `hue offset shifts --neon-cyan (got '${shifted}')`);
  hue.value = '0';
  hue.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(val('--neon-cyan') === '#007f9e', `returning the slider to 0 restores the preset exactly (got '${val('--neon-cyan')}')`);

  // Reset returns to the untouched preset even after heavier offsets.
  hue.value = '180';
  doc.getElementById('themeSat').value = '150';
  doc.getElementById('themeContrast').value = '130';
  [hue, doc.getElementById('themeSat'), doc.getElementById('themeContrast')].forEach((el) => el.dispatchEvent(new window.Event('input', { bubbles: true })));
  doc.getElementById('btnThemeReset').click();
  await new Promise((r) => setTimeout(r, 20));
  assert(val('--bg') === '#f5f3f9', `Reset returns to the untouched preset (got '${val('--bg')}')`);

  console.log('\nTheme preset test: ' + (errors.length ? 'FAILED' : 'PASSED'));
  if (errors.length) { errors.forEach((e) => console.log('  x ' + e)); process.exit(1); }
  process.exit(0);
})();
