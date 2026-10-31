const { _electron: electron } = require('playwright');
(async () => {
  const app = await electron.launch({ executablePath: '/home/claude/strata/dist-linux/linux-unpacked/strata', args: ['--no-sandbox'] });
  const win = await app.firstWindow();
  const errs = []; win.on('console', m => errs.push(m.type() + ' ' + m.text())); win.on('pageerror', e => errs.push('pageerror ' + e.message));
  await win.waitForTimeout(4000);
  console.log('url', win.url(), 'visible', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.isVisible())));
  console.log('title', await win.title(), 'menus', await win.evaluate(() => document.querySelectorAll('#menubar .mi').length));
  console.log(errs.join('\n'));
  await win.screenshot({ path: '/tmp/claude-0/-home-claude/c8d4b7a6-6aff-57b5-a6bd-b2fe5a1f8788/scratchpad/shots/pk.png' });
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
