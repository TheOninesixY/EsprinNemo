const { app, Tray, Menu, nativeImage, ipcMain } = require('electron');

const ICON_SIZE = 16;
const TOOLTIP = 'Esprin Nemo';

const ACTION_NEW_NOTE = 'new-note';
const ACTION_NEW_TODO = 'new-todo';
const ACTION_OPEN_SETTINGS = 'open-settings';

let tray = null;

let trayEnabled = false;
let ipcRegistered = false;

let getConfig = () => ({});
let getOwnerWindow = () => null;
let iconPath = '';
let onShowMainWindow = () => null;
let onOpenScratchpad = () => {};
let onNewStickyNote = () => {};
let onShowStickyNotes = () => 0;
let onHideStickyNotes = () => 0;
let onQuit = () => {};
let onEnabledChanged = () => {};

function configureTray(options = {}) {
  if (typeof options.getConfig === 'function') getConfig = options.getConfig;
  if (typeof options.getOwner === 'function') getOwnerWindow = options.getOwner;
  if (typeof options.icon === 'string' && options.icon) iconPath = options.icon;
  if (typeof options.onShowMainWindow === 'function') onShowMainWindow = options.onShowMainWindow;
  if (typeof options.onOpenScratchpad === 'function') onOpenScratchpad = options.onOpenScratchpad;
  if (typeof options.onNewStickyNote === 'function') onNewStickyNote = options.onNewStickyNote;
  if (typeof options.onShowStickyNotes === 'function') onShowStickyNotes = options.onShowStickyNotes;
  if (typeof options.onHideStickyNotes === 'function') onHideStickyNotes = options.onHideStickyNotes;
  if (typeof options.onQuit === 'function') onQuit = options.onQuit;
  if (typeof options.onEnabledChanged === 'function') onEnabledChanged = options.onEnabledChanged;

app.on('will-quit', destroyTray);

trayEnabled = readConfiguredEnabled();
  applyEnabled(trayEnabled);
}

function readConfiguredEnabled() {
  try {
    const config = getConfig();
    if (config && typeof config === 'object') return config.trayEnabled !== false;
  } catch (error) {
    console.error('[Esprin Nemo] 读取托盘设置失败:', error);
  }
  return true;
}

function isTrayEnabled() {
  return trayEnabled;
}

function trayIcon() {
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return iconPath;
  return image.resize({ width: ICON_SIZE, height: ICON_SIZE });
}

function buildTrayMenu() {
  const template = [
    { label: '打开 Esprin Nemo', click: () => { onShowMainWindow(); } },
    { type: 'separator' },
    { label: '小本本', click: () => { onOpenScratchpad(); } }
  ];

  if (process.platform === 'win32') {
    template.push({
      label: '桌面便利贴',
      submenu: [
        { label: '贴上便利贴', click: () => { sendAction('pick-sticky-note'); } },
        { label: '显示全部便利贴', click: () => { onShowStickyNotes(); } },
        { label: '收起全部便利贴', click: () => { onHideStickyNotes(); } }
      ]
    });
  }

  template.push(
    { label: '新建笔记', click: () => { sendAction(ACTION_NEW_NOTE); } },
    { label: '新建待办', click: () => { sendAction(ACTION_NEW_TODO); } },
    { label: '设置', click: () => { sendAction(ACTION_OPEN_SETTINGS); } },
    { type: 'separator' },
    { label: '退出', click: () => { onQuit(); } }
  );

  return Menu.buildFromTemplate(template);
}

function createTray() {
  if (tray) return true;
  try {
    tray = new Tray(trayIcon());
  } catch (error) {
    console.error('[Esprin Nemo] 创建托盘图标失败:', error);
    tray = null;
    return false;
  }

  tray.setToolTip(TOOLTIP);
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => { onShowMainWindow(); });
  return true;
}

function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (error) {

  }
  tray = null;
}

function applyEnabled(enabled) {
  const wanted = !!enabled;
  if (wanted) {
    if (!createTray()) {
      trayEnabled = false;
      return false;
    }
    trayEnabled = true;
    return true;
  }
  destroyTray();
  trayEnabled = false;
  return true;
}

function sendAction(action) {
  const win = onShowMainWindow() || getOwnerWindow();
  if (!win || win.isDestroyed()) return;

  const contents = win.webContents;
  if (contents.isDestroyed()) return;

  const deliver = () => {
    if (!contents.isDestroyed()) contents.send('tray:action', action);
  };

if (contents.isLoadingMainFrame() || !contents.getURL()) {
    contents.once('did-finish-load', deliver);
    return;
  }
  deliver();
}

function registerTrayIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

ipcMain.handle('tray:get-state', () => ({ enabled: trayEnabled }));

ipcMain.handle('tray:set-enabled', (event, payload) => {
    const enabled = !(payload && payload.enabled === false);
    if (enabled === trayEnabled) return { enabled: trayEnabled, error: '' };

    applyEnabled(enabled);

    onEnabledChanged(trayEnabled);
    return {
      enabled: trayEnabled,
      error: enabled && !trayEnabled ? '系统不允许显示托盘图标' : ''
    };
  });
}

module.exports = {
  configureTray,
  registerTrayIpc,
  isTrayEnabled
};
