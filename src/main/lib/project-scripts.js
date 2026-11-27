'use strict';
// Runs a game project's own npm commands: install, dev server and build.
//
// These run code from the project, much of it written by an AI, with the user's
// Windows account. So nothing runs until the user approves it, and the question is
// asked again when package.json or the bundler's config changes.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnPlan } = require('../../../lib/win-spawn.js');
const { killTree, treeOptions } = require('../../../lib/kill-tree.js');

// Install scripts of packages (and of the project) stay switched off.
const INSTALL_ARGS = ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
const CONFIG_FILES = ['.npmrc', 'vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.cjs'];
const SHOWN_SCRIPTS = ['predev', 'dev', 'postdev', 'prestart', 'start', 'poststart', 'prebuild', 'build', 'postbuild'];
// npm output that means package.json itself is wrong, so the Developer can fix it.
const BAD_PACKAGE_LIST = /\b(ETARGET|E404|ERESOLVE|EJSONPARSE|EINVALIDPACKAGENAME|EINVALIDTAGNAME)\b/;
const SERVER_ADDRESS = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s"'<>]*/;

const plain = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
const lastLines = (s, n = 12) => plain(s).trim().split(/\r?\n/).slice(-n).join('\n');

async function readPackage(root) {
  try { return JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
}

const dependenciesOf = (pkg) => ({ ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) });

function missingPackages(root, pkg) {
  return Object.keys(dependenciesOf(pkg)).filter((name) => !fs.existsSync(path.join(root, 'node_modules', name, 'package.json')));
}

// npm is taken from PATH by its full path. Asking cmd.exe for plain "npm.cmd" would
// look in the project folder first, where the project could put its own.
function findNpm(root, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'npm';
  const inside = (file) => { const r = path.relative(root, file); return !r.startsWith('..') && !path.isAbsolute(r); };
  for (const entry of String(env.Path || env.PATH || '').split(';')) {
    const dir = entry.replace(/^"|"$/g, '');
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, 'npm.cmd');
    if (fs.existsSync(file) && !inside(file)) return file;
  }
  return null;
}

