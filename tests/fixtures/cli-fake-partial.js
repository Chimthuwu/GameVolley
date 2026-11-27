// Test fixture: the order Claude Code uses with --include-partial-messages.
// Text arrives in pieces, then again as one whole assistant message.
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const piece = (text) => emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  emit({ type: 'system', subtype: 'init' });
  emit({ type: 'stream_event', event: { type: 'message_start', message: {} } });
  piece('Hello ');
  piece('world');
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
  emit({ type: 'result', subtype: 'success', result: 'Hello world' });
});
