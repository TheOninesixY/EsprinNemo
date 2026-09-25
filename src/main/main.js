const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell, nativeTheme } = require('electron');
const fs = require('fs');
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
const { configureScratchpadWindow, isScratchpadWindowOpen, openScratchpadWindow, registerScratchpadIpc } = require('./scratchpad_window.js');
const { buildWindowAppearance } = require('./window_appearance.js');
const { configureTray, isTrayEnabled, registerTrayIpc } = require('./tray.js');
const { configureAutoLaunch, registerAutoLaunchIpc } = require('./auto_launch.js');
const { registerUiDefaults } = require('./ui_defaults.js');
const { configureAiService, registerAiIpc } = require('./ai_service.js');
const { adoptLegacyKeyFile, migrateApiKeyFromConfig } = require('./ai_secret.js');
const { configureSyncServer, registerSyncIpc, applyAutoSyncRuntime } = require('./sync_server.js');
const { disposeSpeechWindows, registerSpeechIpc } = require('./speech_windows.js');
const { configureUpdater, registerUpdateIpc, scheduleAutoChecks, isPortableRun, PORTABLE_ARG } = require('./updater.js');

// 应用根目录：开发版是项目根目录，安装版是 app.asar 根。
// 本文件位于 src/main/ 下，因此 assets/、src/renderer/ 与开发版 data/ 都相对它定位。
const APP_ROOT = app.getAppPath();

// 安装版使用 %APPDATA%/esprin_nemo/data，开发运行（bun start → electron .）使用项目内 data/，
// 便携版使用便携版所在目录下的 data/（数据与记录都随程序目录走，见 src/main/data_path.js）。
// 安装向导与“设置 → 数据存放位置”把选择写进 data_path.json（安装版在 %APPDATA%/esprin_nemo 下，
// 便携版在便携版目录下），该记录优先于默认位置；开发运行不读该记录，也不允许在设置中更改位置。
const IS_DEV_RUN = isDevRun(app);
// 便携版：每次启动都解压到临时目录，没有稳定的可升级目标，
// 因此更新功能（检查 / 下载 / 安装）与相关设置整体不启用
const IS_PORTABLE_RUN = isPortableRun();
// 数据目录层面的便携版判定（只看启动环境变量，与目录能否写入无关）：
// 便携版的数据、配置与运行时目录都随程序目录走，设置页据此展示真实落点；
// 目录写不进去时由启动检查拦下并弹出说明（见下面的 resolveStartupBlock）
const IS_PORTABLE_DATA_RUN = isPortableDataRun();
const DATA_DIR_LOCKED_MESSAGE = '当前为开发运行（bun start），数据固定存放在项目内的 data/ 目录，无法更改数据存放位置。';

/* 便携版与开发运行各自用一份 Chromium profile（缓存 / Cookie / GPU 缓存 / 崩溃转储 / 日志，
   见 data_path.js 的 getIsolatedUserDataDir）：便携版是为了不写 %APPDATA%，
   开发运行则是为了不与安装版共用同一把单实例锁（共用时，安装版还开着的情况下
   bun start 会把启动交给安装版，开发窗口一个都开不出来）。
   必须在 app ready 之前设置，也要早于单实例锁（锁文件就在这个目录里）。 */
