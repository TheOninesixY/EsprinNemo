const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  DATA_DIR_ARG,
  ensureDataDir,
  getDefaultDataDir,
  isDevRun,
  writeStoredDataDir
} = require('./data_path.js');
const { listSystemFonts } = require('./font_list.js');
const { configureDialogWindows, registerDialogIpc, showDialogWindow } = require('./dialog_window.js');
const { configureScratchpadWindow, isScratchpadWindowOpen, openScratchpadWindow, registerScratchpadIpc } = require('./scratchpad_window.js');
const { configureTray, isTrayEnabled, registerTrayIpc } = require('./tray.js');
const { registerUiDefaults } = require('./ui_defaults.js');
const { configureAiService, registerAiIpc } = require('./ai_service.js');
const { migrateApiKeyFromConfig } = require('./ai_secret.js');
const { configureUpdater, registerUpdateIpc, scheduleAutoChecks } = require('./updater.js');

// 应用根目录：开发版是项目根目录，安装版是 app.asar 根。
// 本文件位于 src/main/ 下，因此 assets/、src/renderer/ 与开发版 data/ 都相对它定位。
const APP_ROOT = app.getAppPath();

// 安装版使用 %APPDATA%/esprin_nemo/data，开发运行（bun start → electron .）使用项目内 data/。
// 安装向导与“设置 → 数据存放位置”把选择写进 %APPDATA%/esprin_nemo/data_path.json，
// 该记录优先于默认位置；开发运行不读该记录，也不允许在设置中更改位置。
const IS_DEV_RUN = isDevRun(app);
const DATA_DIR_LOCKED_MESSAGE = '当前为开发运行（bun start），数据固定存放在项目内的 data/ 目录，无法更改数据存放位置。';

let dataDir = null;
function resolveDataDir() {
  if (!dataDir) {
    dataDir = ensureDataDir(APP_ROOT, app);
  }
  return dataDir;
}

// 读取用户配置（config.json）：主进程只关心主题与主题色两项，供主窗口背景与弹窗窗口复用
function readUserConfig() {
  try {
    const configFile = path.join(resolveDataDir(), 'config.json');
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config && typeof config === 'object') return config;
    }
  } catch (error) {
    console.error('[Esprin Nemo] 读取用户配置失败:', error);
  }
  return {};
}

// 把主题偏好折算为实际生效的明暗色
function resolveEffectiveTheme() {
  const theme = readUserConfig().theme || 'system';
  const isLight = theme === 'light' || (theme === 'system' && !nativeTheme.shouldUseDarkColors);
  return isLight ? 'light' : 'dark';
}

// 主题色（强调色）：统一为 #RRGGBB；未设置或格式非法时返回空字符串，弹窗沿用内置默认色
function resolveAccentColor() {
  const raw = readUserConfig().accentColor;
  if (typeof raw !== 'string') return '';
  const matched = raw.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!matched) return '';
  let hex = matched[1];
  if (hex.length === 3) hex = hex.split('').map((char) => char + char).join('');
  return `#${hex.toUpperCase()}`;
}

// 应用名文字颜色模式：brand（品牌色）/ mono（跟随明暗的黑白）/ accent（跟随主题色）
function resolveBrandColor() {
  const raw = readUserConfig().brandColor;
  return raw === 'mono' || raw === 'accent' ? raw : 'brand';
}

// 所有消息弹窗都在自绘标题栏的独立窗口中呈现，主题与当前界面保持一致
configureDialogWindows({
  getTheme: resolveEffectiveTheme,
  getAccent: resolveAccentColor,
  getBrandColor: resolveBrandColor,
  icon: path.join(APP_ROOT, 'assets', 'icon.png')
});

// 小本本（便利贴窗口）：右下角置顶小窗，内容随数据目录一起走
configureScratchpadWindow({
  getTheme: resolveEffectiveTheme,
  getAccent: resolveAccentColor,
  getDataDir: resolveDataDir,
  // 便利贴停靠在哪块屏幕右下角，取决于主窗口当前所在的显示器
  getOwner: () => mainWindow,
  icon: path.join(APP_ROOT, 'assets', 'icon.png'),
  // 便利贴关闭后：主窗口此前已被收起时，屏幕上再无窗口，应用也随之退出
  onClosed: handleScratchpadClosed
});

// AI 助手：站点与模型随数据目录存放，API Key 由系统密钥链单独保管；两者都只由主进程读取
configureAiService({ getDataDir: resolveDataDir });

