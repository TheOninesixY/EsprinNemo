// 系统托盘：把「小本本 / 新建笔记 / 新建待办 / 设置」等常用入口固定到任务栏通知区域。
// 是否显示托盘图标由 config.json 的 trayEnabled 决定（默认开启），
// 可在「设置 → 系统与托盘」里随时关闭或重新打开。
//
// 托盘图标在时，应用不再随窗口关闭而退出：关闭窗口只是把界面收起来
// （关闭拦截在 main.js 里，凭 isTrayEnabled() 决定去留），
// 因此托盘菜单里的「退出」就是此时唯一的退出入口。
//
// 与小本本窗口的分工：小本本与退出都在主进程内直接完成；
// 「新建笔记 / 新建待办 / 设置」需要渲染进程配合，先由主进程把主窗口叫回前台，
// 再把动作以 tray:action 投递给渲染进程执行（见 src/renderer/scripts/tray.js）。
const { app, Tray, Menu, nativeImage, ipcMain } = require('electron');

// 通知区域按 16px 左右显示图标：自己做一次缩放比交给系统拉伸更清晰
const ICON_SIZE = 16;
const TOOLTIP = 'Esprin Nemo';

// 托盘菜单里的动作标识：与渲染进程 scripts/tray.js 中的处理表一一对应
const ACTION_NEW_NOTE = 'new-note';
const ACTION_NEW_TODO = 'new-todo';
const ACTION_OPEN_SETTINGS = 'open-settings';

let tray = null;
// 托盘图标当前是否应该存在（设置项的真实状态；图标创建失败会退回 false）
let trayEnabled = false;
let ipcRegistered = false;

let getConfig = () => ({});
let getOwnerWindow = () => null;
let iconPath = '';
let onShowMainWindow = () => null;
let onOpenScratchpad = () => {};
let onQuit = () => {};
let onEnabledChanged = () => {};

// 由 main.js 注入配置读取、窗口获取与各入口动作（托盘本身不持有窗口与数据的知识）
function configureTray(options = {}) {
  if (typeof options.getConfig === 'function') getConfig = options.getConfig;
  if (typeof options.getOwner === 'function') getOwnerWindow = options.getOwner;
  if (typeof options.icon === 'string' && options.icon) iconPath = options.icon;
  if (typeof options.onShowMainWindow === 'function') onShowMainWindow = options.onShowMainWindow;
  if (typeof options.onOpenScratchpad === 'function') onOpenScratchpad = options.onOpenScratchpad;
  if (typeof options.onQuit === 'function') onQuit = options.onQuit;
  if (typeof options.onEnabledChanged === 'function') onEnabledChanged = options.onEnabledChanged;

  // 退出前销毁图标，避免通知区域留下一个点不动的幽灵图标
  app.on('will-quit', destroyTray);

  // 启动时按配置决定是否显示：只有显式写成 false 才算关闭
  trayEnabled = readConfiguredEnabled();
  applyEnabled(trayEnabled);
}

// 配置中的托盘开关：默认开启，读取失败也按开启处理
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

// 托盘图标：优先使用按通知区域尺寸缩放过的位图，取不到图时退回原图交给系统处理
function trayIcon() {
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return iconPath;
  return image.resize({ width: ICON_SIZE, height: ICON_SIZE });
}

// 右键菜单：打开主窗口 / 小本本 / 新建笔记 / 新建待办 / 设置 / 退出。
// 条目与界面布局无关：现代布局只是不排标题栏（标签栏移到工作区顶部），小本本照旧提供
function buildTrayMenu() {
  const template = [
    { label: '打开 Esprin Nemo', click: () => { onShowMainWindow(); } },
    { type: 'separator' },
    { label: '小本本', click: () => { onOpenScratchpad(); } },
    { label: '新建笔记', click: () => { sendAction(ACTION_NEW_NOTE); } },
    { label: '新建待办', click: () => { sendAction(ACTION_NEW_TODO); } },
    { label: '设置', click: () => { sendAction(ACTION_OPEN_SETTINGS); } },
    { type: 'separator' },
    { label: '退出', click: () => { onQuit(); } }
  ];

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
  // 左键单击直接唤回主窗口，右键才是菜单
  tray.on('click', () => { onShowMainWindow(); });
  return true;
}

function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (error) {
    // 图标可能已被系统回收，忽略
  }
  tray = null;
}

// 让托盘图标与目标状态保持一致：需要就创建，不需要就销毁。
// 返回最终是否真的显示着图标——创建失败时不谎报成功，设置页因此不会显示成已开启。
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

// 把托盘动作投递给主窗口渲染进程：先把窗口叫回前台；
// 页面还在首屏加载时等它加载完成再发（脚本尚未执行，消息提前到达会丢），
// 加载完成后投递即可命中 scripts/tray.js 里注册的监听。
function sendAction(action) {
  const win = onShowMainWindow() || getOwnerWindow();
  if (!win || win.isDestroyed()) return;

  const contents = win.webContents;
  if (contents.isDestroyed()) return;

  const deliver = () => {
    if (!contents.isDestroyed()) contents.send('tray:action', action);
  };

  // 新建出来的窗口尚未提交任何导航，getURL() 为空，与加载中一并当作「未就绪」
  if (contents.isLoadingMainFrame() || !contents.getURL()) {
    contents.once('did-finish-load', deliver);
    return;
  }
  deliver();
}

function registerTrayIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  // 设置页读取当前状态（托盘创建失败时这里会如实返回 false）
  ipcMain.handle('tray:get-state', () => ({ enabled: trayEnabled }));

  // 设置页切换开关：config.json 由渲染进程写，这里只负责图标本身的增删
  ipcMain.handle('tray:set-enabled', (event, payload) => {
    const enabled = !(payload && payload.enabled === false);
    if (enabled === trayEnabled) return { enabled: trayEnabled, error: '' };

    applyEnabled(enabled);
    // 关闭托盘后应用失去常驻入口，由 main.js 判断此时是否该直接退出
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
