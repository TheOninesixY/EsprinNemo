const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  DATA_DIR_ARG,
  ensureDataDir,
  ensureDirUsable,
  getDefaultDataDir,
  getIsolatedUserDataDir,
  getLocationFile,
  getStartupBlocker,
  isDevRun,
  isPortableRun: isPortableDataRun,
  writeStoredDataDir
} = require('./data_path.js');
const { listSystemFonts } = require('./font_list.js');
const { configureDialogWindows, registerDialogIpc, showDialogWindow } = require('./dialog_window.js');
const { disposeDesktopLayer } = require('./desktop_layer.js');
const {
  configureDesktopMenu,
  handleDesktopMenuArgv,
  registerDesktopMenu,
  unregisterDesktopMenu
} = require('./desktop_menu.js');
const { configureScratchpadWindow, isScratchpadWindowOpen, openScratchpadWindow, registerScratchpadIpc } = require('./scratchpad_window.js');
const {
  configureStickyNotes,
  closeStickyNote,
  createStickyNote,
  hideAllStickyNotes,
  isStickyNoteOpen,
  listStickyNotes,
  registerStickyNotesIpc,
  releaseStickyNotes,
  restoreStickyNotes,
  revealStickyNote,
  showAllStickyNotes
} = require('./sticky_notes.js');
const { buildWindowAppearance } = require('./window_appearance.js');
const { configureTray, isTrayEnabled, registerTrayIpc } = require('./tray.js');
const { configureAutoLaunch, registerAutoLaunchIpc } = require('./auto_launch.js');
const { registerUiDefaults } = require('./ui_defaults.js');
const { configureAiService, registerAiIpc } = require('./ai_service.js');
const { adoptLegacyKeyFile, migrateApiKeyFromConfig } = require('./ai_secret.js');
const { configureSyncServer, registerSyncIpc, applyAutoSyncRuntime } = require('./sync_server.js');
const { disposeSpeechWindows, registerSpeechIpc } = require('./speech_windows.js');
const { configureUpdater, registerUpdateIpc, scheduleAutoChecks, isPortableRun, PORTABLE_ARG } = require('./updater.js');

const APP_ROOT = app.getAppPath();

const APP_ICON_PATH = path.join(APP_ROOT, require('../../package.json').icon);

const IS_DEV_RUN = isDevRun(app);

const IS_PORTABLE_RUN = isPortableRun();

const IS_PORTABLE_DATA_RUN = isPortableDataRun();
const DATA_DIR_LOCKED_MESSAGE = '当前为开发运行（bun start），数据固定存放在项目内的 data/ 目录，无法更改数据存放位置。';

const ISOLATED_USER_DATA_DIR = getIsolatedUserDataDir();
if (ISOLATED_USER_DATA_DIR) {
  try {

fs.mkdirSync(ISOLATED_USER_DATA_DIR, { recursive: true });
  } catch (error) {
    console.warn('[Esprin Nemo] 创建独立运行时目录失败:', error.message);
  }

  for (const name of ['userData', 'sessionData', 'crashDumps']) {
    try {

      app.setPath(name, name === 'crashDumps' ? path.join(ISOLATED_USER_DATA_DIR, 'Crashpad') : ISOLATED_USER_DATA_DIR);
    } catch (error) {

      console.warn(`[Esprin Nemo] 设置 ${name} 路径失败:`, error.message);
    }
  }
  try {
    app.setAppLogsPath(path.join(ISOLATED_USER_DATA_DIR, 'logs'));
  } catch (error) {
    console.warn('[Esprin Nemo] 设置日志目录失败:', error.message);
  }
}

let dataDir = null;
function resolveDataDir() {
  if (!dataDir) {
    dataDir = ensureDataDir(APP_ROOT, app);
  }
  return dataDir;
}

let configCacheKey = '';
let configCacheValue = {};

