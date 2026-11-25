// Claude Code adapter stream-json (Q7): buildArgs switches to
// --output-format stream-json --verbose, and a fake `claude` shim proves the
// adapter parses NDJSON into clean UI text (no raw JSON leaking to events)
// while result.output keeps the raw lines.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ClaudeCodeAgent = require('../src/main/agents/claude-code-agent.js');

const LINES = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'world' }, { type: 'tool_use', name: 'write' }] } }),
  JSON.stringify({ type: 'result', result: 'Hello world — done' }),
];

test('parseOutputLine extracts clean text and suppresses protocol lines', () => {
  const a = new ClaudeCodeAgent();
  assert.equal(a.parseOutputLine(LINES[0]), null, 'system/init line suppressed');
  assert.equal(a.parseOutputLine(LINES[1]), 'Hello ');
  assert.equal(a.parseOutputLine(LINES[2]), 'world');
  assert.equal(a.parseOutputLine(LINES[3]), 'Hello world — done');
  assert.equal(a.parseOutputLine('not json at all'), 'not json at all', 'plain text lines pass through');
});

test('buildArgs emits stream-json + verbose and keeps the stdin route', () => {
  const a = new ClaudeCodeAgent();
  const args = a.buildArgs({ prompt: null, system: 'SYS', model: 'sonnet', useStdin: true });
  assert.ok(args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'stream-json', 'stream-json flag present');
  assert.ok(args.includes('--verbose'), '--verbose present');
  assert.ok(args.includes('-p') && !args.includes('PROMPT-TEXT'), 'prompt travels via stdin, not argv');
  assert.ok(args.includes('--append-system-prompt'), 'system prompt flag kept');
});

test('runTask parses a fake claude shim emitting stream-json lines', async () => {
  if (process.platform !== 'win32') return; // shim test is Windows-shaped
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-claude-'));
  const fakeJs = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fakeJs, `
    const args = process.argv.slice(2);
    if (args.includes('--version')) { process.exit(0); }
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => {});
    for (const line of ${JSON.stringify(LINES)}) console.log(line);
    process.exit(0);
  `);
  const shim = path.join(dir, 'gvfake-claude.cmd');
  fs.writeFileSync(shim, `@echo off\r\nnode "${fakeJs}" %*\r\n`);

  // Use the ABSOLUTE shim path so resolveExecutable cannot pick up a REAL claude
  // on PATH; the adapter only needs this.binaries to point at the fake.
  const agent = new ClaudeCodeAgent();
  agent.binaries = [shim];
  const events = [];
  const result = await agent.runTask({
    projectPath: dir,
    prompt: 'make a game',
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes('"type":"result"'), 'raw NDJSON kept in result.output');
  const outs = events.filter((e) => e.type === 'output').map((e) => e.text);
  assert.ok(outs.includes('Hello '), 'assistant text streamed to UI');
  assert.ok(outs.includes('Hello world — done'), 'result line streamed to UI');
  assert.ok(!outs.some((t) => t.includes('"type":"assistant"')), 'no raw JSON leaked to UI events');
});
