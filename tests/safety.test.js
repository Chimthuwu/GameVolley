'use strict';
// Safety rules from the 2026-11-26 audit: nothing gets permanently deleted by a
// rollback, Stop really stops, free text never reaches cmd.exe, and only the
// app's own page can use the app's powers.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CheckpointManager = require('../src/main/checkpoint-manager.js');
const ProjectManager = require('../src/main/project-manager.js');
const AgentManager = require('../src/main/agents/agent-manager.js');
const { streamProcess } = require('../src/main/agents/agent-process.js');
const CodingAgentBase = require('../src/main/agents/coding-agent-base.js');
const { resolveInside } = require('../src/main/lib/safe-path.js');
const { spawnPlan } = require('../lib/win-spawn.js');
const { hermesPlan } = require('../lib/hermes-handoff.js');
const { createWindowGuard } = require('../lib/window-guard.js');
const providers = require('../lib/providers.js');

const ROOT = path.join(__dirname, '..');
const isWin = process.platform === 'win32';
const winTest = isWin ? test : test.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const made = [];
function tmp(name = 'safety') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gv-${name}-`));
  made.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------- rollback never destroys anything ----------

test('restore moves newer files aside and keeps every version it replaces', async () => {
  const project = tmp('proj');
  const cm = new CheckpointManager({ snapshotRoot: tmp('snap') });
  write(project, 'index.html', 'v1');
  const cp = await cm.create(project, 'v1');
  write(project, 'index.html', 'v2 with my edits');
  write(project, 'art/level.png', 'hours of work');
  write(project, 'constructor', 'a file named like an object property');

  const res = await cm.restore(project, cp.id);

  assert.strictEqual(read(project, 'index.html'), 'v1');
  assert.ok(!fs.existsSync(path.join(project, 'art/level.png')));
  assert.strictEqual(read(res.recoveryDir, 'art/level.png'), 'hours of work');
  assert.strictEqual(read(res.recoveryDir, 'constructor'), 'a file named like an object property');
  assert.strictEqual(read(res.recoveryDir, 'index.html'), 'v2 with my edits');
  assert.strictEqual(res.moved.length, 2);
  assert.deepStrictEqual(res.replaced, ['index.html']);
  assert.strictEqual((await cm.list(project)).length, 1, 'the recovery folder is not listed as a checkpoint');
});

test('a restore with nothing to change reports no recovery folder', async () => {
  const project = tmp('proj');
  const cm = new CheckpointManager({ snapshotRoot: tmp('snap') });
  write(project, 'index.html', 'same');
  const cp = await cm.create(project);
  const res = await cm.restore(project, cp.id);
  assert.strictEqual(res.recoveryDir, null);
});

test('crafted checkpoint ids cannot reach outside the snapshot store', async () => {
  const project = tmp('proj');
  const cm = new CheckpointManager({ snapshotRoot: tmp('snap') });
  const victim = tmp('victim');
  write(victim, 'important.txt', 'x');
  const crafted = path.relative(cm._projectDir(project), victim);
  for (const id of [crafted, '..', '../..', '', 'recovered', null]) {
    await assert.rejects(() => cm.remove(project, id), /Unknown checkpoint/);
    await assert.rejects(() => cm.restore(project, id), /Unknown checkpoint/);
  }
  assert.ok(fs.existsSync(path.join(victim, 'important.txt')));
});

test('a snapshot that cannot read the project fails instead of being incomplete', async () => {
  const notAFolder = path.join(tmp(), 'file.txt');
  fs.writeFileSync(notAFolder, 'x');
  const cm = new CheckpointManager({ snapshotRoot: tmp('snap') });
  await assert.rejects(() => cm.create(notAFolder), /could not read/i);
});

test('Create Game refuses a folder with files, but accepts an effectively empty one', async () => {
  const busy = tmp('busy');
  write(busy, 'holiday-photos/beach.jpg', 'x');
  await assert.rejects(() => new ProjectManager(() => {}).createProject(busy, { idea: 'x' }), /already has files/);
  assert.ok(!fs.existsSync(path.join(busy, '.gamevolley')), 'nothing was written into the refused folder');

  const empty = tmp('empty');
  write(empty, '.gamevolley/meta.json', '{}');
  write(empty, 'desktop.ini', 'x');
  fs.mkdirSync(path.join(empty, 'left-over', 'by-a-rollback'), { recursive: true });
  await new ProjectManager(() => {}).createProject(empty, { idea: 'x' });
});

const stubProviders = { getProvider: () => ({ chat: async () => ({ text: 'brief' }), getModels: async () => [{ id: 'm' }] }) };
const roles = { developer: { agent: 'claude' }, creativeDirector: { model: 'm' }, critic: { model: 'm' } };

test('a failed build keeps unrelated files that appeared during it, and says where', async () => {
  const dir = tmp('build');
  const pm = new ProjectManager(() => {});
  pm.checkpoints.setSnapshotRoot(tmp('snap'));
  await pm.createProject(dir, { idea: 'x' });
  const agent = { runTask: async () => {
    write(dir, 'arrived-during-build.zip', 'a download that finished mid-build');
    throw new Error('simulated agent failure');
  } };
  const events = [];
  const manager = new AgentManager({ providers: stubProviders, agents: { claude: agent }, projectManager: pm });
  await assert.rejects(() => manager.createGame({ idea: 'x', projectPath: dir, roles, onEvent: (e) => events.push(e) }), /simulated/);
  const restored = events.find((e) => e.type === 'restored');
  assert.ok(restored && restored.recoveryDir, 'the rollback is reported');
  assert.ok(restored.message.includes(restored.recoveryDir));
  assert.strictEqual(read(restored.recoveryDir, 'arrived-during-build.zip'), 'a download that finished mid-build');
});

test('no safety snapshot means the agent never runs, and the build lock is released', async () => {
  const dir = tmp('build');
  const pm = new ProjectManager(() => {});
  pm.checkpoints.create = async () => { throw new Error('disk full'); };
  let ran = false;
  const manager = new AgentManager({ providers: stubProviders, agents: { claude: { runTask: async () => { ran = true; } } }, projectManager: pm });
  await assert.rejects(() => manager.createGame({ idea: 'x', projectPath: dir, roles }), /nothing was changed.*disk full/s);
  assert.strictEqual(ran, false);
  assert.strictEqual(pm._buildInProgress, false);
});

// ---------- Stop really stops ----------

// A program that appends to beat.txt five times a second for up to 8 seconds.
function heartbeat(dir) {
  write(dir, 'agent.js', "const fs=require('fs');let n=0;const t=setInterval(()=>{fs.appendFileSync('beat.txt','x');console.log('working');if(++n>=40)process.exit(0)},200);");
  return () => { try { return fs.statSync(path.join(dir, 'beat.txt')).size; } catch { return 0; } };
}
async function waitForBeat(size) {
  for (let i = 0; i < 100 && size() < 2; i++) await sleep(100);
  assert.ok(size() >= 2, 'the fake agent started');
}

winTest('Stop ends the real program behind a .cmd shim, not just cmd.exe', async () => {
  const dir = tmp('stop');
  const size = heartbeat(dir);
  write(dir, 'fake-agent.cmd', `@echo off\r\n"${process.execPath}" agent.js\r\n`);
  const ctl = new AbortController();
  const run = streamProcess({ binary: path.join(dir, 'fake-agent.cmd'), args: [], cwd: dir, signal: ctl.signal });
  await waitForBeat(size);
  const pressed = Date.now();
  ctl.abort();
  const result = await run;
  assert.strictEqual(result.aborted, true);
  assert.ok(Date.now() - pressed < 4000, 'the app hears back promptly');
  const stopped = size();
  await sleep(900);
  assert.strictEqual(size(), stopped, 'nothing is still writing');
});

test('a run that is already stopped never starts the program', async () => {
  const dir = tmp('stop');
  const size = heartbeat(dir);
  const ctl = new AbortController();
  ctl.abort();
  const result = await streamProcess({ binary: process.execPath, args: ['agent.js'], cwd: dir, signal: ctl.signal });
  assert.strictEqual(result.aborted, true);
  await sleep(500);
  assert.strictEqual(size(), 0);
});

function fakeCli(script) {
  providers.init({ IDLE_MS: 30000 });
  const dir = tmp('cli');
  write(dir, 'fake-cli.js', script);
  const cli = new providers.CliProvider('t', 'Fake CLI', { binaries: ['node'], models: [] });
  cli.script = path.join(dir, 'fake-cli.js'); // the module's own test hook
  return cli;
}

test('Stop cancels a CLI chat role instead of letting it finish', async () => {
  const cli = fakeCli("setTimeout(()=>console.log(JSON.stringify({type:'result',result:'finished anyway'})),6000);");
  const ctl = new AbortController();
  const chat = cli.chat({ messages: [{ role: 'user', content: 'x' }], signal: ctl.signal });
  await sleep(500);
  const pressed = Date.now();
  ctl.abort();
  await assert.rejects(chat, (e) => e.cancelled === true && /aborted/.test(e.message));
  assert.ok(Date.now() - pressed < 4000);
});

test('the model-swap abort hook also ends a CLI chat call', async () => {
  const cli = fakeCli("setTimeout(()=>console.log(JSON.stringify({type:'result',result:'finished anyway'})),6000);");
  let swap = null;
  const chat = cli.chat({ messages: [{ role: 'user', content: 'x' }], onCtl: (abort) => { swap = abort; } });
  await sleep(500);
  swap();
  await assert.rejects(chat, (e) => e.cancelled === true);
});

test('main.js stops running work when the app quits', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), /app\.on\('before-quit',[^\n]*currentGame\?\.ctl\.abort\(\)/);
});

// ---------- free text never reaches cmd.exe ----------

winTest('arguments cmd.exe could run or cut short are refused for .cmd programs', () => {
  const bad = ['Add a 6" ruler & echo ran>INJECTED.txt & rem', 'say "hi"', 'key is %USERPROFILE%', 'line one\nline two', 'a\rb'];
  for (const arg of bad) assert.throws(() => spawnPlan('tool.cmd', ['-q', arg]), /Refusing to run "tool\.cmd"/, arg);
  assert.doesNotThrow(() => spawnPlan('C:\\Program Files (x86)\\x\\tool.cmd', ['--model', 'openai/gpt-5:free', 'a & b | c']));
  assert.doesNotThrow(() => spawnPlan('tool.exe', bad), 'real programs get arguments directly, with no shell');
});

winTest('a system prompt for a .cmd agent travels on stdin, not as an argument', async () => {
  const dir = tmp('shim');
  write(dir, 'dump.js', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify({argv:process.argv.slice(2),stdin:d})));");
  write(dir, 'gvfake-agent.cmd', `@echo off\r\n"${process.execPath}" "%~dp0dump.js" %*\r\n`);
  class Agent extends CodingAgentBase {
    buildArgs({ system }) { return system ? ['--system', system] : []; }
  }
  const agent = new Agent({ id: 'x', name: 'X', binaries: [path.join(dir, 'gvfake-agent.cmd')] });
  const res = await agent.runTask({ projectPath: dir, system: 'RULES "quoted"\nline two', prompt: 'TASK 100%' });
  const seen = JSON.parse(res.output.trim().split('\n').pop());
  assert.deepStrictEqual(seen.argv, []);
  assert.strictEqual(seen.stdin, 'RULES "quoted"\nline two\n\nTASK 100%');
});

test('Send to Hermes starts the real program with no shell and keeps the whole prompt', () => {
  const prompt = 'Line one: a 6" ruler & calc\nLine two %PATH%\nLine three';
  const plan = hermesPlan(prompt, 'win32');
  assert.strictEqual(plan.file, 'hermes.exe');
  assert.deepStrictEqual(plan.args, ['chat', '-q', prompt]);
  assert.strictEqual(plan.options.shell, false);
  assert.throws(() => hermesPlan('x'.repeat(40000), 'win32'), /too long/);
  assert.throws(() => hermesPlan('   ', 'win32'), /Nothing to send/);
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(!main.includes('hermes.cmd') && !main.includes('spawnPlan'), 'main.js has no cmd.exe launch path');
});

// ---------- only the app's own page gets the app's powers ----------

const appIndex = path.join(ROOT, 'renderer', 'index.html');
const appUrl = pathToFileURL(appIndex).href;
const outsiders = [
  pathToFileURL(path.join(os.tmpdir(), 'dropped.html')).href,
  pathToFileURL(path.join(os.tmpdir(), 'renderer', 'index.html')).href,
  'https://example.test/renderer/index.html', 'file://server/share/renderer/index.html', 'about:blank', '', undefined,
];

test('the window may only stay on the app page, and only https links leave it', () => {
  const guard = createWindowGuard(appIndex);
  assert.ok(guard.isAppUrl(appUrl) && guard.isAppUrl(`${appUrl}#settings`) && guard.isAppUrl(`${appUrl}?x=1`));
  for (const url of outsiders) assert.ok(!guard.isAppUrl(url), String(url));

  const handlers = {};
  let opener = null;
  const opened = [];
  guard.guardWindow(
    { webContents: { on: (name, fn) => { handlers[name] = fn; }, setWindowOpenHandler: (fn) => { opener = fn; } } },
    { openExternal: (url) => opened.push(url) },
  );
  const blocked = (url) => { let hit = false; handlers['will-navigate']({ preventDefault: () => { hit = true; } }, url); return hit; };
  assert.strictEqual(blocked(outsiders[0]), true);
  assert.strictEqual(blocked(appUrl), false);
  for (const url of ['file:///C:/Windows/notepad.exe', 'ms-settings:', 'http://example.test', 'https://example.test/ok']) {
    assert.deepStrictEqual(opener({ url }), { action: 'deny' });
  }
  assert.deepStrictEqual(opened, ['https://example.test/ok']);
});

