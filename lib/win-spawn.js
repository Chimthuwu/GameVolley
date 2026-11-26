// win-spawn.js
//
// Windows command-shim launching. On modern Node, spawning a `.cmd`/`.bat` shim
// (how npm installs CLIs on Windows) without a shell fails with EINVAL, so it is
// launched through cmd.exe.
//
// cmd.exe does NOT follow the quoting rules other programs use. Escaping can't
// make every argument safe:
//   "      a \" still ends cmd's quoted region, so later & | > run as commands
//   %VAR%  is expanded even inside quotes
//   CR/LF  ends the command line; everything after it is silently dropped
// So spawnPlan() REFUSES such arguments for shims. With no quotes inside an
// argument, wrapping it in quotes does keep & | < > ^ ( ) literal.
//
// Callers must send free text (prompts, model output) on stdin, never as an
// argument. Args here are only flags, model ids and local paths.

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

const SHIM_FORBIDDEN = /["%\r\n\0]/;

// Returns { file, args, options } for spawn()/spawnSync(). Non-shims pass through
// untouched (no shell anywhere).
function spawnPlan(binary, args, extraOpts = {}) {
  if (!isWindowsShim(binary)) {
    return { file: binary, args: [...args], options: { ...extraOpts } };
  }
  const parts = [binary, ...args].map(String);
  if (parts.some((part) => SHIM_FORBIDDEN.test(part))) {
    const name = String(binary).split(/[\\/]/).pop();
    throw new Error(`Refusing to run "${name}": one of its settings contains a quote, % sign or line break, which cmd.exe could run as a command. Check the model name for stray characters.`);
  }
  const cmdLine = parts.map(quoteWinArg).join(' ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${cmdLine}"`],
    options: { windowsVerbatimArguments: true, ...extraOpts },
  };
}

module.exports = { quoteWinArg, isWindowsShim, spawnPlan };
