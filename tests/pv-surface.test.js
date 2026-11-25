// A1 audit: window.pv is the single environment-specific surface used by the shared UI.
// The desktop-only extras are GameVolley workspace methods that only the desktop tab uses.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function objectKeys(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `marker ${marker} found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(open + 1, end);
  const names = [];
  for (const match of body.matchAll(/(?:^|[\n,])\s*([A-Za-z_$][\w$]*)\s*(?::|\()/gm)) names.push(match[1]);
  return [...new Set(names)];
}

(async () => {
  const root = path.join(__dirname, '..');
  const desktop = objectKeys(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), 'exposeInMainWorld');
  const web = objectKeys(fs.readFileSync(path.join(root, 'src', 'web', 'pv.js'), 'utf8'), 'window.pv = {');

  // Every method the shared UI calls must exist on BOTH bridges.
  for (const name of ['copy', 'openUrl', 'hasKey', 'saveKey', 'start', 'stop', 'runs', 'onEvent']) {
    assert.ok(desktop.includes(name), `desktop bridge exposes ${name}`);
    assert.ok(web.includes(name), `web bridge exposes ${name}`);
  }
  // Sync lives on pv on desktop (main-process bridge) and on GameVolleyWebSync on web.
  const webSync = objectKeys(fs.readFileSync(path.join(root, 'src', 'web', 'pv.js'), 'utf8'), 'window.GameVolleyWebSync = {');
  for (const name of ['status', 'generate', 'enter', 'unpair', 'pull', 'push']) {
    assert.ok(webSync.includes(name), `web sync bridge exposes ${name}`);
  }
  for (const name of ['syncStatus', 'syncGenerate', 'syncEnter', 'syncUnpair', 'syncPull', 'syncPush']) {
    assert.ok(desktop.includes(name), `desktop bridge exposes ${name}`);
  }

  const desktopOnly = desktop.filter((k) => !web.includes(k));
  const gameVolleyOnly = desktopOnly.filter((k) =>
    /^(project|checkpoint|openDir|openRun|coding|agent|preview|gameOnEvent|sync|provider)/.test(k));
  assert.strictEqual(desktopOnly.length, gameVolleyOnly.length,
    'all desktop-only methods are GameVolley-workspace or sync methods, not shared-UI drift: ' + desktopOnly.join(', '));

  // The web build never loads gamevolley.js, so those extra methods are unreachable there.
  const webHtml = fs.readFileSync(path.join(root, 'src', 'web', 'index.html'), 'utf8');
  assert.ok(!webHtml.includes('gamevolley.js'), 'web shell does not load the desktop-only workspace script');

  console.log('pv-surface.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });
