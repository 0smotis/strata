// Embed icon + version info into Strata.exe without Wine (pure JS)
const fs = require('fs'), path = require('path');
(async () => {
  const ResEdit = require('resedit');
  const pngToIco = (await import('png-to-ico')).default;
  const exePath = path.join(__dirname, '..', 'dist', 'win-unpacked', 'Strata.exe');
  const ico = await pngToIco(path.join(__dirname, '..', 'build', 'icon.png'));
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.ico'), ico);
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(ico);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const ver = require('../package.json').version.split('.').map(Number);
  vi.setFileVersion(ver[0], ver[1], ver[2], 0, 1033); vi.setProductVersion(ver[0], ver[1], ver[2], 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: 'Strata', ProductName: 'Strata', CompanyName: 'Noah', OriginalFilename: 'Strata.exe', InternalName: 'Strata', LegalCopyright: '' });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('exe resources updated');
})().catch(e => { console.error(e); process.exit(1); });
