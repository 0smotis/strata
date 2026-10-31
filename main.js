// Strata — main process
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, safeStorage, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const APP_ROOT = __dirname;
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const RECENT_FILE = () => path.join(app.getPath('userData'), 'recent.json');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// ---------- logging + safe mode ----------
const LOG_FILE = () => path.join(app.getPath('userData'), 'strata.log');
function log(...a) { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(LOG_FILE(), new Date().toISOString() + ' ' + a.map(x => x instanceof Error ? x.stack : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ') + '\n'); } catch {} }
process.on('uncaughtException', (e) => { log('uncaughtException', e); try { dialog.showErrorBox('Strata error', String(e && e.stack || e)); } catch {} });
const SAFE_FLAG = () => path.join(app.getPath('userData'), 'safe-mode');
const safeMode = process.argv.includes('--safe-mode') || (() => { try { return fs.existsSync(SAFE_FLAG()); } catch { return false; } })();
if (safeMode) { app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); }
log('start', app.getVersion(), process.platform, process.arch, 'safeMode=' + safeMode, process.argv.join(' '));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { log('another instance is running; handing over'); app.quit(); }

let win = null;
let pendingFiles = [];
let forceClose = false;

function filesFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile());
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: Math.min(1600, width), height: Math.min(1000, height),
    minWidth: 900, minHeight: 600,
    backgroundColor: '#262626',
    title: 'Strata',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#323232', symbolColor: '#d6d6d6', height: 32 },
    show: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.maximize(); win.show();
  win.once('ready-to-show', () => { if (!win.isVisible()) win.show(); win.focus(); });
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) { log('window not visible after 4s; forcing show'); win.show(); win.focus(); } }, 4000);
  win.webContents.on('did-fail-load', (_e, code, desc, url) => { log('did-fail-load', code, desc, url); dialog.showErrorBox('Strata could not load', `${desc} (${code})\n${url}\n\nA log is at ${LOG_FILE()}`); });
  win.webContents.on('render-process-gone', (_e, d) => { log('render-process-gone', d); if (d.reason !== 'clean-exit') { const r = dialog.showMessageBoxSync({ type: 'error', message: 'Strata stopped unexpectedly (' + d.reason + ').', buttons: ['Restart', 'Restart in Safe Mode (no GPU)', 'Quit'], defaultId: 0 }); if (r === 2) { forceClose = true; app.quit(); } else { if (r === 1) try { fs.writeFileSync(SAFE_FLAG(), '1'); } catch {} app.relaunch(); app.exit(0); } } });
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 3) log('renderer error:', message, src + ':' + line); });
  win.loadURL('app://strata/src/index.html');
  win.webContents.on('did-finish-load', () => {
    const files = [...pendingFiles, ...filesFromArgv(process.argv)];
    pendingFiles = [];
    if (files.length) win.webContents.send('open-files', files);
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    win.webContents.send('request-close');
  });
  win.on('maximize', () => win.webContents.send('window-state', 'max'));
  win.on('unmaximize', () => win.webContents.send('window-state', 'normal'));
}

app.on('second-instance', (_e, argv) => {
  const files = filesFromArgv(argv);
  if (win) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    if (files.length) win.webContents.send('open-files', files);
  }
});
app.on('open-file', (e, p) => { e.preventDefault(); if (win) win.webContents.send('open-files', [p]); else pendingFiles.push(p); });

app.on('child-process-gone', (_e, d) => {
  log('child-process-gone', d);
  if (d.type === 'GPU' && d.reason !== 'clean-exit' && !safeMode) { try { fs.writeFileSync(SAFE_FLAG(), '1'); } catch {} log('GPU process crashed; relaunching in safe mode'); app.relaunch(); app.exit(0); }
});
app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname);
    const full = path.normalize(path.join(APP_ROOT, rel));
    if (!full.startsWith(APP_ROOT)) return new Response('Forbidden', { status: 403 });
    try {
      const res = await net.fetch(pathToFileURL(full).toString());
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      if (full.endsWith('.mjs') || full.endsWith('.js')) headers.set('Content-Type', 'text/javascript');
      if (full.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      return new Response('Not found', { status: 404 });
    }
  });
  createWindow();
  require('./updater').setup({ getWin: () => win, getSettings: () => readJSON(SETTINGS_FILE(), {}), saveSettings: (patch) => writeJSON(SETTINGS_FILE(), { ...readJSON(SETTINGS_FILE(), {}), ...patch }), beforeInstall: () => { forceClose = true; } });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC ----------
