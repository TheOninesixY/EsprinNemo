const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const { DATA_DIR_ARG, ensureDataDir } = require('./data_path.js');

// 安装版使用 %APPDATA%/esprin_nemo/data，开发版使用项目内 data/
let dataDir = null;
function resolveDataDir() {
  if (!dataDir) {
    dataDir = ensureDataDir(__dirname, app);
  }
  return dataDir;
}

ipcMain.handle('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.handle('window:maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.handle('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

ipcMain.handle('window:toggle-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const next = !win.isFullScreen();
  win.setFullScreen(next);
  return next;
});

function createWindow() {
  Menu.setApplicationMenu(null);

  // Clean sync file swap on start if main.html has duplicate appended content
  const fs = require('fs');
  const targetPath = path.join(__dirname, 'main.html');
  const cleanPath = path.join(__dirname, 'main.html.new');
  if (fs.existsSync(cleanPath)) {
    try {
      fs.writeFileSync(targetPath, fs.readFileSync(cleanPath, 'utf8'), 'utf8');
      fs.unlinkSync(cleanPath);
    } catch (e) {
      console.error(e);
    }
  }

  // 数据目录在渲染进程启动前就绪（安装版为 %APPDATA%/esprin_nemo/data）
  const currentDataDir = resolveDataDir();

  // Preload theme before showing window to prevent flashing
  let initialBg = '#0d1117';
  try {
    const configFile = path.join(currentDataDir, 'config.json');
    let theme = 'system';
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.theme) theme = config.theme;
    }
    const { nativeTheme } = require('electron');
    const isLight = theme === 'light' || (theme === 'system' && !nativeTheme.shouldUseDarkColors);
    if (isLight) {
      initialBg = '#ffffff';
    }
  } catch (e) {
    console.error(e);
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: initialBg,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      additionalArguments: [DATA_DIR_ARG + currentDataDir]
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('enter-full-screen', () => {
    win.webContents.send('window:fullscreen-changed', true);
  });

  win.on('leave-full-screen', () => {
    win.webContents.send('window:fullscreen-changed', false);
  });

  win.loadURL('file://' + path.join(__dirname, 'main.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});