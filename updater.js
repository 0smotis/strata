// Auto-updates from GitHub Releases in Noah's private repo (0smotis/strata).
// A read-only GitHub token (entered once in Preferences › Updates) is stored encrypted with Windows DPAPI (safeStorage)
// and only handed to electron-updater in memory via GH_TOKEN — never written to disk in plain text.
const { app, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const OWNER = '0smotis', REPO = 'strata';
let state = { state: 'idle' }, ready = false, timers = [], getWin = () => null, getSettings = () => ({}), saveSettings = () => {};

function token() {
  const enc = getSettings().updateTokenEnc;
  if (!enc) return '';
  try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : ''; } catch { return ''; }
}
function send(patch) { state = { ...state, ...patch, at: Date.now() }; const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('updates:status', state); }
function friendly(e) {
  const m = String(e?.message || e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|getaddrinfo|network/i.test(m)) return "Couldn't reach GitHub. Check your internet connection.";
  if (/401|Bad credentials/i.test(m)) return 'GitHub didn’t accept the access token. Create a new one and paste it in Preferences › Updates.';
  if (/403|Resource not accessible/i.test(m)) return 'The access token can’t read the strata repository. Give it read access to Contents.';
  if (/404|No published versions/i.test(m)) return 'No updates have been published yet.';
  return m.split('\n')[0].slice(0, 200);
}
function init() {
  timers.forEach(clearTimeout); timers = [];
  if (!app.isPackaged) { send({ state: 'unavailable', reason: 'dev' }); return; }
  if (process.platform === 'win32' && !fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Strata.exe'))) { send({ state: 'unavailable', reason: 'portable' }); return; }
  if (!token()) { send({ state: 'unavailable', reason: 'no-token' }); return; }
  const { autoUpdater } = require('electron-updater');
  const yml = path.join(app.getPath('userData'), 'update-feed.yml');
  fs.writeFileSync(yml, `provider: github\nowner: ${OWNER}\nrepo: ${REPO}\nprivate: true\nupdaterCacheDirName: strata-updater\n`);
  process.env.GH_TOKEN = token();
  autoUpdater.updateConfigPath = yml;
  send({ state: 'idle', feed: `${OWNER}/${REPO}`, version: app.getVersion() });
  if (ready) { timers.push(setTimeout(() => check(false), 2000)); return; }
  autoUpdater.autoDownload = getSettings().updateAuto !== false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => send({ state: 'checking', message: null }));
  autoUpdater.on('update-available', (i) => send({ state: autoUpdater.autoDownload ? 'downloading' : 'available', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => send({ state: 'current', version: app.getVersion() }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => send({ state: 'ready', version: i.version, percent: 100 }));
  autoUpdater.on('error', (e) => send({ state: 'error', message: friendly(e) }));
  ready = true;
  timers.push(setTimeout(() => check(false), 15000));
  setInterval(() => check(false), 6 * 60 * 60 * 1000);
}
async function check(manual) {
  if (!ready) return state;
  if (state.state === 'ready' || (['checking', 'downloading'].includes(state.state) && !manual)) return state;
  try { const { autoUpdater } = require('electron-updater'); autoUpdater.autoDownload = getSettings().updateAuto !== false || manual; await autoUpdater.checkForUpdates(); }
  catch (e) { send({ state: 'error', message: friendly(e) }); }
  return state;
}
function setup(opts) {
  ({ getWin, getSettings, saveSettings } = opts);
  ipcMain.handle('updates:status', () => ({ ...state, current: app.getVersion(), hasToken: !!token(), packaged: app.isPackaged }));
  ipcMain.handle('updates:check', () => check(true));
  ipcMain.handle('updates:install', () => { if (state.state === 'ready') { opts.beforeInstall && opts.beforeInstall(); require('electron-updater').autoUpdater.quitAndInstall(true, true); } });
  ipcMain.handle('updates:set-token', (_e, t) => {
    t = String(t || '').trim();
    if (t && !safeStorage.isEncryptionAvailable()) throw new Error('Windows can’t encrypt the token on this computer.');
    saveSettings({ updateTokenEnc: t ? safeStorage.encryptString(t).toString('base64') : '' });
    init(); return { hasToken: !!t };
  });
  ipcMain.handle('updates:set-auto', (_e, on) => { saveSettings({ updateAuto: !!on }); return true; });
  init();
}
module.exports = { setup };