const IMAGE_FILTERS = [
  { name: 'All Formats', extensions: ['psd', 'psb', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico', 'svg'] },
  { name: 'Photoshop (*.psd, *.psb)', extensions: ['psd', 'psb'] },
  { name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] }, { name: 'WebP', extensions: ['webp'] },
  { name: 'All Files', extensions: ['*'] },
];

ipcMain.handle('dialog:open', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { title: opts.title || 'Open', properties: ['openFile', ...(opts.multi === false ? [] : ['multiSelections'])], filters: opts.filters || IMAGE_FILTERS });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:openDir', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { title: opts.title || 'Choose Folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('fs:listDir', async (_e, dir, exts) => {
  try { const names = await fs.promises.readdir(dir); return names.filter(n => !exts || exts.includes(path.extname(n).slice(1).toLowerCase())).map(n => path.join(dir, n)); } catch { return []; }
});
ipcMain.handle('path:join', (_e, ...a) => path.join(...a));
ipcMain.handle('dialog:save', async (_e, opts = {}) => {
  const r = await dialog.showSaveDialog(win, { title: opts.title || 'Save As', defaultPath: opts.defaultPath, filters: opts.filters });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:confirm', async (_e, opts) => {
  const r = await dialog.showMessageBox(win, { type: opts.type || 'question', buttons: opts.buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: opts.cancelId ?? (opts.buttons ? opts.buttons.length - 1 : 1), title: 'Strata', message: opts.message, detail: opts.detail });
  return r.response;
});
ipcMain.handle('fs:read', async (_e, p) => { const b = await fs.promises.readFile(p); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); });
ipcMain.handle('fs:write', async (_e, p, data) => { await fs.promises.writeFile(p, Buffer.from(data)); return true; });
ipcMain.handle('fs:stat', async (_e, p) => { try { const s = await fs.promises.stat(p); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; } });
ipcMain.handle('fs:listFonts', async () => {
  // Windows font folder names as fallback when Local Font Access isn't available.
  const dirs = process.platform === 'win32' ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')] : ['/usr/share/fonts', '/System/Library/Fonts', '/Library/Fonts'];
  const out = new Set();
  for (const d of dirs) { try { for (const f of await fs.promises.readdir(d)) if (/\.(ttf|otf|ttc)$/i.test(f)) out.add(f); } catch {} }
  return [...out];
});

function readJSON(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
function writeJSON(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

ipcMain.handle('recent:get', () => readJSON(RECENT_FILE(), []).filter(p => fs.existsSync(p)));
ipcMain.handle('recent:add', (_e, p) => {
  let list = readJSON(RECENT_FILE(), []).filter(x => x !== p); list.unshift(p); list = list.slice(0, 20); writeJSON(RECENT_FILE(), list); return list;
});
ipcMain.handle('recent:clear', () => { writeJSON(RECENT_FILE(), []); return []; });

const SECRET_KEYS = ['stabilityKey', 'openaiKey'];
function loadSettings() {
  const s = readJSON(SETTINGS_FILE(), {});
  for (const k of SECRET_KEYS) {
    if (s[k] && s[k].startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
      try { s[k] = safeStorage.decryptString(Buffer.from(s[k].slice(4), 'base64')); } catch { s[k] = ''; }
    }
  }
  return s;
}
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, s) => {
  const disk = readJSON(SETTINGS_FILE(), {});
  const out = { ...s, updateTokenEnc: disk.updateTokenEnc, updateAuto: s.updateAuto ?? disk.updateAuto };
  for (const k of SECRET_KEYS) if (out[k] && safeStorage.isEncryptionAvailable()) out[k] = 'enc:' + safeStorage.encryptString(out[k]).toString('base64');
  writeJSON(SETTINGS_FILE(), out); return true;
});

