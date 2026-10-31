# Strata

A layered photo editor for Windows modeled on Adobe Photoshop (Electron, vanilla JS). Not affiliated with Adobe.

## Run from source
```
npm install
npm start
```

## Releases & auto-update
- Bump `version` in `package.json`, then push to the `release` branch. GitHub Actions builds `Strata-Setup-<version>.exe` on Windows and publishes it as a release in this private repo.
- Installed copies check for updates every 6 hours (and via Help › Check for Updates). Because the repo is private, each PC needs a read-only fine-grained GitHub token (Contents: Read on `0smotis/strata`) pasted once in Edit › Preferences › Updates. It is stored encrypted with Windows DPAPI.
- Unzipped/portable copies don't auto-update; install with the Setup .exe.

## Layout
- `main.js` / `preload.js` / `updater.js` — Electron main process, IPC bridge, auto-updater
- `src/js/doc` — document model, compositing, selections, paths, PSD I/O
- `src/js/tools` — all tools (paint, select, pen, transform, misc)
- `src/js/engine` — adjustments, filters, inpainting, Camera Raw, warp math (pure JS, worker-safe)
- `src/js/ui` — panels, dialogs, options bar, Camera Raw / Warp / Neural Filters workspaces
- `src/js/ai` — local AI (Transformers.js / ONNX Runtime) and Generative Fill providers
- `test/` — Node engine tests and Electron e2e flows (`xvfb-run -a node test/e2e/smoke.cjs test/e2e/flow1.cjs`)
