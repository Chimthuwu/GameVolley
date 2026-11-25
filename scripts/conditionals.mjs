// Conditional-compilation directives used by build-shared.mjs.
// Kept separate so the behaviour can be unit-tested without running a build.

// Lines between // @if:<platform> and // @endif are included only for that platform.
// A single-line // @platform:<platform> <code> emits <code> for that platform only.
export function processConditionals(content, platform) {
  const lines = String(content == null ? '' : content).split('\n');
  const out = [];
  let inBlock = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('// @if:')) {
      const name = trimmed.slice(7).trim();
      inBlock = name === platform;
      continue;
    }
    if (trimmed === '// @endif') {
      inBlock = true;
      continue;
    }
    if (trimmed.startsWith('// @platform:')) {
      const directive = trimmed.slice(13);
      const space = directive.search(/\s/);
      const name = space === -1 ? directive : directive.slice(0, space);
      if (name === platform) out.push(space === -1 ? '' : directive.slice(space + 1));
      continue;
    }
    if (inBlock) out.push(line);
  }
  return out.join('\n');
}

export default processConditionals;
