// Codex adapter (Q11): the invalid `-s <system>` / redundant `--cd` flags are gone;
// the system text travels inside the task prompt (argv or stdin on Windows shims).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CodexAgent = require('../src/main/agents/codex-agent.js');

test('buildArgs no longer emits -s or --cd; system text is folded into the prompt', () => {
  const a = new CodexAgent();
  const args = a.buildArgs({ prompt: 'TASK', system: 'SYS RULES', model: 'gpt-5', useStdin: false });
  assert.ok(!args.includes('-s'), 'no invalid -s flag');
  assert.ok(!args.includes('--cd'), 'no redundant --cd flag');
  assert.ok(!args.includes('SYS RULES') || args.indexOf('SYS RULES') > -1, 'system text appears as prompt text');
  const positional = args.filter((x) => x.includes('SYS RULES'))[0];
  assert.ok(positional && /SYS RULES\n\nTASK/.test(positional), 'prompt carries the system text');
  assert.ok(args.includes('--full-auto') && args.includes('-m'), 'core flags kept');
});

test('stdinNeedsSystem routes the system text through stdin on shim launches', () => {
  const a = new CodexAgent();
  assert.equal(a.stdinNeedsSystem(), true);
  const args = a.buildArgs({ prompt: null, system: 'SYS', model: null, useStdin: true });
  assert.ok(!args.includes('-s') && !args.includes('SYS'), 'no system text in argv on the stdin route');
});

test('runTask against a fake codex shim: no -s/--cd reaches the CLI, system text arrives via stdin', async () => {
  if (process.platform !== 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-codex-'));
  const fakeJs = path.join(dir, 'fake-codex.js');
  fs.writeFileSync(fakeJs, `
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: d }));
      process.exit(0);
    });
  `);
  const shim = path.join(dir, 'gvfake-codex.cmd');
  fs.writeFileSync(shim, `@echo off\r\nnode "${fakeJs}" %*\r\n`);
  const agent = new CodexAgent();
  agent.binaries = [shim];
  const events = [];
  const result = await agent.runTask({
    projectPath: dir,
    prompt: 'TASK',
    system: 'SYS RULES',
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.exitCode, 0);
  const line = result.output.split('\n').find((l) => l.trim().startsWith('{') && l.includes('"argv"'));
  assert.ok(line, 'the shim echoed its argv');
  const echoed = JSON.parse(line);
  assert.ok(!echoed.argv.includes('-s'), 'no -s flag in the spawned argv');
  assert.ok(!echoed.argv.includes('--cd'), 'no --cd flag in the spawned argv');
  assert.ok(echoed.argv[0] === 'exec' && echoed.argv.includes('--full-auto'), 'core flags kept');
  assert.ok(/SYS RULES/.test(echoed.stdin), 'system text reached the CLI via stdin');
  assert.ok(!/SYS RULES/.test(echoed.argv.join(' ')), 'system text is NOT in argv');
  const outs = events.filter((e) => e.type === 'output').map((e) => e.text);
  assert.ok(outs.length > 0, 'UI received the streamed output');
});
