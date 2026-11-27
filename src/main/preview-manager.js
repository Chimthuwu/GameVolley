// preview-manager.js
//
// Embeds the actual playable game. Uses Electron's WebContentsView (NOT the
// deprecated <webview>), kept isolated from the privileged app renderer: the game
// runs in its own webContents with contextIsolation + no Node integration. The
// renderer sends a bounding rectangle and this manager positions the view over the
// preview placeholder.
//
// Two project kinds are supported:
//   - 'file'      -> served by a tiny isolated static HTTP server (avoids file://
//                   fetch/CORS quirks) and loaded over http://127.0.0.1.
//   - 'devserver' -> with the user's approval (lib/project-scripts.js) we start the
//                    project's dev server and load the address it prints.
//
// Electron is required lazily so this module can be unit-tested in plain Node with
// an injected mock for the BrowserWindow/WebContentsView surface.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readPackage } = require('./lib/project-scripts.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// Pure helper: resolve a request path against the project root, refusing traversal
// or absolute paths (e.g. "/etc/passwd" or "C:\windows\...").
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (decoded.includes('\0')) return null; // null-byte tricks
  // A URL path ALWAYS starts with "/" — that is not an absolute filesystem path.
  // Strip it, then treat backslashes as separators so Windows absolute paths
  // ("C:\windows", "\\server\share") resolve out of root and get refused below.
  const rel = decoded.replace(/^\/+/, '').replace(/\\/g, '/');
  const target = path.resolve(root, rel || 'index.html');
  const r = path.relative(root, target);
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return target;
}

// Pure helper: is this project-relative path sensitive/forbidden? Blocks secrets
// (.env*, keys, certificates), ALL hidden files/dirs (.git, .gamevolley, ...), and
// node_modules (never needed by a served game; removes a big attack surface).
function isBlockedPath(relPath) {
  const norm = String(relPath).replace(/\\/g, '/');
  for (const seg of norm.split('/')) {
    if (!seg) continue;
    if (seg.startsWith('.')) return true; // .env, .env.local, .git, .gamevolley, .secret, ...
    if (/^id_(rsa|ed25519|ecdsa|dsa)/i.test(seg)) return true; // ssh private keys
    if (/\.(pem|key|p12|pfx|pkipass|crt|cer|jks|keystore)$/i.test(seg)) return true; // certs/keystores
    if (seg === 'node_modules') return true;
  }
  return false;
}

// Height left free above a fullscreen preview for the app's "Exit fullscreen" bar.
const FULLSCREEN_BAR = 36;

