const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  DATA_DIR_ARG,
  ensureDataDir,
  getDefaultDataDir,
  writeStoredDataDir
} = require('./data_path.js');
const { listSystemFonts } = require('./font_list.js');
const { configureDialogWindows, registerDialogIpc, showDialogWindow } = require('./dialog_window.js');
const { registerUiDefaults } = require('./ui_defaults.js');

// 应用根目录：开发版是项目根目录，安装版是 app.asar 根。
// 本文件位于 src/main/ 下，因此 assets/、src/renderer/ 与开发版 data/ 都相对它定位。
const APP_ROOT = app.getAppPath();

// 安装版使用 %APPDATA%/esprin_nemo/data，开发版使用项目内 data/；
// 用户在设置中自定义位置后，以应用配置目录中的 data-location.json 为准。
let dataDir = null;
function resolveDataDir() {
  if (!dataDir) {
    dataDir = ensureDataDir(APP_ROOT, app);
  }
  return dataDir;
}

// 读取用户配置的主题偏好并折算为实际生效的明暗色，供主窗口背景与弹窗窗口主题复用
function resolveEffectiveTheme() {
  let theme = 'system';
  try {
    const configFile = path.join(resolveDataDir(), 'config.json');
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config && config.theme) theme = config.theme;
    }
  } catch (error) {
    console.error('[Esprin Nemo] 读取主题配置失败:', error);
  }
  const isLight = theme === 'light' || (theme === 'system' && !nativeTheme.shouldUseDarkColors);
  return isLight ? 'light' : 'dark';
}

// 所有消息弹窗都在自绘标题栏的独立窗口中呈现，主题与当前界面保持一致
configureDialogWindows({
  getTheme: resolveEffectiveTheme,
  icon: path.join(APP_ROOT, 'assets', 'icon.png')
});

function normalizePathForCompare(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

// child 是否为 parent 的子路径（用于阻止把数据目录搬到自己的子目录/父目录，避免递归复制）
function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function dirHasData(dir) {
  return fs.existsSync(path.join(dir, 'index.json')) || fs.existsSync(path.join(dir, 'notes'));
}

// 切换数据位置：按需迁移数据、写记录文件，并让当前缓存与后续窗口都使用新目录。
// 渲染进程拿到返回的 dataDir 后会就地切换路径并重新加载数据，无需重启应用。
async function applyDataDirChange(targetPath, win, { persist = true, confirmExisting = true, targetLabel = '所选位置' } = {}) {
  const current = resolveDataDir();
  const target = path.resolve(targetPath);

  if (isSamePath(target, current)) {
    return { canceled: false, unchanged: true, dataDir: current };
  }
  if (isPathInside(current, target) || isPathInside(target, current)) {
    return { error: '新位置不能是当前数据目录的子目录或上级目录' };
  }
  if (!isDirWritable(target)) {
    return { error: '所选目录不可写，请检查访问权限或换一个位置' };
  }

  const existing = dirHasData(target);
  let migrate = false;

  if (existing && confirmExisting) {
    const choice = await showDialogWindow(win, {
      type: 'question',
      title: '数据存放位置',
      message: `${targetLabel}已存在 EsprinNemo 数据`,
      detail: '继续后应用会直接使用该位置中的笔记与配置，不会覆盖或删除任何文件。\n' + `位置：${target}`,
      buttons: [
        { id: 'use-existing', label: '使用该位置的现有数据', variant: 'primary' },
        { id: 'cancel', label: '取消', cancel: true }
      ]
    });
    if (choice.id !== 'use-existing') return { canceled: true };
  } else if (!existing) {
    const choice = await showDialogWindow(win, {
      type: 'question',
      title: '数据存放位置',
      message: `是否把现有数据迁移到${targetLabel}？`,
      detail: '“迁移现有数据”会把当前数据目录完整复制到该位置；选择“不迁移”则该位置从空白开始（原位置的数据会原样保留）。\n' + `位置：${target}`,
      buttons: [
        { id: 'migrate', label: '迁移现有数据', variant: 'primary' },
        { id: 'keep', label: '不迁移' },
        { id: 'cancel', label: '取消', cancel: true }
      ]
    });
    if (choice.id === 'cancel') return { canceled: true };
    migrate = choice.id === 'migrate';
  }

  if (migrate) {
    try {
      fs.cpSync(current, target, { recursive: true, force: true });
    } catch (error) {
      console.error('[Esprin Nemo] 迁移数据失败:', error);
      return { error: `迁移数据失败：${error.message}` };
    }
  }

  if (persist) writeStoredDataDir(target, app);
  dataDir = target;
  return { canceled: false, dataDir: target, migrated: migrate };
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

// 数据存放位置：渲染进程启动阶段同步查询（早于页面脚本执行，确保路径一致）
ipcMain.on('data:get-dir-sync', (event) => {
  event.returnValue = resolveDataDir();
});

// 数据存放位置：读取当前/默认位置，供设置页展示
ipcMain.handle('data:get-dir', () => {
  const current = resolveDataDir();
  const defaultDir = getDefaultDataDir(APP_ROOT, app);
  return {
    dataDir: current,
    defaultDir,
    isCustom: !isSamePath(current, defaultDir),
    isDefault: isSamePath(current, defaultDir)
  };
});

// 数据存放位置：弹出目录选择框并按需迁移
ipcMain.handle('data:choose-dir', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: '选择数据存放位置',
    defaultPath: resolveDataDir(),
    buttonLabel: '选择此文件夹',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return applyDataDirChange(result.filePaths[0], win);
});

// 数据存放位置：恢复为默认位置（并清除自定义记录）
ipcMain.handle('data:reset-dir', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const target = getDefaultDataDir(APP_ROOT, app);
  const result = await applyDataDirChange(target, win, { persist: false, targetLabel: '默认位置' });
  if (!result || result.canceled || result.error) return result || { canceled: true };
  writeStoredDataDir(null, app);
  dataDir = target;
  return { ...result, isCustom: false };
});

// 数据存放位置：在文件管理器中打开当前数据目录
ipcMain.handle('data:open-dir', async () => {
  const dir = resolveDataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    return await shell.openPath(dir);
  } catch (error) {
    console.error('[Esprin Nemo] 打开数据目录失败:', error);
    return String(error && error.message ? error.message : error);
  }
});

function createWindow() {
  Menu.setApplicationMenu(null);

  // 数据目录在渲染进程启动前就绪（安装版为 %APPDATA%/esprin_nemo/data）
  const currentDataDir = resolveDataDir();

  // 显示窗口前先定好主题背景色，避免出现闪光弹式闪烁
  const initialBg = resolveEffectiveTheme() === 'light' ? '#ffffff' : '#0d1117';

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: initialBg,
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
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

  win.loadURL('file://' + path.join(APP_ROOT, 'src', 'renderer', 'main.html'));
}

app.whenReady().then(() => {
  // 允许 Local Font Access API 的 local-fonts 权限（保持其它权限默认放行行为）
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
  } catch (error) {
    console.error('[Esprin Nemo] 注册字体权限处理器失败:', error);
  }

  // 窗口式消息弹窗的 IPC 通道
  registerDialogIpc();

  // 全局界面默认值：关闭 Chromium 默认焦点描边与 Tab 键焦点切换
  registerUiDefaults();

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});