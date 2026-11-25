/* Scaffold mode (B2): turn an approved prompt into a bounded file manifest, a todo.md
 * handoff and a guarded write plan. The models supply file contents; this module owns the
 * deterministic parts and every safety check so agents cannot escape the chosen folder.
 *
 * UMD so it runs in Node tests, the desktop main process and both front-ends.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleyScaffold = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_FILES = 100;
  const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
  const MAX_PATH_CHARS = 200;

  // B2 cycle 1: scaffold + todo.md. Cycle 2: stubs. Cycle 3: a real head-start.
  // Depth is driven by the cycles slider, never by the model deciding on its own.
  const DEPTH = {
    1: { label: 'scaffold', instruction: 'Create only the project skeleton, config files, PROMPT.md and todo.md. Do not implement features.' },
    2: { label: 'stubs', instruction: 'Also fill in entry points, data models and module stubs. Everything must open cleanly; features may be TODOs.' },
    3: { label: 'head-start', instruction: 'Also implement the first milestone end to end so it can be run and verified.' },
  };

  const SCAFFOLD_AUTHOR_SYSTEM = `You are a project scaffolder. Output ONLY a JSON array of objects, each with exactly two string fields: "path" (a relative POSIX path inside the chosen folder) and "content" (the full file contents). No prose, no markdown fences around the JSON.
Every scaffold must include PROMPT.md (the approved prompt verbatim), todo.md (an actionable handoff for the next coding agent) and README.md (how to run the project). Paths must never start with "/" or contain "..".
Respect the requested depth exactly:
- depth 1 scaffold: skeleton, config, PROMPT.md, todo.md, README.md. No feature code.
- depth 2 stubs: also entry points, data models and module stubs that open cleanly.
- depth 3 head-start: also implement the first milestone end to end.
Prefer a small number of complete files over many empty placeholders.`;

  const SCAFFOLD_CRITIC_SYSTEM = `You review scaffold manifests, never prose drafts. The input is a JSON array of {path, content}.
Check: (1) valid JSON, (2) required files PROMPT.md, todo.md and README.md are present, (3) no absolute or traversal paths, (4) todo.md has concrete milestones with file paths and a definition of done, (5) the depth instruction was followed — do not award credit for implemented features at depth 1 or for missing entry points at depth 2, (6) no file is empty when the depth implies it should have content.
Reply with either APPROVE or a numbered list of concrete fixes. When you revise, output the full revised JSON array only.`;

  function depthForCycles(cycles) {
    const n = Math.max(1, Math.min(3, Math.floor(Number(cycles) || 1)));
    return { level: n, ...DEPTH[n] };
  }

  function buildScaffoldRequest(prompt, cycles) {
    const depth = depthForCycles(cycles);
    return {
      system: SCAFFOLD_AUTHOR_SYSTEM,
      user: `Approved prompt (the spec):\n\n${String(prompt == null ? '' : prompt).trim()}\n\nRequested depth: ${depth.level} (${depth.label}).\n${depth.instruction}`,
      depth,
    };
  }

  function isValidPath(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_PATH_CHARS) return false;
    if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
    const parts = value.split('/');
    if (parts.length > 8) return false;
    return parts.every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.') && !/[\x00-\x1f]/.test(part));
  }

  function parseManifest(text) {
    let raw = String(text == null ? '' : text).trim();
    // Tolerate a fenced response, but never tolerate prose wrapped around broken JSON.
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
    if (fenced) raw = fenced[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      // One-shot recovery: a model sometimes truncates a closing brace but keeps the array.
      const first = raw.indexOf('[');
      const last = raw.lastIndexOf(']');
      if (first === -1) throw new Error('Scaffold output is not a JSON file manifest');
      const candidate = last > first ? raw.slice(first, last + 1) : raw.slice(first) + ']';
      try { parsed = JSON.parse(candidate); }
      catch (_) { throw new Error('Scaffold output is truncated or malformed JSON'); }
    }
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > MAX_FILES) {
      throw new Error(`Manifest must contain between 1 and ${MAX_FILES} files`);
    }
    let total = 0;
    const seen = new Set();
    const files = parsed.map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || typeof entry.content !== 'string') {
        throw new Error('Every manifest entry needs string "path" and "content" fields');
      }
      if (!isValidPath(entry.path)) throw new Error(`Unsafe scaffold path: ${entry.path}`);
      if (seen.has(entry.path)) throw new Error(`Duplicate scaffold path: ${entry.path}`);
      seen.add(entry.path);
      total += entry.content.length;
      if (total > MAX_TOTAL_BYTES) throw new Error('Scaffold manifest exceeds the size cap');
      return { path: entry.path, content: entry.content };
    });
    for (const required of ['PROMPT.md', 'todo.md', 'README.md']) {
      if (!seen.has(required)) throw new Error(`Manifest is missing ${required}`);
    }
    return files;
  }

  // The todo.md handoff is the deliverable: a cold-start agent must know the milestones,
  // the files and the constraints without reading the chat that produced it.
  function buildTodoHandoff(prompt, files, cycles) {
    const depth = depthForCycles(cycles);
    const spec = String(prompt == null ? '' : prompt).trim();
    const milestones = ['- [ ] M1 — review the scaffold and confirm it matches the approved prompt (files: README.md, PROMPT.md).'];
    if (depth.level >= 2) milestones.push('- [ ] M2 — replace stubs in the entry points and data models; verify the project opens and runs.');
    if (depth.level >= 3) milestones.push('- [ ] M3 — implement and verify the first milestone end to end; add a test or a manual smoke step with a definition of done.');
    const list = (files || []).map((f) => `- \`${f.path}\``).join('\n');
    return [
      '# Project handoff',
      '',
      '## Goal',
      spec.split('\n').filter(Boolean).slice(0, 12).join('\n') || '(see PROMPT.md)',
      '',
      '## Constraints',
      '- Treat PROMPT.md as the authoritative spec; do not invent conflicting requirements.',
      `- Scaffold depth: ${depth.level} (${depth.label}).`,
      '- Ask the owner before making changes unrelated to this spec.',
      '',
      '## Milestones',
      ...milestones,
      '',
      '## Files created by the scaffold',
      list || '(none)',
      '',
      '## Definition of done',
      '- The project opens in an IDE and the documented run command works.',
      '- Every milestone above is checked off with evidence (test output or a smoke step).',
      '',
    ].join('\n');
  }

  // Guardrails: no destination = no plan; a non-empty folder needs an explicit merge.
  function planWrite(files, destination, existingPaths, merge) {
    if (!destination || typeof destination !== 'string' || !destination.trim()) {
      throw new Error('Pick a destination folder first');
    }
    const list = Array.isArray(files) ? files : [];
    if (!list.length) throw new Error('Nothing to write');
    const collisions = list.map((f) => f.path).filter((p) => (existingPaths || []).includes(p));
    if (collisions.length && !merge) {
      throw new Error(`Destination already contains ${collisions.length} of these files (${collisions.slice(0, 3).join(', ')}). Confirm a merge to overwrite.`);
    }
    return {
      destination,
      files: list,
      preview: `About to create ${list.length} file${list.length === 1 ? '' : 's'} in ${destination}${collisions.length ? `, overwriting ${collisions.length}` : ''}.`,
    };
  }

  // Minimal uncompressed ZIP writer for the web fallback (no external dependency).
  // Uses the CRC-32 of the PNG polynomial and the ZIP "store" method.
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toZip(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
      const name = encoder.encode(file.path);
      const data = encoder.encode(file.content);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length + data.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0, true);
      view.setUint16(8, 0, true); view.setUint16(10, 0, true); view.setUint16(12, 0, true);
      view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true); view.setUint16(28, 0, true);
      local.set(name, 30); local.set(data, 30 + name.length);
      parts.push(local);
      const record = new Uint8Array(46 + name.length);
      const cv = new DataView(record.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
      record.set(name, 46);
      central.push(record);
      offset += local.length;
    }
    const centralSize = central.reduce((sum, r) => sum + r.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    let total = offset + centralSize + end.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of [...parts, ...central, end]) { out.set(chunk, at); at += chunk.length; }
    return out;
  }

  return {
    DEPTH, MAX_FILES, MAX_TOTAL_BYTES,
    SCAFFOLD_AUTHOR_SYSTEM, SCAFFOLD_CRITIC_SYSTEM,
    depthForCycles, buildScaffoldRequest, isValidPath, parseManifest,
    buildTodoHandoff, planWrite, crc32, toZip,
  };
});