// Changes whenever something that decides what would run has changed.
function fingerprint(root, pkg) {
  const parts = [pkg && pkg.scripts, pkg && pkg.dependencies, pkg && pkg.devDependencies, pkg && pkg.optionalDependencies, pkg && pkg.overrides];
  for (const name of CONFIG_FILES) {
    try { parts.push([name, fs.readFileSync(path.join(root, name), 'utf8')]); } catch { /* not there */ }
  }
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// What the approval box shows.
function describe(root, pkg) {
  const clip = (s) => (String(s).length > 160 ? `${String(s).slice(0, 160)}…` : String(s));
  const scripts = SHOWN_SCRIPTS.filter((k) => pkg && pkg.scripts && pkg.scripts[k]).map((k) => `  ${k}:  ${clip(pkg.scripts[k])}`);
  const deps = Object.entries(dependenciesOf(pkg)).map(([n, v]) => `  ${n}  ${clip(v)}`);
  const missing = missingPackages(root, pkg);
  return {
    root,
    scripts,
    packages: deps.length > 30 ? [...deps.slice(0, 30), `  …and ${deps.length - 30} more`] : deps,
    needsInstall: missing.length > 0,
    hasNpmrc: fs.existsSync(path.join(root, '.npmrc')),
  };
}

class ProjectScripts {
  // approve(info) resolves true only when the user says yes.
  constructor({ approve = async () => false, onEvent = () => {}, npm = findNpm, devTimeoutMs = 60000, installTimeoutMs = 300000, buildTimeoutMs = 180000 } = {}) {
    this.approve = approve;
    this.onEvent = onEvent;
    this.npm = npm;
    this.timeouts = { dev: devTimeoutMs, install: installTimeoutMs, build: buildTimeoutMs };
    this.answers = new Map();  // key -> Promise<boolean>
    this.refused = new Set();
    this.running = new Set();  // install and build processes
    this.dev = null;           // { root, key, child, url }
    this.queue = Promise.resolve();
  }

  _say(detail) { this.onEvent({ type: 'stage', stage: 'npm', detail }); }

  permit(root, pkg) {
    const key = `${root}|${fingerprint(root, pkg)}`;
    if (!this.answers.has(key)) {
      const asked = Promise.resolve()
        .then(() => this.approve(describe(root, pkg)))
        .then((yes) => yes === true, () => false)
        .then((yes) => { if (!yes) this.refused.add(key); return yes; });
      this.answers.set(key, asked);
    }
    return this.answers.get(key);
  }

  // So that a "no" is asked again when the user opens or reloads the game.
  forgetRefusals() {
    for (const key of this.refused) this.answers.delete(key);
    this.refused.clear();
  }

  _spawn(root, args) {
    const npm = this.npm(root);
    if (!npm) throw new Error('npm was not found. Install Node.js, then try again.');
    const plan = spawnPlan(npm, args, {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
    });
    return spawn(plan.file, plan.args, treeOptions(plan.options));
  }

  // Runs an npm command to its end. Never throws.
  _run(root, args, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      try { child = this._spawn(root, args); } catch (e) { return resolve({ ok: false, output: e.message }); }
      let output = '';
      let timedOut = false;
      let stopped = false;
      const keep = (d) => { output = (output + d).slice(-8000); };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const entry = { stop: () => { stopped = true; killTree(child); } };
      this.running.add(entry);
      const done = (ok, extra = '') => {
        clearTimeout(timer);
        this.running.delete(entry);
        resolve({ ok: ok && !timedOut && !stopped, timedOut, stopped, output: plain(output + extra) });
      };
      child.on('error', (e) => done(false, e.message));
      child.on('close', (code) => done(code === 0));
    });
  }

  // Approval, then any missing packages. One at a time, so two callers can't install together.
  prepare(root, pkg) {
    const next = this.queue.then(() => this._prepare(root, pkg));
    this.queue = next.catch(() => {});
    return next;
  }

  async _prepare(root, pkg) {
    if (!pkg) return { ok: false, reason: 'package.json could not be read' };
    if (!(await this.permit(root, pkg))) return { ok: false, refused: true, reason: 'you chose not to run this project’s commands' };
    if (!missingPackages(root, pkg).length) return { ok: true };
    this._say('installing the game’s npm packages (this can take a few minutes)…');
    const r = await this._run(root, INSTALL_ARGS, this.timeouts.install);
    if (r.ok) { this._say('npm packages installed.'); return { ok: true }; }
    const why = r.stopped ? 'npm install was stopped' : r.timedOut ? 'npm install took too long' : `npm install failed:\n${lastLines(r.output)}`;
    return { ok: false, badPackageList: BAD_PACKAGE_LIST.test(r.output), reason: why };
  }

  // { status: 'ok' | 'failed' | 'skipped', output?, reason? }
  async build(root, pkg) {
    const ready = await this.prepare(root, pkg);
    if (!ready.ok) {
      return ready.badPackageList ? { status: 'failed', output: ready.reason } : { status: 'skipped', reason: ready.reason };
    }
    const r = await this._run(root, ['run', 'build'], this.timeouts.build);
    if (r.stopped) return { status: 'skipped', reason: 'the build was stopped' };
    if (r.ok) return { status: 'ok' };
    return { status: 'failed', output: `${r.timedOut ? '(timed out)\n' : ''}${r.output.slice(-6000)}` };
  }

  // { ok: true, url } or { ok: false, reason }. A running server is reused.
  async startDev(root, pkg) {
    const ready = await this.prepare(root, pkg);
    if (!ready.ok) return ready;
    const key = `${root}|${fingerprint(root, pkg)}`;
    if (this.dev && this.dev.key === key && this.dev.child.exitCode === null) return { ok: true, url: this.dev.url };
    this.stopDev();
    const script = pkg.scripts && pkg.scripts.dev ? 'dev' : 'start';
    this._say(`starting the dev server (npm run ${script})…`);
    let child;
    try { child = this._spawn(root, ['run', script]); } catch (e) { return { ok: false, reason: e.message }; }
    const server = { root, key, child, url: null };
    this.dev = server;
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.ok) { killTree(child); if (this.dev === server) this.dev = null; }
        resolve(result);
      };
      const read = (d) => {
        output = (output + d).slice(-8000);
        const found = SERVER_ADDRESS.exec(plain(output));
        // Wait for the whole line, so a port split across two chunks isn't cut short.
        if (found && /\n/.test(plain(output).slice(found.index))) { server.url = found[0]; finish({ ok: true, url: found[0] }); }
      };
      const timer = setTimeout(() => finish({ ok: false, reason: `the dev server printed no local address:\n${lastLines(output)}` }), this.timeouts.dev);
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', (e) => finish({ ok: false, reason: `the dev server could not start: ${e.message}` }));
      child.on('exit', () => {
        if (this.dev === server) this.dev = null;
        finish({ ok: false, reason: `the dev server stopped:\n${lastLines(output)}` });
      });
    });
  }

  stopDev() {
    if (this.dev) { killTree(this.dev.child); this.dev = null; }
  }

  // The Stop button: ends an install or build in progress.
  stopRunning() { for (const entry of [...this.running]) entry.stop(); }

  stop() { this.stopRunning(); this.stopDev(); }
}

module.exports = { ProjectScripts, readPackage, missingPackages, findNpm, fingerprint, describe, INSTALL_ARGS };
