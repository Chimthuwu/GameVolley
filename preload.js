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

  // ---- GameVolley: real project workspace ----
  projectCreate: inv('project:create'),
  projectOpen: inv('project:open'),
  projectGetActive: inv('project:active'),
  projectListFiles: inv('project:listFiles'),
  projectReadFile: inv('project:readFile'),
  projectWriteFile: inv('project:writeFile'),
  projectDeleteFile: inv('project:deleteFile'),
  projectSummary: inv('project:summary'),
  projectEntry: inv('project:entry'),
  projectOpenFolder: inv('project:openFolder'),
  checkpointList: inv('checkpoint:list'),
  checkpointRestore: inv('checkpoint:restore'),
  checkpointRemove: inv('checkpoint:remove'),
  openDir: inv('dialog:openDir'),
  codingStatus: inv('agent:codingStatus'),
  agentStart: inv('agent:start'),
  agentCancel: inv('agent:cancel'),

  // Embedded game preview (WebContentsView).
  previewLoad: inv('preview:load'),
  previewReload: inv('preview:reload'),
  previewSetBounds: inv('preview:setBounds'),
  previewFullscreen: inv('preview:fullscreen'),
  previewClose: inv('preview:close'),

  // Streaming events from the GameVolley orchestration.
  gameOnEvent: (cb) => ipcRenderer.on('gamevolley:event', (_e, ev) => cb(ev)),
});
