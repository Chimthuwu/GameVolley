'use strict';
// How the "Send to Hermes" prompt is launched.
//
// The prompt is AI-written text, possibly shaped by attached files, so it must
// never pass through cmd.exe: there it can run commands, and everything after
// the first line is lost. We start the real program (hermes.exe on Windows) with
// the prompt as one argument and no shell. A .cmd-only install is not supported.

// Windows caps a whole command line at 32,767 characters.
const WIN_MAX_COMMAND = 32000;

function hermesPlan(text, platform = process.platform) {
  const body = String(text == null ? '' : text).trim().replace(/\0/g, '').slice(0, 100000);
  if (!body) throw new Error('Nothing to send to Hermes.');
  if (platform === 'win32') {
    // Quotes and backslashes can double in length when Node quotes the argument.
    const worstCase = body.length + (body.match(/["\\]/g) || []).length;
    if (worstCase > WIN_MAX_COMMAND) {
      throw new Error('This prompt is too long to send to Hermes directly (Windows limit). Use Copy, then paste it into Hermes.');
    }
  }
  return {
    file: platform === 'win32' ? 'hermes.exe' : 'hermes',
    args: ['chat', '-q', body],
    options: { detached: true, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

module.exports = { hermesPlan, WIN_MAX_COMMAND };
