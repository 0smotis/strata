const { _electron: electron } = require('playwright');
const path = require('path');
const OUT = process.env.OUT || '/tmp/claude-0/-home-claude/c8d4b7a6-6aff-57b5-a6bd-b2fe5a1f8788/scratchpad/shots';
require('fs').mkdirSync(OUT, { recursive: true });
(async () => {
  const appPath = path.join(__dirname, '..', '..');
  const app = await electron.launch({ executablePath: require('electron'), args: [appPath, '--no-sandbox', '--disable-gpu'], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const win = await app.firstWindow();
  const errs = [];
  win.on('console', m => { if (m.type()==='log') console.log('[page]', m.text()); if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  win.on('pageerror', e => errs.push('pageerror: ' + e.message + '\n' + e.stack));
  await win.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
  await win.waitForTimeout(2500);
  await win.screenshot({ path: OUT + '/01-home.png' });
  const script = process.argv[2];
  if (script) { const fn = require(path.resolve(script)); await fn(win, OUT, errs); }
  console.log('ERRORS:\n' + errs.join('\n'));
  await win.evaluate(() => app.docs.forEach(d => d.dirty = false)).catch(()=>{});
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 5000))]);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
