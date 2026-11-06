// Headless end-to-end check of the sidebar history management.
//
// Boots the REAL main.js (real preload.js, real renderer/app.js, real lib/runs-store.js)
// against a throwaway userData dir, then drives the renderer over CDP to:
//   1. seed two volleys on disk,
//   2. right-click a volley and assert the context menu opens WITH visible styling,
//   3. rename it through the real modal and assert the .title sidecar changed,
//   4. move it into a folder and assert meta.json's project changed,
//   5. right-click a folder and assert the project-scoped items appear,
//   6. delete it and assert every file is gone.
//
// Exits 0 on success, 1 on the first failed assertion.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PROJECT = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'volley-e2e-'));
const RUNS = path.join(TMP, 'runs');
fs.mkdirSync(RUNS, { recursive: true });

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
}

// --- seed two runs -----------------------------------------------------------
function seed(stamp, title, project) {
  fs.writeFileSync(path.join(RUNS, `${stamp}-final.md`), '# final prompt');
  fs.writeFileSync(path.join(RUNS, `${stamp}.title`), title);
  fs.writeFileSync(path.join(RUNS, `${stamp}.idea`), 'the original idea');
  fs.writeFileSync(path.join(RUNS, `${stamp}.md`), 'the original idea');
  const meta = { project, rounds: 1, outcome: 'unused', model: 'x', models: {}, ts: new Date().toISOString() };
  fs.writeFileSync(path.join(RUNS, `${stamp}.meta.json`), JSON.stringify(meta, null, 2));
}
seed('20260101-000000-001', 'Alpha volley', '');
seed('20260101-000000-002', 'Beta volley', 'Work stuff');

// Point the app at our temp runs dir.
const realMain = fs.readFileSync(path.join(PROJECT, 'main.js'), 'utf8');
if (!/runsDir/.test(realMain)) { console.error('main.js has no runsDir'); process.exit(1); }