function readUserConfig() {
  try {
    const configFile = path.join(resolveDataDir(), 'config.json');

    let stat = null;
    try {

stat = fs.statSync(configFile, { bigint: true });
    } catch (error) {
      stat = null;
    }
    if (!stat) {
      try {
        stat = fs.statSync(configFile);
      } catch (error) {

        configCacheKey = '';
        configCacheValue = {};
        return configCacheValue;
      }
    }

    const stamp = stat.mtimeNs === undefined ? stat.mtimeMs : stat.mtimeNs;
    const key = `${configFile}\u0000${stamp}\u0000${stat.size}`;
    if (configCacheKey === key) return configCacheValue;

    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    configCacheKey = key;
    configCacheValue = (config && typeof config === 'object' && !Array.isArray(config)) ? config : {};
    return configCacheValue;
  } catch (error) {
    console.error('[Esprin Nemo] 读取用户配置失败:', error);
    return {};
  }
}

function updateUserConfig(patch) {
  if (!patch || typeof patch !== 'object') return false;

  const configFile = path.join(resolveDataDir(), 'config.json');
  try {
    const next = JSON.stringify({ ...readUserConfig(), ...patch }, null, 2);
    if (fs.existsSync(configFile) && fs.readFileSync(configFile, 'utf8') === next) return true;

    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const tempFile = `${configFile}.tmp`;
    fs.writeFileSync(tempFile, next, 'utf8');
    fs.renameSync(tempFile, configFile);
    return true;
  } catch (error) {
    console.error('[Esprin Nemo] 写入用户配置失败:', error);
    return false;
  }
}

function resolveEffectiveTheme() {
  const theme = readUserConfig().theme || 'system';
  const isLight = theme === 'light' || (theme === 'system' && !nativeTheme.shouldUseDarkColors);
  return isLight ? 'light' : 'dark';
}

function normalizeAccentHex(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  const rgb = text.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(',').map((item) => Number(item.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((value) => Number.isFinite(value))) {
      const hex = parts.slice(0, 3)
        .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
        .join('');
      return `#${hex.toUpperCase()}`;
    }
    return '';
  }
  const hex = text.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length === 3) return `#${hex.split('').map((char) => char + char).join('').toUpperCase()}`;
  if (hex.length >= 6) return `#${hex.slice(0, 6).toUpperCase()}`;
  return '';
}

function getSystemAccentColor() {
  try {
    const { systemPreferences } = require('electron');
    if (typeof systemPreferences.getAccentColor !== 'function') return '';
    return normalizeAccentHex(systemPreferences.getAccentColor());
  } catch (e) {
    return '';
  }
}

function resolveAccentColor() {
  const raw = readUserConfig().accentColor;
  if (raw === undefined || raw === null) {
    return getSystemAccentColor();
  }
  if (typeof raw !== 'string') return getSystemAccentColor();
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed.toLowerCase() === 'system') {
    return getSystemAccentColor();
  }
  const matched = trimmed.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!matched) return getSystemAccentColor();
  let hex = matched[1];
  if (hex.length === 3) hex = hex.split('').map((char) => char + char).join('');
  return `#${hex.toUpperCase()}`;
}

function resolveBrandColor() {
  const raw = readUserConfig().brandColor;
  return raw === 'mono' || raw === 'accent' ? raw : 'brand';
}

function resolveThemeStyle() {
  const raw = readUserConfig().themeStyle;
  return raw === 'alom' || raw === 'magic' ? raw : 'default';
}

function resolveCornerRadius() {
  const raw = readUserConfig().cornerRadius;
  return raw === 'square' || raw === 'slight' || raw === 'large' ? raw : 'default';
}

function resolveWindowFonts() {
  const raw = readUserConfig().fonts;
  return raw && typeof raw === 'object' ? raw : {};
}

configureDialogWindows({
  getTheme: resolveEffectiveTheme,
  getStyle: resolveThemeStyle,
  getAccent: resolveAccentColor,
  getBrandColor: resolveBrandColor,
  getRadius: resolveCornerRadius,
  getFonts: resolveWindowFonts,
  icon: APP_ICON_PATH
});

