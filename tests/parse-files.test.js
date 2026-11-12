// Strict parser tests — canonical blocks, fenced fallback, truncation rejection.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseFiles } = require('../src/main/lib/parse-files.js');

test('canonical blocks parse', () => {
  const t = '=== FILE: a.js ===\nlet x=1;\n=== END FILE ===\n=== FILE: b/c.css ===\nbody{}\n=== END FILE ===';
  const r = parseFiles(t);
  assert.equal(r.files.length, 2);
  assert.equal(r.format, 'canonical');
});

test('truncated response is rejected, not partially accepted', () => {
  const t = '=== FILE: a.js ===\nlet x=1;\n=== END FILE ===\n=== FILE: b.js ===\nlet y=';
  const r = parseFiles(t);
  assert.equal(r.files.length, 0);
  assert.match(r.error, /Unbalanced/);
});

test('a stray END marker with no opening is an error, not empty success', () => {
  const r = parseFiles('=== END FILE ===');
  assert.equal(r.files.length, 0);
  assert.match(r.error, /Unbalanced/);
});

test('fenced block needs the path on the fence line', () => {
  assert.equal(parseFiles('```js\nconst r = a/b;\n```').files.length, 0);
  const r = parseFiles('```js src/main.js\nlet a=1;\n```');
  assert.equal(r.files[0].path, 'src/main.js');
  assert.equal(r.files[0].content, 'let a=1;');
});

test('prose-only output is an explicit error', () => {
  const r = parseFiles('Here is a nice game, hope you like it!');
  assert.equal(r.files.length, 0);
  assert.match(r.error, /No file blocks/);
});

test('fenced fallback rejects traversal and drive-letter paths', () => {
  assert.equal(parseFiles('```js ../x.js\nlet a=1;\n```').files.length, 0);
  assert.equal(parseFiles('```js C:/x.js\nlet a=1;\n```').files.length, 0);
});
