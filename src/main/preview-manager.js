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
//   - 'devserver' -> we start the project's dev command and load its URL.
//
// Electron is required lazily so this module can be unit-tested in plain Node with
// an injected mock for the BrowserWindow/WebContentsView surface.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
  const rel = decoded.replace(/^\/+/, '');
  // A leading slash means the client asked for an absolute path — refuse it.
  if (decoded !== rel) return null;
  const target = path.resolve(root, rel || 'index.html');
  const r = path.relative(root, target);
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return target;
}

class PreviewManager {
  constructor({ window = null, onEvent = () => {}, electron = null } = {}) {
    this.window = window;
    this._onEvent = onEvent;
    this._electron = electron; // injected for tests; lazily required in production
    this.view = null;
    this.bounds = null;
    this.staticServer = null;
    this.staticPort = null;
    this.devProcess = null;
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
      },
    });
    if (this.window && this.window.contentView) this.window.contentView.addChildView(view);
    else if (this.window && this.window.addChildView) this.window.addChildView(view);

    const wc = view.webContents;
    wc.on('did-fail-load', (_e, code, desc, url) => this._onEvent({ type: 'preview:error', code, message: desc, url }));
    wc.on('did-finish-load', () => this._onEvent({ type: 'preview:ready' }));
    wc.on('console-message', (_e, level, message) => {
      if (level >= 2) this._onEvent({ type: 'preview:console', level, message });
    });

    this.view = view;
    if (this.bounds) view.setBounds(this.bounds);
    return view;
  }

  setBounds(rect) {
    this.bounds = rect;
    // The renderer positions the preview placeholder before any game is loaded, so
    // make sure the view exists (and is positioned) even on first call.
    this._ensureView();
    this.view.setBounds(rect);
  }

  fullscreen() {
    if (!this.window) return;
    const [w, h] = this.window.getContentSize();
    this.setBounds({ x: 0, y: 0, width: w, height: h });
  }

  _startStaticServer(rootDir) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const target = safeJoin(rootDir, req.url || '/');
        if (!target) { res.writeHead(403); return res.end('Forbidden'); }
        try {
          const stat = await fsp.stat(target);
          if (stat.isDirectory()) {
            const idx = path.join(target, 'index.html');
            if (fs.existsSync(idx)) return this._serveFile(idx, req, res);
            res.writeHead(404); return res.end('Not found');
          }
          this._serveFile(target, req, res);
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

  _startDevServer(projectPath, entry) {
    try {
      this.devProcess = spawn('npm', ['run', 'dev'], { cwd: projectPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.devProcess.stderr.on('data', (d) => this._onEvent({ type: 'preview:diagnostic', text: d.toString() }));
    } catch (e) {
      this._onEvent({ type: 'preview:error', message: `Could not start dev server: ${e.message}` });
    }
  }

  async loadProject({ projectPath, entry }) {
    if (!entry) throw new Error('No entry point to preview.');
    const view = this._ensureView();
    let url;
    if (entry.type === 'devserver') {
      this._startDevServer(projectPath, entry);
      url = entry.url;
    } else {
      const port = await this._startStaticServer(projectPath);
      const base = `http://127.0.0.1:${port}`;
      // entry.path like "index.html" or "src/index.html"
      url = `${base}/${String(entry.path).replace(/^\/+/, '')}`;
      this._staticRoot = projectPath;
    }
    this._onEvent({ type: 'preview:load', entry, url });
    try {
      await view.webContents.loadURL(url);
    } catch (e) {
      this._onEvent({ type: 'preview:error', message: String(e.message || e) });
    }
    return url;
  }

  reload() {
    if (this.view) this.view.webContents.reload();
  }

  async close() {
    if (this.devProcess) { try { this.devProcess.kill('SIGTERM'); } catch {} this.devProcess = null; }
    if (this.staticServer) { try { this.staticServer.close(); } catch {} this.staticServer = null; this.staticPort = null; }
    if (this.view) {
      try {
        if (this.window && this.window.contentView && this.window.contentView.removeChildView) this.window.contentView.removeChildView(this.view);
        else if (this.window && this.window.removeChildView) this.window.removeChildView(this.view);
        this.view.webContents.close();
      } catch {}
      this.view = null;
    }
  }
}

module.exports = PreviewManager;
module.exports.safeJoin = safeJoin;
module.exports.MIME = MIME;
