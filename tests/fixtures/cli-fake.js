// Test fixture: mimics the NDJSON `--output-format stream-json` output of the official
// Claude Code / Antigravity CLIs. Reads a prompt on stdin, emits text deltas + a final
// result, then exits 0. Used by tests/providers.test.js to exercise the real spawn+parse
// path without the actual vendor CLI installed.
let data = '';
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  emit({ type: 'stream_event', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } });
  emit({ type: 'stream_event', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } });
  emit({ type: 'result', subtype: 'success', result: 'Hello world' });
});
