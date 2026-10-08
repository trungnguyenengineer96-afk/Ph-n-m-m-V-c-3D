/**
 * Desktop shell (Electron). Serves the built web app from dist/ through a
 * privileged app:// scheme (workers, WebAssembly and fetch need a real origin),
 * and forwards files opened with the app (double-click / "Open with") to the UI.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const EXTENSIONS = ['step', 'stp', 'iges', 'igs', 'brep', 'brp', 'sldprt', 'sldasm', 'slddrw', 'dxf', 'stl', 'obj', 'gltf', 'glb', '3mf', 'ply', 'cvpart'];

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let pendingFiles = [];
let rendererReady = false;

function filesFromArgv(argv) {
  return argv.slice(1).filter((a) => {
    if (a.startsWith('-')) return false;
    const ext = path.extname(a).slice(1).toLowerCase();
    return EXTENSIONS.includes(ext) && fs.existsSync(a);
  });
}

function sendFiles(paths) {
  if (!paths.length) return;
  if (!win || !rendererReady) {
    pendingFiles.push(...paths);
    return;
  }
  const files = [];
  for (const p of paths) {
    try {
      const buf = fs.readFileSync(p);
      files.push({ name: path.basename(p), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), lastModified: fs.statSync(p).mtimeMs });
    } catch (e) {
      dialog.showErrorBox('CAD Viewer 3D', `Không đọc được tệp ${p}: ${e.message}`);
    }
  }
  if (files.length) win.webContents.send('open-files', files);
  if (win.isMinimized()) win.restore();
  win.focus();
}

async function openDialog() {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Tệp CAD', extensions: EXTENSIONS },
      { name: 'Tất cả', extensions: ['*'] },
    ],
  });
  if (!r.canceled) sendFiles(r.filePaths);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'CAD Viewer 3D',
    backgroundColor: '#eef1f5',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL('app://local/index.html');
  win.webContents.on('did-start-loading', () => (rendererReady = false));
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    const files = pendingFiles;
    pendingFiles = [];
    sendFiles(files);
  });
  // External links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const template = [
    {
      label: 'Tệp',
      submenu: [
        { label: 'Mở…', accelerator: 'CmdOrCtrl+O', click: openDialog },
        { type: 'separator' },
        { role: 'quit', label: 'Thoát' },
      ],
    },
    {
      label: 'Xem',
      submenu: [
        { role: 'reload', label: 'Tải lại' },
        { role: 'togglefullscreen', label: 'Toàn màn hình' },
        { role: 'resetZoom', label: 'Cỡ chữ mặc định' },
        { role: 'zoomIn', label: 'Phóng to giao diện' },
        { role: 'zoomOut', label: 'Thu nhỏ giao diện' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Công cụ nhà phát triển' },
      ],
    },
    {
      label: 'Trợ giúp',
      submenu: [{ label: `Phiên bản ${app.getVersion()}`, enabled: false }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => sendFiles(filesFromArgv(argv)));
  app.whenReady().then(() => {
    protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(DIST, rel));
      if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
      const res = await net.fetch(pathToFileURL(file).toString());
      const type = MIME[path.extname(file).toLowerCase()];
      if (!type) return res;
      return new Response(res.body, { status: res.status, headers: { 'content-type': type } });
    });
    ipcMain.handle('open-dialog', openDialog);
    buildMenu();
    pendingFiles = filesFromArgv(process.argv);
    createWindow();
  });
  // macOS "Open with"
  app.on('open-file', (e, p) => {
    e.preventDefault();
    sendFiles([p]);
  });
  app.on('window-all-closed', () => app.quit());
}