const ISOLATED_USER_DATA_DIR = getIsolatedUserDataDir();
if (ISOLATED_USER_DATA_DIR) {
  try {
    // 目录建不出来时（便携版程序目录只读、开发运行下配置目录不可写）这里会失败：
    // 便携版由启动检查弹窗说明；开发运行在取目录时就已经退回默认 profile 了（见 data_path.js）
    fs.mkdirSync(ISOLATED_USER_DATA_DIR, { recursive: true });
  } catch (error) {
    console.warn('[Esprin Nemo] 创建独立运行时目录失败:', error.message);
  }

  for (const name of ['userData', 'sessionData', 'crashDumps']) {
    try {
      // 崩溃转储单独起一个子目录，不把转储文件混在 profile 根目录里
      app.setPath(name, name === 'crashDumps' ? path.join(ISOLATED_USER_DATA_DIR, 'Crashpad') : ISOLATED_USER_DATA_DIR);
    } catch (error) {
      // 个别 Electron 版本没有 sessionData 这一项，其余路径照常设置
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

/* 读取用户配置（config.json）：主进程只关心主题、主题风格、主题色、圆角与字体等外观项，
   供主窗口背景、弹窗窗口、小本本与托盘复用。

   这些值都是「一问一项」的：建一扇弹窗要分别问主题 / 风格 / 主题色 / 应用名颜色 / 圆角 / 字体
   六次，若每次都真去同步读盘、解析 JSON，一次弹窗就是六回 I/O。
   因此按「配置文件路径 + 修改时间 + 大小」缓存解析结果：渲染进程写完配置后 mtime 必然变化，
   缓存随即失效，读到的仍是最新内容；数据目录切换后路径变化同样会命中新的缓存。

   返回值是缓存对象本身，调用方一律只读（updater.js 与 tray.js 都只取字段，不修改）。 */
let configCacheKey = '';
let configCacheValue = {};

function readUserConfig() {
  try {
    const configFile = path.join(resolveDataDir(), 'config.json');

    let stat = null;
    try {
      // 优先取纳秒级时间戳：配置可能在极短间隔内被改写两次（内容长度还可能一样），
      // 毫秒精度下这种改写有碰撞出同一个缓存键的机会，纳秒精度下不会
      stat = fs.statSync(configFile, { bigint: true });
    } catch (error) {
      stat = null;
    }
    if (!stat) {
      try {
        stat = fs.statSync(configFile);
      } catch (error) {
        // 配置文件还不存在（首次启动）：按空配置处理，并清掉上一份缓存
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

/* 合并写入用户配置（config.json）：目前只有更新弹窗里的「永不提醒」会由主进程改配置
   （把 autoUpdate 写成 false），因此这里按字段合并，避免整体覆盖掉渲染进程刚写进去的其他设置。
   写入方式与渲染进程一致：先写同目录的临时文件再改名，防止并发写把配置截断成半截。 */
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

// 主题风格（皮肤）：alom 为 Alom 风格；小本本据此切换配色（见 styles/alom.css）
function resolveThemeStyle() {
  return readUserConfig().themeStyle === 'alom' ? 'alom' : 'default';
}

// 圆角尺度：square（方）/ slight（微圆角）/ default（默认）/ large（大）；
// 非法值一律按默认处理（小本本与弹窗窗口据此换算各自的圆角，见 renderer/styles/radius.css）
function resolveCornerRadius() {
  const raw = readUserConfig().cornerRadius;
  return raw === 'square' || raw === 'slight' || raw === 'large' ? raw : 'default';
}

// 字体：主窗口写入 CSS 变量的那四个字体名，同样注入小本本与弹窗，
// 否则只有主窗口换了字体，另两个窗口看上去就是另一副长相（字段与校验见 main/window_appearance.js）
function resolveWindowFonts() {
  const raw = readUserConfig().fonts;
  return raw && typeof raw === 'object' ? raw : {};
}

// 所有消息弹窗都在自绘标题栏的独立窗口中呈现，主题、风格、圆角与字体都与当前界面保持一致
configureDialogWindows({
  getTheme: resolveEffectiveTheme,
  getStyle: resolveThemeStyle,
  getAccent: resolveAccentColor,
  getBrandColor: resolveBrandColor,
  getRadius: resolveCornerRadius,
  getFonts: resolveWindowFonts,
  icon: path.join(APP_ROOT, 'assets', 'icon.png')
});

// 小本本（便利贴窗口）：右下角置顶小窗，内容随数据目录一起走
configureScratchpadWindow({
  getTheme: resolveEffectiveTheme,
  getStyle: resolveThemeStyle,
  getAccent: resolveAccentColor,
  getRadius: resolveCornerRadius,
  getFonts: resolveWindowFonts,
  getDataDir: resolveDataDir,
  // 便利贴停靠在哪块屏幕右下角，取决于主窗口当前所在的显示器
  getOwner: () => mainWindow,
  icon: path.join(APP_ROOT, 'assets', 'icon.png'),
  // 便利贴关闭后：主窗口此前已被收起时，屏幕上再无窗口，应用也随之退出
  onClosed: handleScratchpadClosed
});

// AI 助手：站点与模型随数据目录存放，API Key 由系统密钥链单独保管；两者都只由主进程读取
configureAiService({ getDataDir: resolveDataDir });

/* 自建同步（操作日志模型，服务端见 server/EsprinServer.py）：
   服务器地址与设备名取自 config.json，访问令牌由系统密钥链单独保管；
   拉取到的操作会直接改动本地文件，因此改完之后要告知主窗口重新载入数据 */
configureSyncServer({
  getDataDir: resolveDataDir,
  getConfig: readUserConfig,
  onRendererMessage: (channel, payload) => {
    if (mainWindowClosed || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
  }
});

// 应用更新：检查 / 下载 / 安装三段都在主进程完成（见 updater.js），
// 自动检查是否开启以 config.json 中的 autoUpdate 为准（默认开启）。
// 便携版不会走到这里注册的 IPC 与自动检查，这里的注入因此只对其他运行方式生效。
configureUpdater({
  getConfig: readUserConfig,
  // 「永不提醒」勾选后由主进程直接关掉配置里的自动更新，因此还要能写回 config.json
  setConfig: updateUserConfig,
  // 主窗口被收起时不给弹窗挂一个隐藏的父窗口，更新提示因此仍能正常显示
  getOwner: () => (mainWindowClosed ? null : mainWindow)
});

// 主窗口引用：小本本据此定位停靠屏幕
let mainWindow = null;
// 主窗口是否已被用户关闭（小本本还在运行时，主窗口只是收起，进程继续存活）
let mainWindowClosed = false;
// 应用是否正在退出（更新安装、或窗口都关掉了）：此时不再拦下主窗口的关闭
let isQuitting = false;
// 启动阶段被拦下（便携版写不进数据目录）：应用正停在弹窗上等用户处理，
// 此时既没有主窗口，也不该因为「再次启动应用」而新建窗口
let startupBlocked = false;

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
    onOpenScratchpad: openScratchpadWindow,
    onQuit: () => { app.quit(); },
    // 关掉托盘后应用失去唯一的常驻入口：此时没有任何可见窗口就应当退出，
    // 否则进程会留在后台且再也唤不回来
    onEnabledChanged: (enabled) => { if (!enabled) quitIfNoVisibleWindow(); }
  });
}

// 把主窗口叫回前台：托盘菜单、托盘动作与「再次启动应用」都走这里。
// 主窗口确实不在了时重新创建一扇，同样不另起进程。
function showMainWindow() {
  if (isQuitting || startupBlocked) return null;
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

// 目录是否可写：与数据目录解析共用同一份实现（见 main/data_path.js 的 ensureDirUsable，
// 它会实际落一个空文件再删掉），目录的只读属性、ACL 与只读盘因此都能识别出来
function isDirWritable(dir) {
  return ensureDirUsable(dir);
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

/* 界面尺寸（Chromium 缩放）变更：最小尺寸按同一比例换算。
   缩放由渲染进程直接落在页面上（见 src/renderer/boot.js），主进程只需跟着调最小尺寸。 */
ipcMain.handle('window:ui-scale', (event, scale) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const size = scaleMinWindowSize(Number(scale));
  win.setMinimumSize(size.width, size.height);
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

/* 导入文件为笔记：弹出系统文件选择框，只返回路径，
   读取与建笔记都在渲染进程完成（数据目录、State 都在那边）。 */
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
    isDevRun: IS_DEV_RUN,
    // 便携版：默认位置是便携版所在目录下的 data/，记录文件也写在同一目录下
    isPortableRun: IS_PORTABLE_DATA_RUN,
    // 位置记录文件（data_path.json）的实际路径，设置页据此如实告知用户记录写在哪
    locationFile: getLocationFile(app) || ''
  };
});

/* 数据位置用不了时的统一出路：把原因说清楚，并给一个「重新选择路径」。
   返回 true 表示用户选择了重选，由调用方接着再走一遍选择流程。 */
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

// 选中一个位置并切过去（含迁移确认）；中途出问题就弹窗请用户重选，直到成功或放弃
async function chooseDataDirWithRetry(win) {
  while (true) {
    const picked = await pickDataDir(win, resolveDataDir());
    if (!picked) return { canceled: true };

    const result = await applyDataDirChange(picked, win);
    if (!result.error) return result;
    if (!await askReselectDataDir(win, '无法使用所选位置', result.error)) return { canceled: true };
  }
}

// 数据存放位置：弹出目录选择框并按需迁移；位置用不了时给「重新选择路径」而不是只报错
ipcMain.handle('data:choose-dir', async (event) => {
  if (IS_DEV_RUN) return { canceled: false, error: DATA_DIR_LOCKED_MESSAGE };
  return chooseDataDirWithRetry(BrowserWindow.fromWebContents(event.sender));
});

// 数据存放位置：恢复为默认位置（并清除自定义记录）。
// 默认位置不可用时（例如便携版程序目录被设成只读）同样给一次改选其他位置的出路
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

/* 界面里的固定站外入口：渲染进程只传键名，地址留在主进程，
   渲染进程因此无法要求主进程打开任意地址。 */
const EXTERNAL_LINKS = {
  // 自建同步的服务端项目（设置 → 数据与存储 → 自建同步 → 服务端）
  serverRepo: 'https://github.com/TheOninesixY/EsprinServer'
};

// 固定站外链接：交给系统浏览器打开
ipcMain.handle('app:open-external', (event, key) => {
  const url = EXTERNAL_LINKS[String(key || '')];
  if (!url) return false;
  openExternalUrl(url);
  return true;
});

// 主窗口最小尺寸（内容尺寸）：收起侧边栏 48 + 笔记列表 270 后仍要留给编辑器一栏可用的宽度，
// 高度则保证标题栏 + 工具栏 + 编辑区 + 状态栏都能完整显示，避免拖到极限后布局被压成一团。
const WINDOW_MIN_WIDTH = 860;
const WINDOW_MIN_HEIGHT = 600;

/* 界面尺寸（Chromium 缩放比例，1 = 100%）：窗口里的 CSS 视口 = 窗口尺寸 ÷ 缩放比例，
   界面放到 200% 时，860px 宽的最小窗口只剩 430px 可用，正好会撞上上面那条防线。
   因此最小尺寸按同一比例一起放大（缩小界面时也允许把窗口拖得更小）。
   取值范围与渲染进程一致，见 src/renderer/boot.js 的 UI_SCALE_*。 */
function resolveUiScale() {
  const raw = Number(readUserConfig().uiScale);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(Math.max(raw, 0.5), 2);
}

// 最小尺寸按缩放比例换算：比例非法时按 100% 处理
function scaleMinWindowSize(scale) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    width: Math.round(WINDOW_MIN_WIDTH * factor),
    height: Math.round(WINDOW_MIN_HEIGHT * factor)
  };
}

/* 便携版写不进数据目录时的说明文案：把「哪里写不进去」与「怎么恢复」都写清楚，
   用户不必去翻文档。三种原因都会给出「重新选择路径」这条出路。 */
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

/* 让用户挑选数据目录：必须可写，选不出来就一直给机会。
   owner 为弹窗的父窗口（启动阶段没有窗口，传 null）。
   返回选定的绝对路径；用户取消选择时返回 null。 */
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

    // 选到不可写的目录（只读盘、系统目录等）时就地重挑，回到上一层没有意义
    if (!await askReselectDataDir(parent, '所选目录不可写', `请检查该目录的访问权限，或换一个位置。\n位置：${picked}`)) {
      return null;
    }
  }
}

/* 启动被拦下时的交互：三种原因一律给出「重新选择路径」——选到可写目录后就用它继续启动，
   不必自己去找并删除 data_path.json，也不必先去搬动便携版。
   程序目录不可写时位置记录无处可写，选定的位置只能对本次运行生效（弹窗里已写明）。

   返回选定的数据目录；用户选择退出时返回 null，由调用方收场。 */
async function resolveStartupBlock(blocker) {
  // 目录不可写、但仍然可能是可读的（例如整个目录被设成只读）：先把解析结果落定，
  // 弹窗于是还能沿用用户当前的主题、主题色与字体，不会突然换一副长相
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

    // 位置记录写回便携版目录下的 data_path.json，下次启动直接生效
    if (writeStoredDataDir(picked, app)) {
      console.log('[Esprin Nemo] 数据位置已改为:', picked);
      return picked;
    }

    if (blocker.kind === 'portable-dir') {
      // 程序目录本来就不可写：这次选择只能用于本次运行（弹窗里已写明）
      console.warn('[Esprin Nemo] 程序目录不可写，本次运行临时使用数据位置:', picked);
      return picked;
    }

    // 其余情况下记录本该写得进去：写失败说明程序目录也出问题了，
    // 改按「程序目录不可写」再说一次，别让用户以为已经改好了
    console.error('[Esprin Nemo] 位置记录写入失败，新的数据位置无法保存:', picked);
    blocker = { ...blocker, kind: 'portable-dir', reason: '位置记录无法写入', dataDir: picked };
  }
}