ipcMain.on('app:close-confirmed', () => { forceClose = true; win.close(); });
ipcMain.on('app:devtools', () => win.webContents.toggleDevTools());
ipcMain.handle('app:safeMode', (_e, on) => { try { if (on) fs.writeFileSync(SAFE_FLAG(), '1'); else if (fs.existsSync(SAFE_FLAG())) fs.unlinkSync(SAFE_FLAG()); } catch {} return { safeMode, flag: fs.existsSync(SAFE_FLAG()) }; });
ipcMain.on('app:openLog', () => shell.openPath(LOG_FILE()));
ipcMain.on('app:relaunch', () => { forceClose = true; app.relaunch(); app.exit(0); });
ipcMain.on('app:reload', () => win.webContents.reload());
ipcMain.on('app:open-external', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron, userData: app.getPath('userData') }));
ipcMain.on('win:title', (_e, t) => { if (win) win.setTitle(t); });

// ---------- Generative Fill providers (run in main to avoid CORS) ----------
ipcMain.handle('ai:generate', async (_e, req) => {
  const s = loadSettings();
  const provider = req.provider || s.genProvider || 'none';
  const n = Math.max(1, Math.min(4, req.count || 1));
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  if (provider === 'a1111') {
    const base = (s.a1111Url || 'http://127.0.0.1:7860').replace(/\/$/, '');
    const body = {
      init_images: [b64(req.image)], mask: b64(req.maskBW), prompt: req.prompt || '', negative_prompt: s.negativePrompt || 'blurry, low quality, watermark, text',
      denoising_strength: req.prompt ? 1.0 : 0.9, inpainting_fill: req.prompt ? 1 : 1, inpaint_full_res: false, mask_blur: 4,
      batch_size: n, n_iter: 1, steps: s.a1111Steps || 28, cfg_scale: 6, width: req.width, height: req.height, sampler_name: s.a1111Sampler || undefined,
    };
    const r = await fetch(base + '/sdapi/v1/img2img', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('Stable Diffusion server error ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    return (j.images || []).slice(0, n).map(im => new Uint8Array(Buffer.from(im.split(',').pop(), 'base64')));
  }
  if (provider === 'stability') {
    if (!s.stabilityKey) throw new Error('Add your Stability AI API key in Edit › Preferences › Generative AI.');
    const outs = [];
    for (let i = 0; i < n; i++) {
      const fd = new FormData();
      fd.append('image', new Blob([req.image], { type: 'image/png' }), 'image.png');
      fd.append('mask', new Blob([req.maskBW], { type: 'image/png' }), 'mask.png');
      fd.append('prompt', req.prompt || 'seamless natural background, matching surroundings');
      fd.append('output_format', 'png');
      fd.append('seed', String(Math.floor(Math.random() * 4294967294)));
      const r = await fetch('https://api.stability.ai/v2beta/stable-image/edit/inpaint', { method: 'POST', headers: { Authorization: 'Bearer ' + s.stabilityKey, Accept: 'image/*' }, body: fd });
      if (!r.ok) throw new Error('Stability AI error ' + r.status + ': ' + (await r.text()).slice(0, 300));
      outs.push(new Uint8Array(await r.arrayBuffer()));
    }
    return outs;
  }
  if (provider === 'openai') {
    if (!s.openaiKey) throw new Error('Add your OpenAI API key in Edit › Preferences › Generative AI.');
    const fd = new FormData();
    fd.append('model', s.openaiModel || 'gpt-image-1');
    fd.append('image', new Blob([req.image], { type: 'image/png' }), 'image.png');
    fd.append('mask', new Blob([req.maskAlpha], { type: 'image/png' }), 'mask.png');
    fd.append('prompt', req.prompt || 'Fill the masked area so it blends seamlessly with the surroundings. Remove any object there.');
    fd.append('n', String(n));
    fd.append('size', req.width > req.height * 1.2 ? '1536x1024' : req.height > req.width * 1.2 ? '1024x1536' : '1024x1024');
    const r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + s.openaiKey }, body: fd });
    if (!r.ok) throw new Error('OpenAI error ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    return (j.data || []).map(d => new Uint8Array(Buffer.from(d.b64_json, 'base64')));
  }
  throw new Error('NO_PROVIDER');
});