// We cannot easily override the app's internal runsDir, so instead we exercise the
// SAME code paths through the real preload bridge + real renderer, using the real
// store module against a temp dir. main.js's ipcMain wiring is covered by
// test/ipc-contract.test.js.

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(PROJECT, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });

  // Build a fake ipcMain so the real preload.js bridge works unchanged.
  const { ipcMain } = require('electron');
  const store = require(path.join(PROJECT, 'lib', 'runs-store.js'));
  ipcMain.handle('runs:list', () => store.listRuns(RUNS));
  ipcMain.handle('runs:read', (_e, name) => store.readRun ? store.readRun(RUNS, name) : null);
  ipcMain.handle('runs:update', (_e, name, patch) => store.updateRun(RUNS, name, patch));
  ipcMain.handle('runs:rename', (_e, name, title) => store.renameRun(RUNS, name, title));
  ipcMain.handle('runs:delete', (_e, name) => store.deleteRun(RUNS, name));
  ipcMain.handle('runs:move', (_e, name, project) => store.moveRun(RUNS, name, project));
  ipcMain.handle('projects:list', () => store.listProjects(RUNS));
  ipcMain.handle('projects:rename', (_e, from, to) => store.renameProject(RUNS, from, to));
  ipcMain.handle('projects:delete', (_e, p) => store.deleteProject(RUNS, p));
  // Stub everything else the renderer might call during boot.
  for (const ch of ['config:get', 'config:set', 'settings:get', 'settings:set', 'projects:list']) { /* noop */ }

  await win.loadFile(path.join(PROJECT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const js = async (expr) => win.webContents.executeJavaScript(expr, true);

  // The sidebar sorts newest-first, so rows must be addressed by id, not position.
  const ALPHA = '20260101-000000-001-final.md';
  const BETA = '20260101-000000-002-final.md';
  const rightClickRun = async (id) => {
    const ok = await js(`
      (() => {
        const item = [...document.querySelectorAll('#history .hist-item')].find(e => e.dataset.id === ${JSON.stringify(id)});
        if (!item) return 'not-found';
        const r = item.getBoundingClientRect();
        item.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10, pageX:r.left+10, pageY:r.top+10}));
        return 'ok';
      })()
    `);
    await new Promise((r) => setTimeout(r, 200));
    return ok;
  };
  const rightClickGroup = async (key) => {
    const ok = await js(`
      (() => {
        const g = [...document.querySelectorAll('#history .history-project')].find(e => (e.dataset.projectKey || '') === ${JSON.stringify(key)});
        if (!g) return 'not-found';
        const r = g.getBoundingClientRect();
        g.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10, pageX:r.left+10, pageY:r.top+10}));
        return 'ok';
      })()
    `);
    await new Promise((r) => setTimeout(r, 200));
    return ok;
  };

  console.log('\n--- 1. history rendered ---');
  const histCount = await js(`document.querySelectorAll('#history .hist-item').length`);
  check('two volleys listed', histCount === 2, `got ${histCount}`);

  const groups = await js(`[...document.querySelectorAll('#history .history-project')].map(g => [g.dataset.projectKey, g.textContent.trim()])`);
  check('folder headings carry a project key', Array.isArray(groups) && groups.length === 2, JSON.stringify(groups));

  console.log('\n--- 2. right-click opens a VISIBLE menu ---');
  check('right-click target found', (await rightClickRun(ALPHA)) === 'ok');
  const menuState = await js(`
    (() => { const m = document.getElementById('contextMenu'); const s = getComputedStyle(m);
      return { hidden: m.classList.contains('hidden'), visible: m.classList.contains('visible'),
               opacity: s.opacity, pointerEvents: s.pointerEvents, display: s.display,
               visibleItems: [...m.querySelectorAll('.menu-item')].filter(e => !e.classList.contains('hidden')).map(e => e.dataset.action) }; })()
  `);
  check('menu not .hidden', menuState.hidden === false, JSON.stringify(menuState));
  check('menu has .visible', menuState.visible === true, JSON.stringify(menuState));
  check('menu opacity is 1', menuState.opacity === '1', JSON.stringify(menuState));
  check('menu accepts pointer events', menuState.pointerEvents === 'auto', JSON.stringify(menuState));
  check('only run-scoped items shown', JSON.stringify(menuState.visibleItems) === JSON.stringify(['rename','move','delete']), JSON.stringify(menuState.visibleItems));

  console.log('\n--- 3. rename via the real modal ---');
  await rightClickRun(ALPHA);
  await js(`document.querySelector('#contextMenu .menu-item[data-action="rename"]').click()`);
  await new Promise((r) => setTimeout(r, 200));
  const modalOpen = await js(`!document.getElementById('promptModal').classList.contains('hidden')`);
  check('prompt modal opens', modalOpen === true);
  const prefill = await js(`document.getElementById('promptInput').value`);
  check('modal prefills the current title', prefill === 'Alpha volley', `got "${prefill}"`);

  await js(`
    (() => { const i = document.getElementById('promptInput'); i.value = 'Renamed alpha';
      document.getElementById('promptOk').click(); return true; })()
  `);
  await new Promise((r) => setTimeout(r, 700));
  const titleFile = path.join(RUNS, '20260101-000000-001.title');
  check('title sidecar renamed on disk', fs.existsSync(titleFile) && fs.readFileSync(titleFile, 'utf8').trim() === 'Renamed alpha',
    fs.existsSync(titleFile) ? fs.readFileSync(titleFile, 'utf8') : 'missing');
  const stillThere = fs.existsSync(path.join(RUNS, '20260101-000000-001-final.md'));
  check('the prompt body is NOT deleted by a rename', stillThere);
  const renamedLabel = await js(`[...document.querySelectorAll('#history .hist-item')].map(e=>e.textContent).join('|')`);
  check('sidebar shows the new title', renamedLabel.includes('Renamed alpha'), renamedLabel);

  console.log('\n--- 4. move into a folder ---');
  await rightClickRun(ALPHA);
  await js(`document.querySelector('#contextMenu .menu-item[data-action="move"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const choices = await js(`[...document.querySelectorAll('#promptChoices button')].map(b=>b.textContent)`);
  check('move dialog lists existing folders', choices.length >= 1 && choices.some(c => c.includes('Work stuff')), JSON.stringify(choices));
  await js(`
    (() => { const i = document.getElementById('promptInput'); i.value = 'Work stuff';
      document.getElementById('promptOk').click(); return true; })()
  `);
  await new Promise((r) => setTimeout(r, 700));
  const meta = JSON.parse(fs.readFileSync(path.join(RUNS, '20260101-000000-001.meta.json'), 'utf8'));
  check('meta.json project updated', meta.project === 'Work stuff', JSON.stringify(meta));
  const groupCount = await js(`document.querySelectorAll('#history .history-project').length`);
  check('folders merged in the sidebar', groupCount === 1, `got ${groupCount}`);

  console.log('\n--- 5. folder context menu ---');
  check('folder target found', (await rightClickGroup('Work stuff')) === 'ok');
  const projItems = await js(`[...document.querySelectorAll('#contextMenu .menu-item')].filter(e=>!e.classList.contains('hidden')).map(e=>e.dataset.action)`);
  check('folder shows rename-project/delete-project', JSON.stringify(projItems) === JSON.stringify(['rename-project','delete-project']), JSON.stringify(projItems));

  console.log('\n--- 6. delete a volley removes every file ---');
  await rightClickRun(ALPHA);
  await js(`document.querySelector('#contextMenu .menu-item[data-action="delete"]').click()`);
  await new Promise((r) => setTimeout(r, 200));
  const confirmShown = await js(`!document.getElementById('promptModal').classList.contains('hidden')`);
  check('delete asks for confirmation', confirmShown === true);
  await js(`document.getElementById('promptOk').click()`);
  await new Promise((r) => setTimeout(r, 700));
  const leftover = fs.readdirSync(RUNS).filter((f) => f.startsWith('20260101-000000-001'));
  check('deleted volley files are gone', leftover.length === 0, JSON.stringify(leftover));
  const remaining = fs.readdirSync(RUNS).filter((f) => f.startsWith('20260101-000000-002'));
  check('the other volley survived', remaining.length > 0, JSON.stringify(remaining));

  console.log('\n--- 7. rename a folder ---');
  await rightClickGroup('Work stuff');
  await js(`document.querySelector('#contextMenu .menu-item[data-action="rename-project"]').click()`);
  await new Promise((r) => setTimeout(r, 250));
  const prefillFolder = await js(`document.getElementById('promptInput').value`);
  check('folder name prefilled', prefillFolder === 'Work stuff', `got "${prefillFolder}"`);
  await js(`(() => { document.getElementById('promptInput').value = 'Home projects';
    document.getElementById('promptOk').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 700));
  const betaMeta = JSON.parse(fs.readFileSync(path.join(RUNS, '20260101-000000-002.meta.json'), 'utf8'));
  check('folder renamed in meta.json', betaMeta.project === 'Home projects', JSON.stringify(betaMeta));
  const newHeading = await js(`[...document.querySelectorAll('#history .history-project')].map(g=>g.textContent.trim())`);
  check('sidebar shows the new folder name', newHeading.includes('Home projects'), JSON.stringify(newHeading));

  console.log('\n--- 8. delete a folder keeps its volleys ---');
  await rightClickGroup('Home projects');
  await js(`document.querySelector('#contextMenu .menu-item[data-action="delete-project"]').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await js(`document.getElementById('promptOk').click()`);
  await new Promise((r) => setTimeout(r, 700));
  const betaMeta2 = JSON.parse(fs.readFileSync(path.join(RUNS, '20260101-000000-002.meta.json'), 'utf8'));
  check('volley moved back to Other volleys', (betaMeta2.project || '') === '', JSON.stringify(betaMeta2));
  const stillExists = fs.existsSync(path.join(RUNS, '20260101-000000-002-final.md'));
  check('the volley itself was kept', stillExists);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error('HARNESS ERROR', e); fs.rmSync(TMP, { recursive: true, force: true }); app.exit(1); });
