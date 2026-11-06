// Browser-side end-to-end check for the web build (site/).
// Loads site/index.html in Chromium with a localStorage shim and drives the same
// rename / move / delete flows the desktop build uses, proving site/pv.js's
// localStorage-backed mutations work.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PROJECT = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'volley-web-'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
}

const SEED = [
  { name: '20260101-000000-001', title: 'Alpha volley', path: 'local', final: '# final', idea: 'idea', incomplete: false, meta: { project: '', rounds: 1, outcome: 'unused' } },
  { name: '20260101-000000-002', title: 'Beta volley', path: 'local', final: '# final', idea: 'idea', incomplete: false, meta: { project: 'Work stuff', rounds: 1, outcome: 'unused' } },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(PROJECT, 'site', 'index.html'));

  // Seed localStorage for this origin.
  const seedScript = `localStorage.setItem('vp_history', ${JSON.stringify(JSON.stringify(SEED))});`;
  await win.webContents.executeJavaScript(seedScript, true);

  // Surface renderer errors so failures are diagnosable.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('   [renderer]', message);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('   [gone]', JSON.stringify(d)));

  await win.webContents.reload();
  await new Promise((r) => setTimeout(r, 1500));

  const js = async (expr) => win.webContents.executeJavaScript(expr, true);
  const raw = await js(`localStorage.getItem('vp_history')`);
  console.log('   [localStorage vp_history]', raw === null ? 'NULL' : String(raw).slice(0, 120));
  const lsLen = await js(`(localStorage.getItem('vp_history')||'').length`);
  console.log('   [length]', lsLen);
  const ALPHA = '20260101-000000-001';

  const readStore = async () => JSON.parse(await js(`localStorage.getItem('vp_history')`));

  console.log('\n--- web build: history rendered ---');
  const n = await js(`document.querySelectorAll('#history .hist-item').length`);
  check('two volleys listed', n === 2, `got ${n}`);

  console.log('\n--- web build: rename ---');
  await js(`
    (() => {
      const item = [...document.querySelectorAll('#history .hist-item')].find(e => e.dataset.id === '${ALPHA}');
      const r = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10, pageX:r.left+10, pageY:r.top+10}));
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
  const menuState = await js(`
    (() => { const m = document.getElementById('contextMenu'); const s = getComputedStyle(m);
      return { hidden: m.classList.contains('hidden'), visible: m.classList.contains('visible'), opacity: s.opacity,
               pointerEvents: s.pointerEvents,
               items: [...m.querySelectorAll('.menu-item')].filter(e=>!e.classList.contains('hidden')).map(e=>e.dataset.action) }; })()
  `);
  check('menu visible', menuState.visible === true && menuState.opacity === '1' && menuState.pointerEvents === 'auto', JSON.stringify(menuState));
  check('run-scoped items only', JSON.stringify(menuState.items) === JSON.stringify(['rename','move','delete']), JSON.stringify(menuState.items));

  await js(`document.querySelector('#contextMenu .menu-item[data-action="rename"]').click()`);
  await new Promise((r) => setTimeout(r, 250));
  check('prompt modal opens', (await js(`!document.getElementById('promptModal').classList.contains('hidden')`)) === true);
  check('prefilled', (await js(`document.getElementById('promptInput').value`)) === 'Alpha volley');
  await js(`(() => { document.getElementById('promptInput').value = 'Renamed alpha'; document.getElementById('promptOk').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 700));
  let store = await readStore();
  check('title persisted to localStorage', store.find(x => x.name === ALPHA).title === 'Renamed alpha', JSON.stringify(store.find(x => x.name === ALPHA)));

  console.log('\n--- web build: move ---');
  await js(`
    (() => {
      const item = [...document.querySelectorAll('#history .hist-item')].find(e => e.dataset.id === '${ALPHA}');
      const r = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10, pageX:r.left+10, pageY:r.top+10}));
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
  await js(`document.querySelector('#contextMenu .menu-item[data-action="move"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const choices = await js(`[...document.querySelectorAll('#promptChoices button')].map(b=>b.textContent)`);
  check('move dialog lists folders', choices.some(c => c.includes('Work stuff')), JSON.stringify(choices));
  await js(`(() => { document.getElementById('promptInput').value = 'Work stuff'; document.getElementById('promptOk').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 700));
  store = await readStore();
  check('project persisted', store.find(x => x.name === ALPHA).meta.project === 'Work stuff', JSON.stringify(store.find(x => x.name === ALPHA).meta));

  console.log('\n--- web build: delete ---');
  await js(`
    (() => {
      const item = [...document.querySelectorAll('#history .hist-item')].find(e => e.dataset.id === '${ALPHA}');
      const r = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10, pageX:r.left+10, pageY:r.top+10}));
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
  await js(`document.querySelector('#contextMenu .menu-item[data-action="delete"]').click()`);
  await new Promise((r) => setTimeout(r, 250));
  check('delete confirms', (await js(`!document.getElementById('promptModal').classList.contains('hidden')`)) === true);
  await js(`document.getElementById('promptOk').click()`);
  await new Promise((r) => setTimeout(r, 700));
  store = await readStore();
  check('volley removed from storage', !store.some(x => x.name === ALPHA), JSON.stringify(store.map(x=>x.name)));
  check('the other volley survived', store.some(x => x.name === '20260101-000000-002'));

  console.log(`\n${failures === 0 ? 'ALL WEB CHECKS PASSED' : failures + ' WEB CHECK(S) FAILED'}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error('HARNESS ERROR', e); app.exit(1); });