configureScratchpadWindow({
  getTheme: resolveEffectiveTheme,
  getStyle: resolveThemeStyle,
  getAccent: resolveAccentColor,
  getRadius: resolveCornerRadius,
  getFonts: resolveWindowFonts,
  getDataDir: resolveDataDir,

  getOwner: () => mainWindow,
  icon: APP_ICON_PATH,

  onClosed: handleScratchpadClosed
});

configureStickyNotes({
  getTheme: resolveEffectiveTheme,
  getStyle: resolveThemeStyle,
  getAccent: resolveAccentColor,
  getRadius: resolveCornerRadius,
  getFonts: resolveWindowFonts,
  getDataDir: resolveDataDir,
  getConfig: readUserConfig,

  getOwner: () => mainWindow,
  icon: APP_ICON_PATH,

  onClosed: handleStickyNoteClosed
});

configureDesktopMenu({
  getItems: listStickyNotes,
  onAction: handleStickyMenuAction,
  icon: APP_ICON_PATH
});

configureAiService({ getDataDir: resolveDataDir });

configureSyncServer({
  getDataDir: resolveDataDir,
  getConfig: readUserConfig,
  onRendererMessage: (channel, payload) => {
    if (mainWindowClosed || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
  }
});

configureUpdater({
  getConfig: readUserConfig,

  setConfig: updateUserConfig,

  getOwner: () => (mainWindowClosed ? null : mainWindow)
});

let mainWindow = null;

let mainWindowClosed = false;

let isQuitting = false;

let startupBlocked = false;

function setupTray() {
  configureTray({
    getConfig: readUserConfig,
    getOwner: () => mainWindow,
    icon: APP_ICON_PATH,
    onShowMainWindow: showMainWindow,

    onOpenScratchpad: openScratchpadWindow,
    onNewStickyNote: () => { createStickyNote({ kind: 'free' }); },
    onShowStickyNotes: showAllStickyNotes,
    onHideStickyNotes: hideAllStickyNotes,
    onQuit: () => { app.quit(); },

onEnabledChanged: (enabled) => { if (!enabled) quitIfNoVisibleWindow(); }
  });
}

function handleStickyMenuAction(action, id) {
  if (action === 'pick' || action === 'new') {
    const win = showMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('tray:action', 'pick-sticky-note');
    }
    return true;
  }
  if (action === 'show') return revealStickyNote(id);
  if (action === 'close') return closeStickyNote(id);
  if (action === 'show-all') return showAllStickyNotes();
  if (action === 'hide-all') return hideAllStickyNotes();
  return null;
}

function showMainWindow() {
  if (isQuitting || startupBlocked) return null;
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();

  mainWindowClosed = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

function quitIfNoVisibleWindow() {
  if (isQuitting || isTrayEnabled()) return;
  if (isScratchpadWindowOpen() || isStickyNoteOpen()) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindowClosed) return;
  app.quit();
}

function handleScratchpadClosed() {
  if (isQuitting) return;
  if (isTrayEnabled()) return;

  if (isStickyNoteOpen()) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindowClosed) return;
  app.quit();
}

function handleStickyNoteClosed() {
  if (isQuitting) return;
  if (isTrayEnabled()) return;
  if (isScratchpadWindowOpen()) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindowClosed) return;
  app.quit();
}

function normalizePathForCompare(target) {
  return path.resolve(target).toLowerCase();
}