// 用户选择「退出」后的收场：弹窗已经说明过原因，这里不再重复弹窗，只退出应用
function abortStartup(blocker) {
  console.error('[Esprin Nemo] 便携版启动失败:', blocker.reason, blocker.dir);

  if (!dataDir) dataDir = blocker.dataDir;
  // 弹窗期间再次启动应用（单实例锁会把请求转给本进程）不该去开主窗口：
  // 数据目录都写不进去，开出来的窗口也只会立刻出错
  isQuitting = true;

  app.quit();
}

/* 主窗口的显示时机：正常情况下等 ready-to-show——首帧画完再显示，不会先闪一下白底。
   但 ready-to-show 依赖渲染进程真的交出第一帧：软件渲染 / 远程桌面 / GPU 进程重启，
   或首帧只画了底色还没画内容时，这个事件可能一直不来，窗口就永远不显示——
   现象正是「应用在跑、托盘图标也在，就是没有窗口，只有去点托盘才出来」。
   因此再备两条兜底：页面加载完成后再显示一次、以及最多等 REVEAL_FALLBACK_MS。
   走兜底时打一条 warn，方便在终端里看出到底是哪条路把窗口显示出来的。 */
const REVEAL_DELAY = 90;
const REVEAL_FALLBACK_MS = 2500;