// Does index.html load code that only works through the project's dev server
// (TypeScript or JSX, or packages imported by name)?
async function needsDevServer(root) {
  let html;
  try { html = await fsp.readFile(path.join(root, 'index.html'), 'utf8'); } catch { return true; }
  if (/<script[^>]+src=["'][^"']+\.(ts|tsx|jsx)["']/i.test(html)) return true;
  if (/type=["']importmap["']/i.test(html)) return false;
  const byName = /^\s*import\s+(?:[^'"]*?\sfrom\s+)?["'](?![./]|https?:)[^"']+["']/m;
  const code = [...html.matchAll(/<script[^>]+type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const m of html.matchAll(/<script[^>]+src=["'](?!https?:|\/\/)([^"'?#]+)["']/gi)) {
    const file = safeJoin(root, m[1]);
    if (file) { try { code.push(await fsp.readFile(file, 'utf8')); } catch { /* reported by the build check */ } }
  }
  return code.some((c) => byName.test(c));
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

class PreviewManager {
  constructor({ window = null, onEvent = () => {}, electron = null, scripts = null } = {}) {
    this.scripts = scripts;   // runs the project's npm commands, after approval
    this.unavailable = null;  // why the current game can't be shown, if it can't
    this.window = window;
    this._onEvent = onEvent;
    this._electron = electron; // injected for tests; lazily required in production
    this.view = null;
    this.bounds = null;
    this.full = false; // fullscreen stays on until it is switched off
    this.staticServer = null;
    this.staticPort = null;
    this._listeners = new Map(); // type -> Set<cb>, used by the validation gate
  }

  // Typed listener registry (EventEmitter-ish) so the validation stage can watch
  // preview:ready / preview:console / preview:fail without the app's global sink.
  on(type, cb) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(cb);
  }

  off(type, cb) {
    const s = this._listeners.get(type);
    if (s) s.delete(cb);
  }

  _emit(ev) {
    if (this._onEvent) this._onEvent(ev);
    const s = this._listeners.get(ev.type);
    if (s) for (const cb of [...s]) { try { cb(ev); } catch {} }
  }

  attach(window) { this.window = window; }

  _requireElectron() {
    if (this._electron) return this._electron;
    // Lazy require — only invoked inside a real Electron runtime.
    // eslint-disable-next-line global-require
    this._electron = require('electron');
    return this._electron;
  }

  _ensureView() {
    if (this.view) return this.view;
    const electron = this._requireElectron();
    const view = new electron.WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        // The validation gate plays the game even while the window is hidden;
        // background rAF throttling would freeze every animation and make the
        // playtest probe (Q5) flag working games as blank.
        backgroundThrottling: false,
      },
    });
    if (this.window && this.window.contentView) this.window.contentView.addChildView(view);
    else if (this.window && this.window.addChildView) this.window.addChildView(view);

    const wc = view.webContents;
    // Navigation containment: the preview may only ever browse the project server it
    // was loaded from. External navigation is blocked and reported, not followed.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, url) => {
      if (this._allowedOrigin && String(url).startsWith(this._allowedOrigin)) return;
      e.preventDefault();
      this._emit({ type: 'preview:error', message: 'Preview blocked navigation outside the project server.', url });
    });
    wc.on('did-fail-load', (_e, code, desc, url) => {
      if (this.unavailable) return;
      this._emit({ type: 'preview:fail', code, message: desc, url });
      this._emit({ type: 'preview:error', code, message: desc, url });
    });
    // The page that explains why a game can't be shown is not "the game is ready".
    wc.on('did-finish-load', () => { if (!this.unavailable) this._emit({ type: 'preview:ready' }); });
    wc.on('console-message', (_e, level, message) => {
      if (level >= 2) this._emit({ type: 'preview:console', level, message });
    });

    // While fullscreen the game has the keyboard, so Esc has to be caught here.
    wc.on('before-input-event', (e, input) => {
      if (this.full && input.type === 'keyDown' && input.key === 'Escape') {
        e.preventDefault();
        this.fullscreen(false);
      }
    });

    this.view = view;
    this._place();
    return view;
  }

  _place() {
    if (!this.view) return;
    if (this.full && this.window) {
      const [w, h] = this.window.getContentSize();
      this.view.setBounds({ x: 0, y: FULLSCREEN_BAR, width: w, height: Math.max(0, h - FULLSCREEN_BAR) });
    } else if (this.bounds) {
      this.view.setBounds(this.bounds);
    }
  }

  // Where the preview sits when it isn't fullscreen. The screen keeps sending this as
  // it lays out; while fullscreen it is only remembered, so it can't end fullscreen.
  setBounds(rect) {
    this.bounds = rect;
    // The renderer positions the preview placeholder before any game is loaded, so
    // make sure the view exists (and is positioned) even on first call.
    this._ensureView();
    this._place();
  }

  fullscreen(on = true) {
    if (!this.window) return false;
    this.full = !!on;
    this._ensureView();
    this._place();
    if (this.full && typeof this.view.webContents.focus === 'function') this.view.webContents.focus();
    this._emit({ type: 'preview:fullscreen', full: this.full });
    return this.full;
  }

  _startStaticServer(rootDir) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        // Decode + normalize FIRST, then validate the relative path before touching disk.
        const decoded = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
        const rel = decoded.replace(/^\/+/, '').replace(/\\/g, '/') || 'index.html';
        if (isBlockedPath(rel)) { res.writeHead(403); return res.end('Forbidden'); }
        const target = safeJoin(rootDir, req.url || '/');
        if (!target) { res.writeHead(403); return res.end('Forbidden'); }
        try {
          // Symlink containment: the REAL path of everything we serve must stay inside
          // the REAL project root (defeats symlink escapes the lexical check can't see).
          const [realRoot, realTarget] = await Promise.all([fsp.realpath(rootDir), fsp.realpath(target)]);
          if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
            res.writeHead(403); return res.end('Forbidden');
          }
          const stat = await fsp.stat(realTarget);
          if (stat.isDirectory()) {
            const idx = path.join(realTarget, 'index.html');
            if (fs.existsSync(idx)) return this._serveFile(idx, req, res);
            res.writeHead(404); return res.end('Not found');
          }
          this._serveFile(realTarget, req, res);
        } catch {
          res.writeHead(404); res.end('Not found');
        }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.staticServer = server;
        this.staticPort = server.address().port;
        resolve(this.staticPort);
      });
    });
  }

  _serveFile(file, req, res) {
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  async loadProject({ projectPath, entry }) {
    if (!entry) throw new Error('No entry point to preview.');
    const view = this._ensureView();
    this.unavailable = null;
    let url;
    if (entry.type === 'devserver') {
      const started = this.scripts
        ? await this.scripts.startDev(projectPath, await readPackage(projectPath))
        : { ok: false, reason: 'running project commands isn’t available' };
      if (started.ok) {
        url = started.url;
      } else if (await needsDevServer(projectPath)) {
        return this._showUnavailable(`This game needs its dev server, which isn’t running: ${started.reason}`);
      } else {
        this._emit({ type: 'stage', stage: 'preview', detail: `showing index.html directly, because ${started.reason}` });
        entry = { type: 'file', path: 'index.html' };
      }
    } else if (this.scripts) {
      this.scripts.stopDev();
    }
    if (!url) {
      // Close the previous round's static server so we don't leak one per round.
      if (this.staticServer) { try { this.staticServer.close(); } catch {} this.staticServer = null; this.staticPort = null; }
      const port = await this._startStaticServer(projectPath);
      const base = `http://127.0.0.1:${port}`;
      // entry.path like "index.html" or "src/index.html"
      url = `${base}/${String(entry.path).replace(/^\/+/, '')}`;
      this._staticRoot = projectPath;
    }
    this._emit({ type: 'preview:load', entry, url });
    try { this._allowedOrigin = new URL(url).origin; } catch { this._allowedOrigin = null; }
    try {
      await view.webContents.loadURL(url);
    } catch (e) {
      this._emit({ type: 'preview:error', message: String(e.message || e) });
    }
    return url;
  }

  async _showUnavailable(reason) {
    this.unavailable = reason;
    this._allowedOrigin = null;
    this._emit({ type: 'preview:error', message: `${reason}\nPress ⟳ on the preview to try again.` });
    const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;background:#11131f;color:#e8e8f0;font:13px sans-serif;white-space:pre-wrap">${escapeHtml(reason)}\n\nPress ⟳ above to try again.</body>`;
    try { await this.view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`); } catch { /* the message is in the log */ }
    return null;
  }

  reload() {
    if (this.view) this.view.webContents.reload();
  }

  // Q5: playtest probe. Samples the canvas + counts rAF ticks around real input
  // events; a canvas that never changes while the page IS animating is the
  // blank-game signature the validation gate turns into a blocking finding.
  // Chromium never paints hidden windows (rAF stalls there), so `rafTicks <= 1`
  // marks the probe inconclusive instead of guilty.
  async playtestProbe({ intervalMs = 1200 } = {}) {
    const wc = this.view && this.view.webContents;
    if (!wc || wc.isDestroyed()) return { ran: false, reason: 'no preview webContents' };
    const grab = `const grab = () => { try { const t = document.createElement('canvas'); t.width = c.width || 300; t.height = c.height || 150; t.getContext('2d').drawImage(c, 0, 0); const d = t.toDataURL(); let s = 0; for (let i = 0; i < 256; i++) s = (s + d.charCodeAt(d.length - 1 - i * 7)) % 99991; return { data: d, len: d.length, sum: s }; } catch (e) { return { data: '', err: e.message }; } };`;
    const stats = `const stats = () => { try { const g = c.getContext('2d'); if (!g) return null; const w = c.width || 300, h = c.height || 150; const d = g.getImageData(0, 0, w, h).data; let uniform = true, empty = true; const p0 = [d[0], d[1], d[2], d[3]]; for (let i = 4; i < d.length; i += 4) { if (d[i + 3] !== 0) empty = false; if (d[i] !== p0[0] || d[i + 1] !== p0[1] || d[i + 2] !== p0[2] || d[i + 3] !== p0[3]) uniform = false; } return { uniform, empty }; } catch (e) { return null; } };`;
    const firstScript = `(() => {
      const c = document.querySelector('canvas');
      if (!c) return Promise.resolve({ canvas: false });
      ${grab}
      ${stats}
      const f1 = grab();
      const st = stats();
      return new Promise((res) => {
        let ticks = 0; const t0 = Date.now();
        function tick() { ticks++; if (Date.now() - t0 < 600) requestAnimationFrame(tick); }
        requestAnimationFrame(tick);
        setTimeout(() => res({ canvas: true, frame: f1.data, len1: f1.len, sum1: f1.sum, stat: st, pageVisible: document.visibilityState === 'visible', rafTicks: ticks }), 800);
      });
    })()`;
    const secondScript = `(() => {
      const c = document.querySelector('canvas');
      if (!c) return { canvas: false };
      ${grab}
      const f2 = grab();
      return { canvas: true, frame: f2.data, len2: f2.len, sum2: f2.sum };
    })()`;
    let first;
    try { first = await wc.executeJavaScript(firstScript, true); } catch (e) { return { ran: false, reason: String(e.message || e) }; }
    if (!first || !first.canvas) return { ran: true, canvas: false };
    // Real (trusted) input events first; games listening on window/document get
    // these, and key/mouse handling is the "responsive" half of the probe.
    try { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); } catch {}
    try { wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' }); } catch {}
    try { wc.sendInputEvent({ type: 'mouseMove', x: 60, y: 60 }); } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
    let second;
    try { second = await wc.executeJavaScript(secondScript, true); } catch (e) { return { ran: true, canvas: true, changed: null, rafTicks: first.rafTicks, reason: String(e.message || e) }; }
    return {
      ran: true, canvas: true,
      changed: first.frame !== second.frame,
      rafTicks: first.rafTicks, pageVisible: first.pageVisible,
      empty: first.stat ? first.stat.empty : null,
      uniform: first.stat ? first.stat.uniform : null,
      len1: first.len1, len2: second.len2, sum1: first.sum1, sum2: second.sum2,
    };
  }

  // Full-page screenshot for the vision Critic (Q6); null when unavailable.
  async capture() {
    const wc = this.view && this.view.webContents;
    if (!wc || wc.isDestroyed()) return null;
    try { return await wc.capturePage(); } catch { return null; }
  }

  async close() {
    if (this.scripts) this.scripts.stopDev();
    if (this.staticServer) { try { this.staticServer.close(); } catch {} this.staticServer = null; this.staticPort = null; }
    if (this.view) {
      try {
        if (this.window && this.window.contentView && this.window.contentView.removeChildView) this.window.contentView.removeChildView(this.view);
        else if (this.window && this.window.removeChildView) this.window.removeChildView(this.view);
        this.view.webContents.close();
      } catch {}
      this.view = null;
    }
    if (this.full) { this.full = false; this._emit({ type: 'preview:fullscreen', full: false }); }
  }
}

module.exports = PreviewManager;
module.exports.safeJoin = safeJoin;
module.exports.isBlockedPath = isBlockedPath;
module.exports.MIME = MIME;
module.exports.needsDevServer = needsDevServer;
