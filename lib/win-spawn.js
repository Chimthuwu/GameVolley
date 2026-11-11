// win-spawn.js
//
// Windows command-shim launching, done safely. On modern Node, spawning a
// `.cmd`/`.bat` shim (how npm installs CLIs on Windows) without a shell fails
// with EINVAL. The safe pattern (what cross-spawn does) is:
//     spawn('cmd.exe', ['/d', '/s', '/c', `"${escaped command line}"`],
//           { windowsVerbatimArguments: true })
// with EVERY argument individually escaped for CommandLineToArgvW so argument
// boundaries are preserved and metacharacters cannot break out.
//
// DEFENSE IN DEPTH: callers must keep UNTRUSTED text (task prompts, model output)
// OUT of the argument list entirely — pass it via stdin. Args here are only
// flags, model ids and local paths chosen by the user.

// Backslash is included so a trailing backslash can never escape a closing quote.
const WIN_UNSAFE = /[\s"^&|<>()%!\\]/;

// Quote one argument per CommandLineToArgvW rules (backslash runs before a
// quote are doubled, quotes are escaped). Bare tokens stay bare.
function quoteWinArg(arg) {
  arg = String(arg);
  if (arg !== '' && !WIN_UNSAFE.test(arg)) return arg;
  let out = '"';
  let i = 0;
  while (i < arg.length) {
    let backslashes = 0;
    while (arg[i] === '\\') { backslashes++; i++; }
    if (i === arg.length) { out += '\\'.repeat(backslashes * 2); break; }
    if (arg[i] === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; i++; continue; }
    out += '\\'.repeat(backslashes) + arg[i];
    i++;
  }
  return out + '"';
}

// Is this binary a Windows command shim (needs cmd.exe to launch)?
function isWindowsShim(binary) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(binary));
}

// Returns { file, args, options } for spawn()/spawnSync(). Non-shims pass through
// untouched (no shell anywhere).
function spawnPlan(binary, args, extraOpts = {}) {
  if (!isWindowsShim(binary)) {
    return { file: binary, args: [...args], options: { ...extraOpts } };
  }
  const cmdLine = [binary, ...args].map(quoteWinArg).join(' ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${cmdLine}"`],
    options: { windowsVerbatimArguments: true, ...extraOpts },
  };
}

module.exports = { quoteWinArg, isWindowsShim, spawnPlan };