// 应用更新：检查 / 下载 / 安装三段都在主进程完成（见 updater.js），
// 自动检查是否开启以 config.json 中的 autoUpdate 为准（默认开启）
configureUpdater({
  getConfig: readUserConfig,
  // 主窗口被收起时不给弹窗挂一个隐藏的父窗口，更新提示因此仍能正常显示
  getOwner: () => (mainWindowClosed ? null : mainWindow)
});

// 主窗口引用：小本本据此定位停靠屏幕
let mainWindow = null;
// 主窗口是否已被用户关闭（小本本还在运行时，主窗口只是收起，进程继续存活）
let mainWindowClosed = false;
// 应用是否正在退出（更新安装、或窗口都关掉了）：此时不再拦下主窗口的关闭
let isQuitting = false;

// 系统托盘的入口动作：托盘本身不持有窗口与数据的知识，全部由这里注入。
// 托盘图标在 app.whenReady 之后创建（Tray 必须等应用就绪），是否显示由 config.json 的
// trayEnabled 决定；托盘在时应用不再随窗口关闭而退出（见下面的关闭拦截与 handleScratchpadClosed）。
function setupTray() {
  configureTray({
    getConfig: readUserConfig,
    getOwner: () => mainWindow,
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    onShowMainWindow: showMainWindow,
    // 小本本与退出都在主进程内直接完成，不经过渲染进程
    onOpenScratchpad: () => { openScratchpadWindow(); },
    onQuit: () => { app.quit(); },
    // 关掉托盘后应用失去唯一的常驻入口：此时没有任何可见窗口就应当退出，
    // 否则进程会留在后台且再也唤不回来
    onEnabledChanged: (enabled) => { if (!enabled) quitIfNoVisibleWindow(); }
  });
}

// 把主窗口叫回前台：托盘菜单、托盘动作与「再次启动应用」都走这里。
// 主窗口确实不在了时重新创建一扇，同样不另起进程。
function showMainWindow() {
  if (isQuitting) return null;
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();

  mainWindowClosed = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

// 关闭托盘且屏幕上已无可见窗口（主窗口被收起、小本本也没开）时退出应用：
// 此时应用没有任何入口，继续驻留只会变成一个无法唤回的残留进程。
function quitIfNoVisibleWindow() {
  if (isQuitting || isTrayEnabled()) return;
  if (isScratchpadWindowOpen()) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindowClosed) return;
  app.quit();
}

// 小本本关闭后：托盘还在时应用继续驻留（图标就是入口）；
// 没有托盘时，主窗口此前已被收起就意味着屏幕上再没有窗口，应用随之退出。
function handleScratchpadClosed() {
  if (isQuitting) return;
  if (isTrayEnabled()) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindowClosed) return;
  app.quit();
}

