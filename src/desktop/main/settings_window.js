const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildWindowAppearance, safeResolve } = require('./window_appearance.js');
const { applyWindowControlStyle, trafficLightPosition, windowControlsArg } = require('./window_controls.js');

const MAIN_HTML = path.join(__dirname, '..', 'renderer', 'main.html');

const SETTINGS_WINDOW_ARG = '--esprin-nemo-settings-window';

const SETTINGS_CATEGORY_ARG = '--esprin-nemo-settings-category=';

const IS_MAC = process.platform === 'darwin';

const WINDOW_WIDTH = 960;
const WINDOW_HEIGHT = 720;
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

let settingsWin = null;

let resolveTheme = () => 'dark';
let resolveAccent = () => '';
let resolveRadius = () => 'default';
let resolveFonts = () => ({});
let resolveUiScale = () => 1;
let resolveBackgroundBlur = () => true;
let getOwnerWindow = () => null;
let iconPath = path.join(__dirname, '..', '..', require('../../../package.json').icon);

let handleWindowClosed = () => {};
let ipcRegistered = false;

function configureSettingsWindow(options = {}) {
  if (typeof options.getTheme === 'function') resolveTheme = options.getTheme;
  if (typeof options.getAccent === 'function') resolveAccent = options.getAccent;
  if (typeof options.getRadius === 'function') resolveRadius = options.getRadius;
  if (typeof options.getFonts === 'function') resolveFonts = options.getFonts;
  if (typeof options.getUiScale === 'function') resolveUiScale = options.getUiScale;
  if (typeof options.getBackgroundBlur === 'function') resolveBackgroundBlur = options.getBackgroundBlur;
  if (typeof options.getOwner === 'function') getOwnerWindow = options.getOwner;
  if (typeof options.icon === 'string' && options.icon) iconPath = options.icon;
  if (typeof options.onClosed === 'function') handleWindowClosed = options.onClosed;
}

function currentAppearance() {
  return buildWindowAppearance({
    theme: safeResolve(resolveTheme, 'dark', '主题'),
    accent: safeResolve(resolveAccent, '', '主题色'),
    radius: safeResolve(resolveRadius, 'default', '圆角尺度'),
    fonts: safeResolve(resolveFonts, {}, '字体')
  });
}

function mainWindowContents() {
  return BrowserWindow.getAllWindows().filter((win) => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
    return win.webContents.getURL().includes('main.html');
  });
}

function sendToContents(contents, channel, payload) {
  if (!contents || contents.isDestroyed()) return;
  if (contents.isLoadingMainFrame() || !contents.getURL()) {
    contents.once('did-finish-load', () => {
      if (!contents.isDestroyed()) contents.send(channel, payload);
    });
    return;
  }
  contents.send(channel, payload);
}

function broadcast(channel, payload, senderId) {
  mainWindowContents().forEach((win) => {
    if (senderId && win.webContents.id === senderId) return;
    sendToContents(win.webContents, channel, payload);
  });
}

function centerOver(win, owner) {
  if (!owner || owner.isDestroyed()) {
    win.center();
    return;
  }
  const ownerBounds = owner.getBounds();
  const bounds = win.getBounds();
  win.setPosition(
    Math.round(ownerBounds.x + (ownerBounds.width - bounds.width) / 2),
    Math.round(ownerBounds.y + (ownerBounds.height - bounds.height) / 2)
  );
}

function clampBounds(win) {
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = win.getBounds();
  if (area.width >= bounds.width && area.height >= bounds.height) return;
  win.setSize(
    Math.min(bounds.width, area.width),
    Math.min(bounds.height, area.height)
  );
}

