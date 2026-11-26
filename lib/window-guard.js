'use strict';
// The app window carries the `pv` bridge, which can write files, run coding
// agents and start programs. Only GameVolley's own page may ever be in that
// window or send requests through it.
//
// Free of Electron imports (the objects are passed in) so it runs under
// `node --test`.

const path = require('node:path');
const { fileURLToPath } = require('node:url');

function createWindowGuard(appIndexPath, platform = process.platform) {
  const normalise = (p) => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const appPage = normalise(appIndexPath);

  // True only for the app's own index.html (any #hash or ?query on it).
  function isAppUrl(url) {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'file:' || u.host) return false;
      u.hash = '';
      u.search = '';
      return normalise(fileURLToPath(u)) === appPage;
    } catch { return false; }
  }

  // Stops the window leaving the app (a dropped file or link would otherwise open
  // right here), and sends only ordinary web links to the system browser.
  function guardWindow(win, shell) {
    const block = (event, url) => { if (!isAppUrl(url)) event.preventDefault(); };
    win.webContents.on('will-navigate', block);
    win.webContents.on('will-redirect', block);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  }

  // Wraps ipcMain.handle so every handler registered afterwards checks the sender.
  function guardIpc(ipcMain) {
    const register = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, handler) => register(channel, (event, ...args) => {
      if (!isAppUrl(event && event.senderFrame && event.senderFrame.url)) {
        throw new Error(`Blocked "${channel}": the request did not come from GameVolley.`);
      }
      return handler(event, ...args);
    });
  }

  return { isAppUrl, guardWindow, guardIpc };
}

module.exports = { createWindowGuard };
