// 开机自启：把应用登记到系统的登录启动项（Windows 为注册表 Run 项、macOS 为登录项、
// Linux 为 ~/.config/autostart 下的 .desktop），登录系统后自动在后台启动。
//
// 是否开启以 config.json 的 autoLaunch 为准（默认关闭，只有显式写成 true 才算开启），
// 设置页的开关（见 src/renderer/scripts/auto_launch.js）负责写配置，
// 本模块只负责读写系统启动项本身，因此配置与系统状态始终一一对应。
//
// 开发运行（bun start）不登记：那时进程是 electron.exe，登记出来的启动项指向调试运行，
// 卸载源码后还会在系统里留下一条永远启动失败的记录。
const { app, ipcMain } = require('electron');

let ipcRegistered = false;

// 由 main.js 注入：读取用户配置（config.json）
let readUserConfig = () => ({});

// 能否管理系统启动项：只有打包后的应用才有稳定的可执行文件
function isSupported() {
  return app.isPackaged;
}

// 便携版 / AppImage 每次启动都会先解压到临时目录，登记 process.execPath 会在重启后失效，
// 因此优先登记用户实际双击的那个文件（electron-builder 会写入对应的环境变量）。
function launchPath() {
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) {
    return process.env.PORTABLE_EXECUTABLE_FILE;
  }
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    return process.env.APPIMAGE;
  }
  return process.execPath;
}

/* 读写启动项时都带上同一组定位参数：Windows 下启动项按「路径 + 参数」记录，
   只带 openAtLogin 去读会读到默认路径（安装目录）而不是便携版那条，导致开关状态失真。 */
function launchOptions() {
  if (process.platform !== 'win32') return null;
  return { path: launchPath(), args: [] };
}

// 系统启动项的当前状态（读不到一律按未开启处理）
function readActual() {
  const options = launchOptions();
  try {
    const settings = options ? app.getLoginItemSettings(options) : app.getLoginItemSettings();
    return !!(settings && settings.openAtLogin);
  } catch (error) {
    console.error('[Esprin Nemo] 读取开机自启状态失败:', error);
    return false;
  }
}

// 配置中的开机自启（默认关闭，读取失败也按关闭处理）
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

// 写系统启动项，并回读一次作为最终状态：写不进去时不谎报成功，设置页因此不会显示成已开启
function applyAutoLaunch(enabled) {
  if (!isSupported()) {
    return { supported: false, enabled: false, error: '当前为开发运行，无法设置开机自启' };
  }

  const options = launchOptions();
  try {
    const settings = options ? { openAtLogin: !!enabled, ...options } : { openAtLogin: !!enabled };
    app.setLoginItemSettings(settings);
  } catch (error) {
    console.error('[Esprin Nemo] 设置开机自启失败:', error);
    return { supported: true, enabled: readActual(), error: describeError(error) };
  }

  return { supported: true, enabled: readActual(), error: '' };
}

// 启动时按配置落定启动项；配置与系统状态一致时不做多余的注册表写入
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

  // 设置页打开时查询：supported 为 false 时界面把开关置灰并说明原因
  ipcMain.handle('app:get-auto-launch', () => ({
    supported: isSupported(),
    enabled: readActual(),
    error: ''
  }));

  // 设置页切换开关：config.json 由渲染进程写，这里只负责系统启动项的增删
  ipcMain.handle('app:set-auto-launch', (event, payload) => {
    return applyAutoLaunch(!!(payload && payload.enabled));
  });
}

module.exports = {
  configureAutoLaunch,
  registerAutoLaunchIpc
};
