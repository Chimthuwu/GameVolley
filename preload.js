const { contextBridge, ipcRenderer } = require('electron');
const inv = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('pv', {
  hasKey: inv('key:has'), keyState: inv('key:state'), saveKey: inv('key:save'), testKey: inv('key:test'),
  models: inv('models:list'), copy: inv('clipboard:write'), openFolder: inv('folder:open'), openUrl: inv('url:open'),
  start: inv('run:start'), sendNotes: inv('run:notes'), stop: inv('run:stop'), setRunModels: inv('run:models'),
  winMin: inv('window:minimize'), winMax: inv('window:maximize'), winClose: inv('window:close'),
  runs: inv('runs:list'), openRun: inv('runs:read'), updateRun: inv('runs:update'), utility: inv('utility:call'), keyUsage: inv('key:usage'),
  // Sidebar history management: rename / delete / move a volley, and rename / delete a project group.
  renameRun: inv('runs:rename'), deleteRun: inv('runs:delete'), moveRun: inv('runs:move'),
  projects: inv('projects:list'), renameProject: inv('projects:rename'), deleteProject: inv('projects:delete'),
  githubTokenInfo: inv('github:token:has'), saveGithubToken: inv('github:token:set'), clearGithubToken: inv('github:token:clear'), fetchGithubRepo: inv('github:repo:fetch'),
  // Multi-provider support
  providersList: inv('providers:list'), providersStatus: inv('providers:status'),
  providerCredsHas: inv('provider:creds:has'), providerCredsSave: inv('provider:creds:save'),
  providerModels: inv('provider:models'), providerConnect: inv('provider:connect'),
  onEvent: (cb) => ipcRenderer.on('run:event', (_e, ev) => cb(ev)),
});
