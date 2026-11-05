'use strict';
/**
 * ClipperIQ Studio desktop shell.
 *
 * It starts the SAME Node/FFmpeg server the browser version uses, as a separate background process, and shows
 * the app in its own window. Nothing here depends on the user's browser, so browser clean-ups ("clear browsing
 * data", cache cleaners, IDM extensions, extensions that block scripts) can no longer affect it.
 *
 * Where things live (Windows): %APPDATA%\ClipperIQ Studio\  ->  data\ (videos, clips, database, logs) and
 * settings.env (optional: platform keys, same format as .env.example).
 */
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// The page origin (and so the app's saved library in the browser database) is tied to this address, so the port
// is fixed. If something else holds it we say so, instead of silently moving to another port and "losing" the library.
const HOST = '127.0.0.1';
const PORT = Number(process.env.CLIPPERIQ_PORT) || 38417;
const URL_BASE = `http://${HOST}:${PORT}`;

const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app-root') : path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'index.js');

let serverProc = null;
let win = null;
let quitting = false;
let restarts = 0;
let lastServerOutput = '';

function userDir() { return app.getPath('userData'); }
function dataDir() { return path.join(userDir(), 'data'); }

// optional settings.env next to the data: KEY=value lines, same keys as .env.example
function readSettingsEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(userDir(), 'settings.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no file is fine */ }
  return out;
}

function ping(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/healthz', timeout: timeoutMs }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startServer() {
  fs.mkdirSync(dataDir(), { recursive: true });
  lastServerOutput = '';
  const env = {
    ...process.env, ...readSettingsEnv(),
    ELECTRON_RUN_AS_NODE: '1',           // run the server with Electron's built-in Node: no separate Node install needed
    HOST, PORT: String(PORT), DATA_DIR: dataDir(), NODE_ENV: 'production',
    AUTH_PASSWORD: '',                    // the server is only reachable from this computer (127.0.0.1)
  };
  serverProc = fork(SERVER_ENTRY, [], { cwd: path.dirname(SERVER_ENTRY), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const keep = (b) => { lastServerOutput = (lastServerOutput + String(b)).slice(-4000); };
  serverProc.stdout.on('data', keep); serverProc.stderr.on('data', keep);
  serverProc.on('exit', (code, sig) => {
    serverProc = null;
    if (quitting) return;
    if (restarts < 3) { restarts++; setTimeout(startServer, 800); return; }   // brief crash: bring it back
    dialog.showErrorBox('ClipperIQ server stopped',
      `The video server stopped unexpectedly (code ${code ?? sig}).\n\n${lastServerOutput.trim().split('\n').slice(-8).join('\n')}\n\nLogs: ${path.join(dataDir(), 'logs')}`);
  });
}

async function waitForServer(maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await ping()) return true;
    if (!serverProc && restarts >= 3) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 640,
    backgroundColor: '#0a0a0f', title: 'ClipperIQ Studio', show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(URL_BASE + '/');

  // sign-in / publish popups stay inside the app; every other link opens in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.origin === URL_BASE || u.protocol === 'https:') return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { sandbox: true } } };
      if (u.protocol === 'mailto:') shell.openExternal(url);
    } catch { /* ignore */ }
    return { action: 'deny' };
  });
  // never navigate the main window away from the app
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL_BASE)) { e.preventDefault(); if (/^https:/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('render-process-gone', () => { if (!quitting) win.reload(); });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open videos & clips folder', click: () => shell.openPath(dataDir()) },
      { label: 'Open logs folder', click: () => shell.openPath(path.join(dataDir(), 'logs')) },
      { label: 'Open settings file (keys)', click: () => { const f = path.join(userDir(), 'settings.env'); if (!fs.existsSync(f)) fs.writeFileSync(f, '# Optional settings, same names as .env.example (e.g. TIKTOK_CLIENT_KEY=...)\n'); shell.openPath(f); } },
      { type: 'separator' }, { role: 'quit' } ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { label: 'Help', submenu: [{ label: `Server: ${URL_BASE}`, enabled: false }, { label: `Version ${app.getVersion()}`, enabled: false }] },
  ]));
}

if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    buildMenu();
    // Another program already uses our port? Then this is NOT our server: say so plainly.
    if (await ping()) {
      const r = dialog.showMessageBoxSync({ type: 'warning', buttons: ['Close', 'Open anyway'], defaultId: 0, cancelId: 0, title: 'ClipperIQ Studio',
        message: `Something is already running on ${URL_BASE}.`, detail: 'Close ClipperIQ Studio if it is already open (check the system tray / Task Manager), then start it again.' });
      if (r === 0) { app.quit(); return; }
    } else {
      startServer();
    }
    const ok = await waitForServer();
    if (!ok) {
      dialog.showErrorBox('ClipperIQ Studio could not start', `The video server did not come up.\n\n${lastServerOutput.trim().split('\n').slice(-10).join('\n') || 'No output.'}\n\nLogs: ${path.join(dataDir(), 'logs')}`);
      app.quit(); return;
    }
    // Start from a fresh HTTP cache so an updated install never shows old files (the app's saved library is not touched)
    try { await session.defaultSession.clearCache(); } catch { /* ignore */ }
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    if (serverProc) { try { serverProc.kill('SIGTERM'); } catch { /* already gone */ } }
  });
}
