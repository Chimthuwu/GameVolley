// Windows shim process-launch tests (spec P0 1.4). REAL child processes:
// a fake npm-style .cmd shim that echoes argv + stdin as JSON. Proves:
//  - .cmd shims actually launch (plain spawn would fail with EINVAL),
//  - argument boundaries are preserved (quotes/spaces/metacharacters),
//  - the untrusted prompt travels via stdin, never through the command string.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnPlan, quoteWinArg, isWindowsShim } = require('../lib/win-spawn.js');
const { streamProcess } = require('../src/main/agents/agent-process.js');
const { resolveExecutable } = require('../src/main/agents/executable-resolver.js');

const isWin = process.platform === 'win32';

async function makeShimDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-shim-'));
  // The real payload: prints argv + stdin as one JSON line.
  await fs.writeFile(path.join(dir, 'echo-args.js'),
    "let d='';process.stdin.setEncoding('utf8');" +
    "process.stdin.on('data',c=>d+=c);" +
    "process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:d}));});");
  // npm-style shim: forwards every argument to the payload.
  await fs.writeFile(path.join(dir, 'gvfake.cmd'), '@echo off\r\nnode "%~dp0echo-args.js" %*\r\n');
  await fs.writeFile(path.join(dir, 'gvfake.bat'), '@echo off\r\nnode "%~dp0echo-args.js" %*\r\n');
  return dir;
}

test('quoteWinArg preserves argument boundaries and neutralises metacharacters', () => {
  assert.strictEqual(quoteWinArg('plain'), 'plain');
  assert.strictEqual(quoteWinArg(''), '""');
  assert.strictEqual(quoteWinArg('arg with spaces'), '"arg with spaces"');
  assert.strictEqual(quoteWinArg('say "hi"'), '"say \\"hi\\""');
  assert.strictEqual(quoteWinArg('C:\\path with space\\x'), '"C:\\path with space\\x"');
  assert.strictEqual(quoteWinArg('trailing\\'), '"trailing\\\\"');
});

test('isWindowsShim detects only .cmd/.bat on Windows', () => {
  assert.strictEqual(isWindowsShim('claude.cmd'), isWin);
  assert.strictEqual(isWindowsShim('claude'), false);
  assert.strictEqual(isWindowsShim('node.exe'), false);
});

(isWin ? test : test.skip)('streamProcess launches a real .cmd shim with args + stdin intact', async () => {
  const dir = await makeShimDir();
  try {
    const res = await streamProcess({
      binary: path.join(dir, 'gvfake.cmd'),
      args: ['--flag', 'value with spaces', 'weird&|<>^chars', 'say "quoted"'],
      cwd: dir,
      stdinText: 'UNTRUSTED PROMPT TEXT & echo this-should-not-run',
      idleMs: 15000,
    });
    assert.strictEqual(res.exitCode, 0, `shim must launch (got ${JSON.stringify(res)})`);
    const parsed = JSON.parse(res.output);
    assert.deepEqual(parsed.argv, ['--flag', 'value with spaces', 'weird&|<>^chars', 'say "quoted"'],
      'argument boundaries and metacharacters must survive intact');
    assert.strictEqual(parsed.stdin, 'UNTRUSTED PROMPT TEXT & echo this-should-not-run',
      'the prompt must arrive via stdin, unmodified');
    assert.ok(!parsed.argv.some((a) => a.includes('this-should-not-run')), 'prompt never leaked into the command line');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

(isWin ? test : test.skip)('resolveExecutable finds a .cmd shim on PATH and it launches via streamProcess', async () => {
  const dir = await makeShimDir();
  try {
    const prevPath = process.env.PATH;
    process.env.PATH = `${dir};${prevPath}`;
    try {
      const found = resolveExecutable(['gvfake']);
      assert.ok(found && /\.cmd$/i.test(found.binary), `expected the .cmd shim, got ${JSON.stringify(found)}`);
      const res = await streamProcess({ binary: found.binary, args: [], cwd: dir, stdinText: 'hello', idleMs: 15000 });
      assert.strictEqual(res.exitCode, 0);
      assert.strictEqual(JSON.parse(res.output).stdin, 'hello');
    } finally {
      process.env.PATH = prevPath;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
