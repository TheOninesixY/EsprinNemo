const { app, BrowserWindow, Menu, ipcMain, session } = require('electron');
const path = require('path');
const { DATA_DIR_ARG, ensureDataDir } = require('./data_path.js');
const { listSystemFonts } = require('./font_list.js');

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

// 系统字体列表：渲染进程可通过 Local Font Access API 直接获取，这里作为兜底
let cachedSystemFonts = null;
ipcMain.handle('fonts:list', () => {
  if (!cachedSystemFonts) {
    try {
      cachedSystemFonts = listSystemFonts();
    } catch (error) {
      console.error('[Esprin Nemo] 读取系统字体失败:', error);
      cachedSystemFonts = [];
    }
  }
  return cachedSystemFonts;
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

app.whenReady().then(() => {
  // 允许 Local Font Access API 的 local-fonts 权限（保持其它权限默认放行行为）
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
  } catch (error) {
    console.error('[Esprin Nemo] 注册字体权限处理器失败:', error);
  }

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});