function isSamePath(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

function isInternalPageUrl(targetUrl) {
  try {
    const parsed = new URL(String(targetUrl));
    if (parsed.protocol !== 'file:') return false;
    const decoded = decodeURIComponent(parsed.pathname);

    const filePath = decoded.replace(/^\/([a-zA-Z]:)/, '$1');
    const relative = path.relative(APP_ROOT, path.resolve(filePath));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch (error) {
    return false;
  }
}

function openExternalUrl(targetUrl) {
  const value = String(targetUrl || '');
  if (!/^https?:\/\//i.test(value)) return;
  shell.openExternal(value).catch((error) => {
    console.error('[Esprin Nemo] 打开外部链接失败:', error);
  });
}

app.on('web-contents-created', (event, contents) => {

  contents.on('console-message', (event, ...args) => {

    const details = args[0] && typeof args[0] === 'object' ? args[0] : null;
    const level = details ? details.level : args[0];
    const message = details ? details.message : args[1];
    const line = details ? details.lineNumber : args[2];
    const source = details ? details.sourceId : args[3];
    if (level !== 'error' && level !== 3) return;
    const where = source ? ` (${source}:${line})` : '';
    console.error(`[ERROR] [Renderer] ${message}${where}`);
  });

  contents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isInternalPageUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });

contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isDirWritable(dir) {
  return ensureDirUsable(dir);
}

function dirHasData(dir) {

  return fs.existsSync(path.join(dir, 'items'))
    || fs.existsSync(path.join(dir, 'notes'))
    || fs.existsSync(path.join(dir, 'todos'))
    || fs.existsSync(path.join(dir, 'config.json'));
}

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

  migrateApiKeyFromConfig(path.join(target, 'config.json'));
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

ipcMain.handle('window:ui-scale', (event, scale) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const size = scaleMinWindowSize(Number(scale));
  win.setMinimumSize(size.width, size.height);
});

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

ipcMain.handle('system:get-accent-color', () => {
  return getSystemAccentColor();
});

ipcMain.on('system:get-accent-color-sync', (event) => {
  event.returnValue = getSystemAccentColor();
});

ipcMain.handle('notes:pick-import', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const parent = win && !win.isDestroyed() ? win : null;
  const options = {
    title: '选择要导入的 Markdown 或文本文件',
    buttonLabel: '导入',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown 与文本文件', extensions: ['md', 'markdown', 'txt'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return { canceled: true, paths: [] };
  return { canceled: false, paths: result.filePaths };
});

ipcMain.handle('assets:pick-files', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const parent = win && !win.isDestroyed() ? win : null;
  const options = {
    title: '选择要插入到文档的文件',
    buttonLabel: '插入',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '常见媒体与文件',
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'txt', 'md']
      },
      { name: '所有文件', extensions: ['*'] }
    ]
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return { canceled: true, paths: [] };
  return { canceled: false, paths: result.filePaths };
});