test('requests from any other page are refused before the handler runs', () => {
  const registered = {};
  const ipc = { handle: (channel, fn) => { registered[channel] = fn; } };
  createWindowGuard(appIndex).guardIpc(ipc);
  let calls = 0;
  ipc.handle('agent:start', (_e, value) => { calls++; return value; });
  assert.strictEqual(registered['agent:start']({ senderFrame: { url: appUrl } }, 'ok'), 'ok');
  for (const url of outsiders) {
    assert.throws(() => registered['agent:start']({ senderFrame: { url } }, 'x'), /did not come from GameVolley/);
  }
  assert.throws(() => registered['agent:start']({ senderFrame: null }), /did not come from/);
  assert.strictEqual(calls, 1);
});

test('main.js guards requests before registering any, and guards the window', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const guardedAt = main.indexOf('windowGuard.guardIpc(ipcMain)');
  const firstHandler = main.search(/^[ \t]*ipcMain\.handle\(/m); // real calls, not comments
  assert.ok(guardedAt > -1 && firstHandler > -1);
  assert.ok(guardedAt < firstHandler);
  assert.ok(main.includes('windowGuard.guardWindow(win, shell)'));
});

test('model-written paths cannot reach protected folders by any spelling', () => {
  const root = tmp('paths');
  for (const bad of ['.GIT/hooks/pre-commit', '.git./hooks/x', '.git /x', 'sub/.git/hooks/x', 'GIT~1/hooks/x', '.git::$INDEX_ALLOCATION/x', 'a/NODE_MODULES/x', '.GameVolley/meta.json', 'file.txt:stream']) {
    assert.throws(() => resolveInside(root, bad), /reserved/, bad);
  }
  for (const ok of ['index.html', '.gitignore', 'src/.github-notes.md', 'git/readme.md', 'js/node_modules_info.js']) {
    assert.doesNotThrow(() => resolveInside(root, ok), ok);
  }
});

// ---------- GameVolley cannot publish over VolleyPrompt ----------

test('nothing in this repo deploys to the VolleyPrompt Pages project', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!Object.values(pkg.scripts).some((s) => /pages deploy|wrangler deploy/.test(s)));
  const workflows = path.join(ROOT, '.github', 'workflows');
  for (const name of fs.readdirSync(workflows)) {
    assert.ok(!/volley-prompt|pages deploy|wrangler/.test(fs.readFileSync(path.join(workflows, name), 'utf8')), name);
  }
  assert.ok(!/"name":\s*"volley-?prompt"/.test(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8')));
});