function normalizePathForCompare(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

// 应用自身的界面文件（main.html / dialog.html / scratchpad.html）都位于 APP_ROOT 内，
// 只有这些 file:// 页面允许作为渲染进程的停留目标。
function isInternalPageUrl(targetUrl) {
  try {
    const parsed = new URL(String(targetUrl));
    if (parsed.protocol !== 'file:') return false;
    const decoded = decodeURIComponent(parsed.pathname);
    // file:///E:/dir/page.html 的 pathname 以斜杠开头，去掉后再交给 path 处理
    const filePath = process.platform === 'win32'
      ? decoded.replace(/^\//, '').replace(/\//g, '\\')
      : decoded;
    const relative = path.relative(APP_ROOT, path.resolve(filePath));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch (error) {
    return false;
  }
}

// 站外链接交给系统浏览器：应用窗口本身不承担浏览器的职责
function openExternalUrl(targetUrl) {
  const value = String(targetUrl || '');
  if (!/^https?:\/\//i.test(value)) return;
  shell.openExternal(value).catch((error) => {
    console.error('[Esprin Nemo] 打开外部链接失败:', error);
  });
}

// 页面导航收口：站外链接走系统浏览器，其余导航一律拦下。
// 笔记正文与 AI 回答里的链接因此不可能把窗口导航到不受控的页面。
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isInternalPageUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  // 页面里不允许挂载 <webview>
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

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
  // 笔记与待办分别是 notes/、todos/ 下的 .md 文件（自带元数据），config.json 则记录偏好设置与文件夹列表
  return fs.existsSync(path.join(dir, 'notes'))
    || fs.existsSync(path.join(dir, 'todos'))
    || fs.existsSync(path.join(dir, 'config.json'));
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
  // 新位置的配置里若还留着明文 API Key（例如从别处拷来的数据），就地收进本机安全存储
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
    // 开发运行固定使用项目内 data/，始终视为默认位置
    isCustom: !IS_DEV_RUN && !isSamePath(current, defaultDir),
    isDefault: isSamePath(current, defaultDir),
    isDevRun: IS_DEV_RUN
  };
});

// 数据存放位置：弹出目录选择框并按需迁移
ipcMain.handle('data:choose-dir', async (event) => {
  if (IS_DEV_RUN) return { canceled: false, error: DATA_DIR_LOCKED_MESSAGE };
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
  if (IS_DEV_RUN) return { canceled: false, error: DATA_DIR_LOCKED_MESSAGE };
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

// 主窗口最小尺寸（内容尺寸）：收起侧边栏 48 + 笔记列表 270 后仍要留给编辑器一栏可用的宽度，
// 高度则保证标题栏 + 工具栏 + 编辑区 + 状态栏都能完整显示，避免拖到极限后布局被压成一团。
const WINDOW_MIN_WIDTH = 860;
const WINDOW_MIN_HEIGHT = 600;

function createWindow() {
  Menu.setApplicationMenu(null);

  // 数据目录在渲染进程启动前就绪（安装版为 %APPDATA%/esprin_nemo/data）
  const currentDataDir = resolveDataDir();

  // 显示窗口前先定好主题背景色，避免出现闪光弹式闪烁
  const initialBg = resolveEffectiveTheme() === 'light' ? '#ffffff' : '#0d1117';

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    frame: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: initialBg,
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // 页面脚本还在使用 require，因此维持上面的两项目前设置；
      // 其余能力按最小可用原则显式关掉。
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      additionalArguments: [DATA_DIR_ARG + currentDataDir]
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // 关闭主窗口：托盘开启时一律收进托盘（图标就是重新打开界面的入口）；
  // 托盘关闭、但小本本还开着时同样只收起——渲染进程继续存活，笔记读写与小本本的
  // 联动（列表 / 打开 / 保存）都不受影响，小本本得以单独留在屏幕上继续记事。
  // 两者都不成立时保持原样：关闭主窗口即退出应用。
  win.on('close', (event) => {
    if (isQuitting) return;
    if (!isTrayEnabled() && !isScratchpadWindowOpen()) return;
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

  // 用 file URL 而不是手工拼 file://，避免 Windows 盘符与空格路径被拼错
  win.loadURL(pathToFileURL(path.join(APP_ROOT, 'src', 'renderer', 'main.html')).href);

  mainWindowClosed = false;
  mainWindow = win;
  return win;
}

// 单实例锁：数据是磁盘上的一组文件，两个实例并发写入会互相覆盖，
// 因此后启动的实例直接退出，并由既有实例把窗口带到前台。
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

// 单实例锁的既有实例被再次启动时：把已有的主窗口带到前台。
// 主窗口此前被收起（小本本仍在运行或应用已缩进托盘）时，
// 这里就是「重新打开应用」的入口——只显示那扇已存在的主窗口，不再启动新进程。
app.on('second-instance', () => {
  // 正在退出（例如安装更新时）就不要再开窗口了
  if (isQuitting) return;
  // 主窗口确实不在了（例如已被销毁）时重新创建，同样不启动新进程
  showMainWindow();
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;

  // 权限白名单：只放行字体枚举（「设置 → 字体」里读取本机字体列表用），其余一律拒绝。
  // 渲染进程开着 Node 集成，未使用的摄像头 / 麦克风 / 定位等权限没有必要开放。
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

  // 窗口式消息弹窗的 IPC 通道
  registerDialogIpc();

  // 小本本窗口的 IPC 通道（打开 / 读写内容 / 外观同步）
  registerScratchpadIpc();

  // 系统托盘：设置页开关。应用已就绪，托盘图标同时按配置在此落定，
  // 因此主窗口创建时的关闭拦截已经能读到正确的托盘状态。
  registerTrayIpc();
  setupTray();

  // 旧版把 API Key 明文写在 config.json 里：在窗口创建前先收进系统密钥链并从配置中抹掉，
  // 这样渲染进程读到的配置里不会再出现明文密钥
  migrateApiKeyFromConfig(path.join(resolveDataDir(), 'config.json'));
  // AI 助手：对话代理与模型列表
  registerAiIpc();

  // 全局界面默认值：关闭 Chromium 默认焦点描边与 Tab 键焦点切换
  registerUiDefaults();

  // 应用更新：IPC 通道 + 启动后与定时的自动检查（默认开启）
  registerUpdateIpc();

  createWindow();
  scheduleAutoChecks();
});

// 应用开始退出（小本本也关闭后的退出、更新安装时的退出）后，就不再拦下主窗口的关闭
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // 托盘还在就等于应用还有一个入口，窗口都关掉也不必退出
  if (process.platform === 'darwin' || isTrayEnabled()) return;
  app.quit();
});