function createSettingsWindow(category) {
  const appearance = currentAppearance();
  const scale = Math.min(Math.max(Number(resolveUiScale()) || 1, 0.5), 2);
  const additionalArgs = [...appearance.args, windowControlsArg(), SETTINGS_WINDOW_ARG];
  if (typeof category === 'string' && category) {
    additionalArgs.push(`${SETTINGS_CATEGORY_ARG}${category}`);
  }

  const windowOptions = {
    width: Math.round(WINDOW_WIDTH * scale),
    height: Math.round(WINDOW_HEIGHT * scale),
    minWidth: Math.round(MIN_WIDTH * scale),
    minHeight: Math.round(MIN_HEIGHT * scale),
    show: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: '设置',
    backgroundColor: appearance.backgroundColor,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      additionalArguments: additionalArgs
    }
  };

  if (IS_MAC) {
    windowOptions.titleBarStyle = 'hidden';
    windowOptions.trafficLightPosition = trafficLightPosition(resolveUiScale());
    if (resolveBackgroundBlur()) {
      windowOptions.vibrancy = 'under-window';
      windowOptions.visualEffectState = 'active';
      windowOptions.backgroundColor = 'rgba(0, 0, 0, 0)';
    }
  } else {
    windowOptions.frame = false;
  }

  const win = new BrowserWindow(windowOptions);

  settingsWin = win;

  applyWindowControlStyle(win);
  clampBounds(win);
  centerOver(win, getOwnerWindow());

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.once('closed', () => {
    if (settingsWin === win) settingsWin = null;
    broadcast('settings:window-closed');
    handleWindowClosed();
  });

  win.webContents.on('render-process-gone', (event, details) => {
    console.error('[Desktop:ERROR] 设置窗口渲染进程已退出:', details && details.reason);
  });

  win.loadURL(pathToFileURL(MAIN_HTML).href).catch((error) => {
    console.error('[Desktop:ERROR] 加载设置窗口失败:', error);
    if (!win.isDestroyed()) win.destroy();
  });

  console.log('[Desktop:INFO] 设置窗口已打开。');
  return win;
}

function openSettingsWindow(category) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (typeof category === 'string' && category) {
      sendToContents(settingsWin.webContents, 'settings:category', category);
    }
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return false;
  }
  createSettingsWindow(category);
  return true;
}

function isSettingsWindowOpen() {
  return !!(settingsWin && !settingsWin.isDestroyed());
}

function hideSettingsWindow() {
  if (!isSettingsWindowOpen() || !settingsWin.isVisible()) return;
  settingsWin.hide();
}

function closeSettingsWindow() {
  if (!isSettingsWindowOpen()) return;
  settingsWin.close();
}

function registerSettingsIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('settings:open', (event, payload) => {
    const category = payload && typeof payload.category === 'string' ? payload.category : '';
    return openSettingsWindow(category);
  });

  ipcMain.on('settings:config-changed', (event, payload) => {
    const config = payload && payload.config && typeof payload.config === 'object' ? payload.config : null;
    if (!config) return;
    broadcast('settings:config-changed', config, event.sender.id);
  });

  ipcMain.on('settings:data-dir-changed', (event) => {
    broadcast('settings:data-dir-changed', null, event.sender.id);
  });

  ipcMain.on('settings:data-changed', (event) => {
    broadcast('settings:data-changed', null, event.sender.id);
  });

  ipcMain.on('settings:open-note', (event, noteId) => {
    if (typeof noteId !== 'string' || !noteId) return;
    const owner = getOwnerWindow();
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return;
    if (owner.isMinimized()) owner.restore();
    owner.show();
    owner.focus();
    const deliver = () => {
      if (!owner.webContents.isDestroyed()) owner.webContents.send('settings:open-note', noteId);
    };
    if (owner.webContents.isLoadingMainFrame() || !owner.webContents.getURL()) {
      owner.webContents.once('did-finish-load', deliver);
      return;
    }
    deliver();
  });
}

module.exports = {
  closeSettingsWindow,
  configureSettingsWindow,
  hideSettingsWindow,
  isSettingsWindowOpen,
  openSettingsWindow,
  registerSettingsIpc
};
