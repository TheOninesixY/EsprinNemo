const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AUTOSTART_FILE_NAME = 'esprin_nemo.desktop';

let ipcRegistered = false;

let readUserConfig = () => ({});

function isLinuxPlatform() {
  return process.platform === 'linux';
}

function isSupported() {
  return app.isPackaged;
}

function autostartDir() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const base = typeof xdgConfigHome === 'string' && xdgConfigHome.trim() && path.isAbsolute(xdgConfigHome.trim())
    ? path.resolve(xdgConfigHome.trim())
    : path.join(os.homedir(), '.config');
  return path.join(base, 'autostart');
}

function autostartFile() {
  return path.join(autostartDir(), AUTOSTART_FILE_NAME);
}

function launchPath() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return process.env.PORTABLE_EXECUTABLE_FILE;
  }
  if (isLinuxPlatform()) {
    const appImage = process.env.APPIMAGE;
    if (typeof appImage === 'string' && appImage.trim()) return appImage.trim();
    try {
      return app.getPath('exe');
    } catch (error) {
      return process.execPath;
    }
  }
  return process.execPath;
}

function launchOptions() {
  return { path: launchPath(), args: [] };
}

function quoteExec(target) {
  const value = String(target || '').replace(/["\\]/g, '');
  return /\s/.test(value) ? `"${value}"` : value;
}

function autostartEntry() {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Esprin Nemo',
    'Comment=Note, Nothing.',
    `Exec=${quoteExec(launchPath())}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

function readLinuxActual() {
  try {
    return fs.existsSync(autostartFile());
  } catch (error) {
    return false;
  }
}

function applyLinuxAutoStart(enabled) {
  const file = autostartFile();
  try {
    if (enabled) {
      fs.mkdirSync(autostartDir(), { recursive: true });
      fs.writeFileSync(file, autostartEntry(), 'utf8');
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    return { supported: true, enabled: readLinuxActual(), error: '' };
  } catch (error) {
    console.error('[ERROR] [Nemo] 写入开机自启文件失败:', error);
    return { supported: true, enabled: readLinuxActual(), error: describeError(error) };
  }
}

function readActual() {
  if (isLinuxPlatform()) return readLinuxActual();
  try {
    const settings = app.getLoginItemSettings(launchOptions());
    return !!(settings && settings.openAtLogin);
  } catch (error) {
    console.error('[Esprin Nemo] 读取开机自启状态失败:', error);
    return false;
  }
}

function readConfigured() {
  try {
    const config = readUserConfig();
    if (config && typeof config === 'object') return config.autoLaunch === true;
  } catch (error) {
    console.error('[Esprin Nemo] 读取开机自启设置失败:', error);
  }
  return false;
}

function describeError(error) {
  const message = error && error.message ? String(error.message) : '';
  return message ? `设置开机自启失败：${message}` : '设置开机自启失败';
}

function applyAutoLaunch(enabled) {
  if (!isSupported()) {
    return { supported: false, enabled: false, error: '当前为开发运行，无法设置开机自启' };
  }

  if (isLinuxPlatform()) return applyLinuxAutoStart(!!enabled);

  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, ...launchOptions() });
  } catch (error) {
    console.error('[Esprin Nemo] 设置开机自启失败:', error);
    return { supported: true, enabled: readActual(), error: describeError(error) };
  }

  return { supported: true, enabled: readActual(), error: '' };
}

function configureAutoLaunch({ getConfig } = {}) {
  if (typeof getConfig === 'function') readUserConfig = getConfig;
  if (!isSupported()) return;

  const wanted = readConfigured();
  if (wanted === readActual()) return;
  applyAutoLaunch(wanted);
}

function registerAutoLaunchIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

ipcMain.handle('app:get-auto-launch', () => ({
    supported: isSupported(),
    enabled: readActual(),
    error: ''
  }));

ipcMain.handle('app:set-auto-launch', (event, payload) => {
    return applyAutoLaunch(!!(payload && payload.enabled));
  });
}

module.exports = {
  configureAutoLaunch,
  registerAutoLaunchIpc
};
