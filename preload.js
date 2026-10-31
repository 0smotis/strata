const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('host', {
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  openDirDialog: (opts) => ipcRenderer.invoke('dialog:openDir', opts),
  listDir: (dir, exts) => ipcRenderer.invoke('fs:listDir', dir, exts),
  joinPath: (...a) => ipcRenderer.invoke('path:join', ...a),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  readFile: (p) => ipcRenderer.invoke('fs:read', p),
  writeFile: (p, data) => ipcRenderer.invoke('fs:write', p, data),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  listFontFiles: () => ipcRenderer.invoke('fs:listFonts'),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  addRecent: (p) => ipcRenderer.invoke('recent:add', p),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  generate: (req) => ipcRenderer.invoke('ai:generate', req),
  info: () => ipcRenderer.invoke('app:info'),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return null; } },
  setTitle: (t) => ipcRenderer.send('win:title', t),
  closeConfirmed: () => ipcRenderer.send('app:close-confirmed'),
  devtools: () => ipcRenderer.send('app:devtools'),
  setSafeMode: (on) => ipcRenderer.invoke('app:safeMode', on),
  openLog: () => ipcRenderer.send('app:openLog'),
  relaunch: () => ipcRenderer.send('app:relaunch'),
  reload: () => ipcRenderer.send('app:reload'),
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    setToken: (t) => ipcRenderer.invoke('updates:set-token', t),
    setAuto: (on) => ipcRenderer.invoke('updates:set-auto', on),
  },
  openExternal: (u) => ipcRenderer.send('app:open-external', u),
  on: (ch, fn) => {
    const ok = ['open-files', 'request-close', 'window-state', 'updates:status'];
    if (ok.includes(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a));
  },
});