ipcMain.handle('assets:open-file', async (event, payload) => {
  const relative = typeof payload === 'string' ? payload : (payload && payload.path);
  const itemId = payload && payload.itemId;
  if (!relative || typeof relative !== 'string') return { ok: false, error: '无效路径' };

  let fullPath;
  if (itemId && typeof itemId === 'string') {
    fullPath = path.join(resolveDataDir(), 'items', itemId, relative);
  } else {
    fullPath = path.join(resolveDataDir(), relative);
  }
  if (!fs.existsSync(fullPath)) return { ok: false, error: '文件不存在' };
  try {
    const errorMsg = await shell.openPath(fullPath);
    if (errorMsg) return { ok: false, error: errorMsg };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('fm:save-file', async (event, payload) => {
  const itemId = payload && payload.itemId;
  const filename = payload && payload.filename;
  if (!itemId || !filename || typeof itemId !== 'string' || typeof filename !== 'string') {
    return { ok: false, error: '参数无效' };
  }
  const sourcePath = path.join(resolveDataDir(), 'items', itemId, filename);
  if (!fs.existsSync(sourcePath)) return { ok: false, error: '文件不存在' };

  const win = BrowserWindow.fromWebContents(event.sender);
  const parent = win && !win.isDestroyed() ? win : null;

  const result = await dialog.showSaveDialog(parent || undefined, {
    title: '另存为',
    defaultPath: filename,
    buttonLabel: '保存'
  });
  if (result.canceled || !result.filePath) return { ok: false, error: '' };

  try {
    fs.copyFileSync(sourcePath, result.filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('fm:open-folder', async (event, payload) => {
  const itemId = payload && payload.itemId;
  if (!itemId || typeof itemId !== 'string') {
    return { ok: false, error: '参数无效' };
  }
  const dir = path.join(resolveDataDir(), 'items', itemId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const errorMsg = await shell.openPath(dir);
    return { ok: !errorMsg, error: errorMsg || '' };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.on('data:get-dir-sync', (event) => {
  event.returnValue = resolveDataDir();
});

ipcMain.handle('data:get-dir', () => {
  const current = resolveDataDir();
  const defaultDir = getDefaultDataDir(APP_ROOT, app);
  return {
    dataDir: current,
    defaultDir,

    isCustom: !IS_DEV_RUN && !isSamePath(current, defaultDir),
    isDefault: isSamePath(current, defaultDir),
    isDevRun: IS_DEV_RUN,

    isPortableRun: IS_PORTABLE_DATA_RUN,

    locationFile: getLocationFile(app) || ''
  };
});

async function askReselectDataDir(owner, message, detail) {
  const choice = await showDialogWindow(owner, {
    type: 'error',
    title: '数据存放位置',
    message,
    detail,
    width: 480,
    buttons: [
      { id: 'reselect', label: '重新选择路径', variant: 'primary' },
      { id: 'close', label: '关闭', cancel: true }
    ]
  });
  return choice.id === 'reselect';
}

async function chooseDataDirWithRetry(win) {
  while (true) {
    const picked = await pickDataDir(win, resolveDataDir());
    if (!picked) return { canceled: true };

    const result = await applyDataDirChange(picked, win);
    if (!result.error) return result;
    if (!await askReselectDataDir(win, '无法使用所选位置', result.error)) return { canceled: true };
  }
}

ipcMain.handle('data:choose-dir', async (event) => {
  if (IS_DEV_RUN) return { canceled: false, error: DATA_DIR_LOCKED_MESSAGE };
  return chooseDataDirWithRetry(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.handle('data:reset-dir', async (event) => {
  if (IS_DEV_RUN) return { canceled: false, error: DATA_DIR_LOCKED_MESSAGE };
  const win = BrowserWindow.fromWebContents(event.sender);
  const target = getDefaultDataDir(APP_ROOT, app);
  const result = await applyDataDirChange(target, win, { persist: false, targetLabel: '默认位置' });
  if (!result || result.canceled) return result || { canceled: true };

  if (!result.error) {
    writeStoredDataDir(null, app);
    dataDir = target;
    return { ...result, isCustom: false };
  }

  if (!await askReselectDataDir(win, '无法恢复默认位置', result.error)) return { canceled: true };
  return chooseDataDirWithRetry(win);
});

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

const EXTERNAL_LINKS = {

  serverRepo: 'https://github.com/EsprinProject/Sync'
};

ipcMain.handle('app:open-external', (event, key) => {
  const url = EXTERNAL_LINKS[String(key || '')];
  if (!url) return false;
  openExternalUrl(url);
  return true;
});

const WINDOW_MIN_WIDTH = 800;
const WINDOW_MIN_HEIGHT = 600;

function resolveUiScale() {
  const raw = Number(readUserConfig().uiScale);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(Math.max(raw, 0.5), 2);
}

function scaleMinWindowSize(scale) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    width: Math.round(WINDOW_MIN_WIDTH * factor),
    height: Math.round(WINDOW_MIN_HEIGHT * factor)
  };
}

function dataDirBlockerDialog(blocker) {
  const recordDir = blocker.kind === 'recorded-dir';
  const message = blocker.kind === 'portable-dir'
    ? '便携版所在目录不可写'
    : (recordDir ? '便携版的数据位置不可用' : '便携版的数据目录不可写');

  const detail = [];
  if (blocker.kind === 'portable-dir') {
    detail.push('便携版把笔记、待办与设置都保存在程序所在的目录里，位置记录与 AI 密钥也放在这里。');
    detail.push('该目录当前无法写入，应用因此没有启动——免得把数据写到别处，让你在便携版目录里找不到它。');
  } else if (recordDir) {
    detail.push('便携版的数据位置记录指向的目录当前无法写入，应用因此没有启动。');
    detail.push('不会自动改用其他位置：换成空目录启动，看上去就像笔记全都不见了。');
  } else {
    detail.push('便携版把笔记、待办与设置都保存在程序所在目录下的 data/ 里。');
    detail.push('该目录当前无法创建或写入，应用因此没有启动。');
  }

  detail.push('');
  detail.push(`程序目录：${blocker.dir}`);
  detail.push(recordDir ? `记录的位置：${blocker.dataDir}` : `数据目录：${blocker.dataDir}`);
  if (recordDir && blocker.recordFile) detail.push(`位置记录：${blocker.recordFile}`);
  detail.push('');

  if (recordDir) {
    detail.push('请先确认该位置（移动硬盘、网络共享等）已连接且可写，再重新启动；');
    detail.push('也可以点「重新选择路径」另挑一个目录，选好后应用会直接启动。');
  } else if (blocker.kind === 'data-dir') {
    detail.push('请检查该目录是否被只读设置或同名文件占用，再重新启动；');
    detail.push('也可以点「重新选择路径」把数据改放到别处，选好后应用会直接启动。');
  } else {
    detail.push('请把便携版移到可写的位置（例如文档目录、移动硬盘），或解除该目录的只读 / 权限限制后重新启动；');
    detail.push('也可以点「重新选择路径」先把数据放到别处继续使用——程序目录不可写，这个选择不会被记住。');
  }

  return { message, detail: detail.join('\n') };
}

async function pickDataDir(owner, current) {
  const parent = owner && !owner.isDestroyed() ? owner : null;

  while (true) {
    const options = {
      title: '选择数据存放位置',
      defaultPath: current,
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory']
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;

    const picked = path.resolve(result.filePaths[0]);
    if (isDirWritable(picked)) return picked;

if (!await askReselectDataDir(parent, '所选目录不可写', `请检查该目录的访问权限，或换一个位置。\n位置：${picked}`)) {
      return null;
    }
  }
}

async function resolveStartupBlock(blocker) {

dataDir = blocker.dataDir;

  while (true) {
    const choice = await showDialogWindow(null, {
      type: blocker.kind === 'portable-dir' ? 'error' : 'warning',
      title: '无法启动',
      ...dataDirBlockerDialog(blocker),
      width: 480,
      buttons: [
        { id: 'reselect', label: '重新选择路径', variant: 'primary' },
        { id: 'quit', label: '退出', cancel: true }
      ]
    });

    if (choice.id !== 'reselect') return null;

    const picked = await pickDataDir(null, blocker.dataDir);
    if (!picked) continue;

if (writeStoredDataDir(picked, app)) {
      console.log('[Esprin Nemo] 数据位置已改为:', picked);
      return picked;
    }

    if (blocker.kind === 'portable-dir') {

      console.warn('[Esprin Nemo] 程序目录不可写，本次运行临时使用数据位置:', picked);
      return picked;
    }

console.error('[Esprin Nemo] 位置记录写入失败，新的数据位置无法保存:', picked);
    blocker = { ...blocker, kind: 'portable-dir', reason: '位置记录无法写入', dataDir: picked };
  }
}

function abortStartup(blocker) {
  console.error('[Esprin Nemo] 便携版启动失败:', blocker.reason, blocker.dir);

  if (!dataDir) dataDir = blocker.dataDir;

isQuitting = true;

  app.quit();
}

const REVEAL_DELAY = 90;
const REVEAL_FALLBACK_MS = 2500;

function applyBackdropViaNativeApi(win) {
  try {
    win.setBackgroundMaterial('mica');
    console.log('[Esprin Nemo] setBackgroundMaterial → mica');
    return true;
  } catch (e) {
    console.error('[Esprin Nemo] setBackgroundMaterial 失败:', e.message);
    return false;
  }
}

function createWindow() {
  Menu.setApplicationMenu(null);

  const currentDataDir = resolveDataDir();

  const appearance = buildWindowAppearance({
    theme: resolveEffectiveTheme(),
    style: resolveThemeStyle(),
    radius: resolveCornerRadius(),
    accent: resolveAccentColor(),
    brandColor: resolveBrandColor(),
    fonts: resolveWindowFonts()
  });

  const initialBg = appearance.backgroundColor;

  const minSize = scaleMinWindowSize(resolveUiScale());

  const MICA_ARG = '--esprin-nemo-mica';
  let backdropEnabled = false;
  let winBuild = 0;
  if (process.platform === 'win32') {
    try {
      const release = os.release();
      winBuild = parseInt(release.split('.').pop(), 10);
      backdropEnabled = winBuild >= 22000;
    } catch (e) {  }
    console.log(`[Esprin Nemo] Backdrop 检测: Build=${winBuild} Eligible=${backdropEnabled}`);
  }

  const additionalArgs = [...appearance.args];
  if (IS_PORTABLE_RUN) additionalArgs.push(PORTABLE_ARG);
  additionalArgs.push(`${DATA_DIR_ARG}${currentDataDir}`);
  if (backdropEnabled) additionalArgs.push(MICA_ARG);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: minSize.width,
    minHeight: minSize.height,
    frame: false,
    show: false,
    autoHideMenuBar: true,
    icon: APP_ICON_PATH,
    backgroundColor: backdropEnabled ? '#00000000' : initialBg,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      additionalArguments: additionalArgs
    }
  });

  let revealed = false;
  let backdropTried = false;
  const reveal = (reason) => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    if (reason !== 'ready-to-show') {
      console.warn(`[Esprin Nemo] ready-to-show 没有来到，已按「${reason}」显示主窗口`);
    }

if (backdropEnabled && !backdropTried) {
      backdropTried = true;
      if (!applyBackdropViaNativeApi(win)) {
        win.webContents.executeJavaScript(
          'document.documentElement.classList.remove("mica");' +
          'document.documentElement.style.backgroundColor="";'
        ).catch(() => {});
        console.error('[Esprin Nemo] vibedwm 失败，body 回退不透明');
      }
    }

    win.show();
  };
  win.once('ready-to-show', () => reveal('ready-to-show'));

  win.webContents.once('did-finish-load', () => setTimeout(() => reveal('did-finish-load'), REVEAL_DELAY));

  const revealTimer = setTimeout(() => reveal('超时'), REVEAL_FALLBACK_MS);
  win.once('closed', () => clearTimeout(revealTimer));

win.webContents.on('render-process-gone', (event, details) => {
    console.error('[Esprin Nemo] 主窗口渲染进程已退出:', details && details.reason);
  });

win.on('close', (event) => {
    if (isQuitting) return;
    if (!isTrayEnabled() && !isScratchpadWindowOpen() && !isStickyNoteOpen()) return;
    event.preventDefault();
    mainWindowClosed = true;
    win.hide();
  });

  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.on('enter-full-screen', () => {
    win.webContents.send('window:fullscreen-changed', true);
  });

  win.on('leave-full-screen', () => {
    win.webContents.send('window:fullscreen-changed', false);
  });

win.loadURL(pathToFileURL(path.join(APP_ROOT, 'src', 'renderer', 'main.html')).href);

  mainWindowClosed = false;
  mainWindow = win;
  return win;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {

  console.warn('[Esprin Nemo] 已有实例在运行（单实例锁被占用），本次启动已交给它，进程退出');
  app.exit(0);
}

let startupReady = false;

app.on('second-instance', (event, argv) => {

  if (isQuitting || startupBlocked) return;

  if (handleDesktopMenuArgv(argv)) return;

  if (!startupReady) return;

  showMainWindow();
});

function runStartupStep(label, run) {
  try {
    return run();
  } catch (error) {
    console.error(`[Esprin Nemo] 启动步骤「${label}」失败:`, error);
    return null;
  }
}

app.whenReady().then(async () => {

  if (!hasSingleInstanceLock) return;

const startupBlocker = getStartupBlocker(APP_ROOT, app);
  if (startupBlocker) {

    startupBlocked = true;

    registerDialogIpc();

    let pickedDir = null;
    try {
      pickedDir = await resolveStartupBlock(startupBlocker);
    } catch (error) {

      console.error('[Esprin Nemo] 显示启动失败弹窗失败:', error);
      dialog.showErrorBox('Esprin Nemo 无法启动', `${startupBlocker.reason}：\n${startupBlocker.dataDir}`);
    }

    if (!pickedDir) {
      abortStartup(startupBlocker);
      return;
    }

    dataDir = pickedDir;
    startupBlocked = false;
  }

const ALLOWED_PERMISSIONS = new Set(['local-fonts']);
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      return ALLOWED_PERMISSIONS.has(permission);
    });
  } catch (error) {
    console.error('[Esprin Nemo] 注册字体权限处理器失败:', error);
  }

registerDialogIpc();

registerScratchpadIpc();

registerStickyNotesIpc();

registerTrayIpc();
  setupTray();

runStartupStep('开机自启', () => {

    registerAutoLaunchIpc();
    configureAutoLaunch({ getConfig: readUserConfig });
  });

  runStartupStep('API Key 迁移', () => {

adoptLegacyKeyFile();

migrateApiKeyFromConfig(path.join(resolveDataDir(), 'config.json'));
  });

runStartupStep('AI 助手', () => registerAiIpc());

runStartupStep('系统语音识别', () => registerSpeechIpc());

runStartupStep('自建同步', () => registerSyncIpc());

runStartupStep('自建同步自动同步', () => applyAutoSyncRuntime());

runStartupStep('界面默认值', () => registerUiDefaults());

if (!IS_PORTABLE_RUN) runStartupStep('应用更新', () => registerUpdateIpc());

runStartupStep('启动信息', () => {
    const flavor = IS_PORTABLE_DATA_RUN ? '便携版' : (IS_DEV_RUN ? '开发运行' : '安装版');
    const platform = process.platform === 'linux' ? 'Linux' : (process.platform === 'win32' ? 'Windows' : process.platform);
    console.log(`[INFO] [Nemo] 启动：${flavor}·${platform}，数据目录 ${resolveDataDir()}`);
  });

  try {
    const { systemPreferences } = require('electron');
    if (typeof systemPreferences.on === 'function') {
      systemPreferences.on('accent-color-changed', (event, newColor) => {
        const hex = normalizeAccentHex(newColor) || getSystemAccentColor();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('system:accent-color-changed', hex);
        }
      });
    }
  } catch (e) {}

try {
    createWindow();
  } catch (error) {
    console.error('[Esprin Nemo] 创建主窗口失败:', error);
    dialog.showErrorBox('Esprin Nemo 无法打开窗口', `创建主窗口时出错：\n${(error && error.message) || error}`);
    app.exit(1);
    return;
  }
  startupReady = true;

if (process.platform === 'win32') {
  runStartupStep('桌面便利贴', () => restoreStickyNotes());

  runStartupStep('桌面右键菜单', () => {
    registerDesktopMenu();
    handleDesktopMenuArgv(process.argv);
  });
}

  if (!IS_PORTABLE_RUN) scheduleAutoChecks();
});

app.on('before-quit', () => {
  isQuitting = true;

  disposeSpeechWindows();

disposeDesktopLayer();
  releaseStickyNotes();
});

app.on('will-quit', () => {
  unregisterDesktopMenu();
});

app.on('window-all-closed', () => {

  if (isTrayEnabled()) return;
  app.quit();
});