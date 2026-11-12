// parse-files.js
//
// Strict parser for model file-block output with ONE tolerant fallback.
//
// Canonical format (what the system prompt demands):
//   === FILE: relative/path.ext ===
//   <full contents>
//   === END FILE ===
//
// Rules enforced:
// - If ANY file markers are present, they must balance and parse completely.
//   A truncated response (missing END marker) is rejected as a WHOLE — never a
//   partial set. (The old parser silently dropped the last truncated file.)
// - If no markers, we accept fenced code blocks ONLY when the fence line
//   itself carries a plausible relative file path (```js src/main.js), so a
//   code line containing "/" can never be mistaken for a path.
// - Prose-only output is an explicit error, not an empty success.

const CANONICAL = /^=== FILE: (.+?) ===[ \t]*\r?\n([\s\S]*?)\r?\n?=== END FILE ===[ \t]*$/gm;
const OPEN_MARK = /^=== FILE: .+? ===[ \t]*$/gm;
const CLOSE_MARK = /^=== END FILE ===[ \t]*$/gm;
// Fence line MUST carry the path: ```js src/main.js
const FENCED = /^```[\w+-]*[ \t]+([^\s`]+)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const FILENAME = /^[\w .-]+(?:\/[\w .-]+)*\.[A-Za-z0-9]+$/;

function parseFiles(text) {
  const src = String(text || '');
  const opens = (src.match(OPEN_MARK) || []).length;
  const closes = (src.match(CLOSE_MARK) || []).length;

  if (opens || closes) {
    const files = [...src.matchAll(CANONICAL)].map((m) => ({ path: m[1].trim(), content: m[2] }));
    // Unbalanced or partially matched = truncated or malformed. Never accept a partial set.
    if (opens !== closes || files.length !== opens) {
      return {
        files: [],
        format: 'canonical',
        error: `Unbalanced file markers (open=${opens}, close=${closes}, parsed=${files.length})`,
      };
    }
    return { files, format: 'canonical' };
  }

  const fenced = [...src.matchAll(FENCED)]
    .filter((m) => FILENAME.test(m[1]) && !m[1].includes('..') && !/[A-Za-z]:/.test(m[1]))
    .map((m) => ({ path: m[1].trim(), content: m[2] }));
  if (fenced.length) return { files: fenced, format: 'fenced' };

  return { files: [], format: 'none', error: 'No file blocks found' };
}

module.exports = { parseFiles };