function createWindow() {
  Menu.setApplicationMenu(null);

  // 数据目录在渲染进程启动前就绪（安装版为 %APPDATA%/esprin_nemo/data）
  const currentDataDir = resolveDataDir();

  // 显示窗口前先定好主题背景色，避免出现闪光弹式闪烁。
  // 底色同样按「主题风格 + 明暗」取：选 Alom 风格时主窗口的兜底色也跟着换
  // （与两个辅助窗口用同一份换算，见 main/window_appearance.js）
  const initialBg = buildWindowAppearance({
    theme: resolveEffectiveTheme(),
    style: resolveThemeStyle()
  }).backgroundColor;

  // 界面尺寸（缩放）在渲染进程里落定（见 src/renderer/boot.js），
  // 这里只按同一比例把窗口的最小尺寸一起放大
  const minSize = scaleMinWindowSize(resolveUiScale());

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: minSize.width,
    minHeight: minSize.height,
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
      // 便携版标记：渲染进程据此把「更新与版本」设置分类与面板一并摘掉
      additionalArguments: IS_PORTABLE_RUN
        ? [DATA_DIR_ARG + currentDataDir, PORTABLE_ARG]
        : [DATA_DIR_ARG + currentDataDir]
    }
  });

  let revealed = false;
  const reveal = (reason) => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    if (reason !== 'ready-to-show') {
      console.warn(`[Esprin Nemo] ready-to-show 没有来到，已按「${reason}」显示主窗口`);
    }
    win.show();
  };
  win.once('ready-to-show', () => reveal('ready-to-show'));
  // 兜底一：页面加载完成（主进程收不到首帧时，这一条通常能接住）
  win.webContents.once('did-finish-load', () => setTimeout(() => reveal('did-finish-load'), REVEAL_DELAY));
  // 兜底二：页面卡在加载中时也不至于一直没有窗口
  const revealTimer = setTimeout(() => reveal('超时'), REVEAL_FALLBACK_MS);
  win.once('closed', () => clearTimeout(revealTimer));

  // 渲染进程崩了的话窗口同样会停在「没显示」：留下一条能查的线索
  win.webContents.on('render-process-gone', (event, details) => {
    console.error('[Esprin Nemo] 主窗口渲染进程已退出:', details && details.reason);
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
if (!hasSingleInstanceLock) {
  /* 已有实例在运行（托盘里那个就是它）：它会在 second-instance 里把窗口带到前台。
     这里用 exit 而不是 quit——quit 要先走完「关闭所有窗口」那一套流程，在 app ready 之前
     调用时压不住进程，会留下一份既没有窗口、也没有托盘的残影：开发时看到的就是
     「bun start 跑了，但没有窗口」，而唯一的界面入口只能去托盘的既有实例里找。 */
  console.warn('[Esprin Nemo] 已有实例在运行（单实例锁被占用），本次启动已交给它，进程退出');
  app.exit(0);
}

// 启动是否已经走到「窗口已创建」：second-instance 据此判断该自己去开窗口还是等启动流程
let startupReady = false;

// 单实例锁的既有实例被再次启动时：把已有的主窗口带到前台。
// 主窗口此前被收起（小本本仍在运行或应用已缩进托盘）时，
// 这里就是「重新打开应用」的入口——只显示那扇已存在的主窗口，不再启动新进程。
app.on('second-instance', () => {
  // 正在退出（例如安装更新时）就不要再开窗口了
  if (isQuitting) return;
  /* 启动流程还没走完（窗口尚未创建）：接下来那一步自然会把它显示出来，
     这里再调一次 showMainWindow 只会另开一扇窗口 */
  if (!startupReady) return;
  // 主窗口确实不在了（例如已被销毁）时重新创建，同样不启动新进程
  showMainWindow();
});

/* 启动步骤的隔错包装：把「接上某个入口」这类步骤单独包起来，一步失败不影响其余步骤，
   更不会影响到最后的窗口创建（说明见 whenReady 里那段）。 */
function runStartupStep(label, run) {
  try {
    return run();
  } catch (error) {
    console.error(`[Esprin Nemo] 启动步骤「${label}」失败:`, error);
    return null;
  }
}

app.whenReady().then(async () => {
  // 没拿到单实例锁时上面已经直接退出了，这里不会再走到
  if (!hasSingleInstanceLock) return;

  // 便携版无法写入数据目录（只读位置、无权限等）：不退回 %APPDATA%，先弹窗告知；
  // 三种原因都会给出「重新选择路径」，选到可写目录后照常启动，只有用户选「退出」才真的退出。
  // 检查必须早于任何窗口与 IPC 注册，应用因此不会留下一份「看起来正常」的数据。
  const startupBlocker = getStartupBlocker(APP_ROOT, app);
  if (startupBlocker) {
    // 应用停在启动弹窗上：这期间再次启动应用不该去开主窗口（数据目录还写不进去）
    startupBlocked = true;
    // 弹窗页面靠这几条 IPC 取回内容、量高与回传所选按钮
    registerDialogIpc();

    let pickedDir = null;
    try {
      pickedDir = await resolveStartupBlock(startupBlocker);
    } catch (error) {
      // 连自绘弹窗都开不出来（例如图形环境异常）时退回系统原生消息框，至少让用户知道原因
      console.error('[Esprin Nemo] 显示启动失败弹窗失败:', error);
      dialog.showErrorBox('Esprin Nemo 无法启动', `${startupBlocker.reason}：\n${startupBlocker.dataDir}`);
    }

    if (!pickedDir) {
      abortStartup(startupBlocker);
      return;
    }
    // 用户刚选定的数据目录就是本次运行的位置（位置记录能写时已写回便携版目录）
    dataDir = pickedDir;
    startupBlocked = false;
  }

  /* 权限白名单：只放行字体枚举（「设置 → 字体」里读取本机字体列表用），其余一律拒绝。
     渲染进程开着 Node 集成，未使用的摄像头 / 麦克风 / 定位等权限没有必要开放。
     随口记的语音识别不在此列：音频由主进程拉起的系统识别引擎采集（见 speech_windows.js），
     渲染进程既不取麦克风，也不经过 Chromium 的媒体权限。 */
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

  /* 从这里到窗口创建之间的每一步都只是「把某个入口接上」，彼此独立：任何一步抛错都不该
     连累后面，尤其是最后的 createWindow()——窗口没出来时，用户看到的是
     「应用在跑、托盘图标也在，就是没有窗口」，而错误只留在终端里。
     因此逐步隔开：出错记一条 console.error，其余照常进行（见 runStartupStep）。 */
  runStartupStep('开机自启', () => {
    // 设置页开关 + 按配置落定系统启动项（默认关闭）
    registerAutoLaunchIpc();
    configureAutoLaunch({ getConfig: readUserConfig });
  });

  runStartupStep('API Key 迁移', () => {
    // 配置目录搬家时（便携版的配置目录就是便携版所在目录）先把旧位置 %APPDATA%/esprin_nemo
    // 下的密钥文件搬过来，用户不必重新填一遍 API Key
    adoptLegacyKeyFile();
    // 旧版把 API Key 明文写在 config.json 里：在窗口创建前先收进系统密钥链并从配置中抹掉，
    // 这样渲染进程读到的配置里不会再出现明文密钥
    migrateApiKeyFromConfig(path.join(resolveDataDir(), 'config.json'));
  });

  // AI 助手：对话代理与模型列表
  runStartupStep('AI 助手', () => registerAiIpc());

  // 随口记：系统语音识别（Windows 桌面离线识别引擎，见 speech_windows.js）
  runStartupStep('系统语音识别', () => registerSpeechIpc());

  // 自建同步：测试连接 / 立即同步 / 首次接入 / 诊断（令牌不经过渲染进程）
  runStartupStep('自建同步', () => registerSyncIpc());

  // 自建同步的自动同步：每轮启动先同步一次（与「自动同步」设置无关），
  // 之后按设置里的间隔拉取并重放远端操作、推送本地改动
  runStartupStep('自建同步自动同步', () => applyAutoSyncRuntime());

  // 全局界面默认值：关闭 Chromium 默认焦点描边与 Tab 键焦点切换
  runStartupStep('界面默认值', () => registerUiDefaults());

  // 应用更新：IPC 通道 + 启动后与定时的自动检查（默认开启）。
  // 便携版没有可升级的目标，更新功能与相关设置整体不启用。
  if (!IS_PORTABLE_RUN) runStartupStep('应用更新', () => registerUpdateIpc());

  // 启动信息：终端里能一眼看出这一轮是哪个实例、数据落在哪——
  // 「托盘里那个到底是本次启动的，还是上一轮留下的」正是这条日志要回答的问题
  runStartupStep('启动信息', () => {
    const flavor = IS_PORTABLE_DATA_RUN ? '便携版' : (IS_DEV_RUN ? '开发运行' : '安装版');
    console.log(`[Esprin Nemo] 启动：${flavor}，数据目录 ${resolveDataDir()}`);
  });

  /* 主窗口是整个应用唯一的正式界面，单独包一层：真开不出来时用系统弹窗说明原因并退出，
     而不是留下一个只有托盘、点不出窗口的进程（托盘那侧也拿不到可显示的窗口）。 */
  try {
    createWindow();
  } catch (error) {
    console.error('[Esprin Nemo] 创建主窗口失败:', error);
    dialog.showErrorBox('Esprin Nemo 无法打开窗口', `创建主窗口时出错：\n${(error && error.message) || error}`);
    app.exit(1);
    return;
  }
  startupReady = true;
  if (!IS_PORTABLE_RUN) scheduleAutoChecks();
});

// 应用开始退出（小本本也关闭后的退出、更新安装时的退出）后，就不再拦下主窗口的关闭
app.on('before-quit', () => {
  isQuitting = true;
  // 随口记的识别进程跟着一起收掉，别在系统里留下一个仍占着麦克风的 PowerShell
  disposeSpeechWindows();
});

app.on('window-all-closed', () => {
  // 托盘还在就等于应用还有一个入口，窗口都关掉也不必退出
  if (process.platform === 'darwin' || isTrayEnabled()) return;
  app.quit();
});