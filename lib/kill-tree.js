'use strict';
// Stop a child process AND everything it started.
//
// child.kill() ends only the process we spawned. For a Windows .cmd shim that is
// cmd.exe, so the real program underneath keeps running (and keeps editing files)
// after the user pressed Stop.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const FORCE_AFTER_MS = 3000;

// Spawn options needed so killTree() can reach the whole tree later. On macOS and
// Linux the child leads its own process group; Windows needs nothing extra.
function treeOptions(options = {}, platform = process.platform) {
  return platform === 'win32' ? options : { ...options, detached: true };
}

// Synchronous on Windows so it also completes while the app is quitting.
function killTree(child, platform = process.platform) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    // Must run while the parent is alive: /T finds descendants through it.
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const r = spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    if (r.error || r.status !== 0) { try { child.kill(); } catch {} }
    return;
  }
  const signalGroup = (signal) => { try { process.kill(-child.pid, signal); return true; } catch { return false; } };
  if (!signalGroup('SIGTERM')) { try { child.kill('SIGTERM'); } catch {} return; }
  const timer = setTimeout(() => signalGroup('SIGKILL'), FORCE_AFTER_MS);
  if (timer.unref) timer.unref();
}

module.exports = { killTree, treeOptions };
