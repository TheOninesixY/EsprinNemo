const { ipcMain } = require('electron');

const ARG_PREFIX = '--esprin-nemo-window-controls=';

function isMacPlatform() {
  return process.platform === 'darwin';
}

function normalizeWindowControls(value) {
  if (!isMacPlatform()) return 'windows';
  return value === 'windows' ? 'windows' : 'mac';
}

function normalizeScale(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.min(Math.max(num, 0.5), 2) : 1;
}

function trafficLightPosition(scale) {
  const factor = normalizeScale(scale);
  return {
    x: Math.round(16 * factor),
    y: Math.round(20 * factor - 6)
  };
}

let controlStyle = normalizeWindowControls('');

let trafficLightScale = 1;

let getMainWindow = () => null;

let ipcRegistered = false;

function configureWindowControls({ getWindow } = {}) {
  if (typeof getWindow === 'function') getMainWindow = getWindow;
}

function getWindowControlStyle() {
  return controlStyle;
}

function windowControlsArg() {
  return `${ARG_PREFIX}${controlStyle}`;
}

function usesNativeTrafficLights() {
  return isMacPlatform() && controlStyle === 'mac';
}

function windowControlsSnapshot() {
  return {
    style: controlStyle,
    native: usesNativeTrafficLights(),
    mac: isMacPlatform()
  };
}

function sendWindowControls(win) {
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send('window:controls-changed', windowControlsSnapshot());
}

function applyTrafficLightPosition(win) {
  if (!isMacPlatform() || !win || win.isDestroyed()) return;
  if (!usesNativeTrafficLights()) return;
  try {
    if (typeof win.setWindowButtonPosition === 'function') {
      win.setWindowButtonPosition(trafficLightPosition(trafficLightScale));
    }
  } catch (error) {
    console.warn('[Desktop:WARN] 设置 macOS 红绿灯位置失败:', error.message);
  }
}

function applyWindowControlStyle(win) {
  if (!win || win.isDestroyed()) return;
  if (isMacPlatform()) {
    try {
      if (typeof win.setWindowButtonVisibility === 'function') {
        win.setWindowButtonVisibility(usesNativeTrafficLights());
      }
    } catch (error) {
      console.warn('[Desktop:WARN] 设置 macOS 窗口按钮失败:', error.message);
    }
    applyTrafficLightPosition(win);
  }
  sendWindowControls(win);
}

function setTrafficLightScale(value) {
  trafficLightScale = normalizeScale(value);
  applyTrafficLightPosition(getMainWindow());
}

function setWindowControlStyle(value) {
  const next = normalizeWindowControls(value);
  if (next === controlStyle) return windowControlsSnapshot();
  controlStyle = next;
  applyWindowControlStyle(getMainWindow());
  console.log(`[Desktop:INFO] 窗口控件已切换为 ${controlStyle === 'mac' ? 'macOS 红绿灯' : 'Windows 样式'}`);
  return windowControlsSnapshot();
}

function registerWindowControlsIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('window:get-controls', () => windowControlsSnapshot());

  ipcMain.on('window:get-controls-sync', (event) => {
    event.returnValue = windowControlsSnapshot();
  });

  ipcMain.handle('window:set-controls', (event, value) => setWindowControlStyle(value));
}

module.exports = {
  ARG_PREFIX,
  applyWindowControlStyle,
  configureWindowControls,
  getWindowControlStyle,
  normalizeWindowControls,
  registerWindowControlsIpc,
  setTrafficLightScale,
  setWindowControlStyle,
  trafficLightPosition,
  usesNativeTrafficLights,
  windowControlsArg,
  windowControlsSnapshot
};
