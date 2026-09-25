// 小本本：屏幕右下角的便利贴小窗口。
// 自绘标题栏保留「选择笔记 / 保存 / 最小化 / 关闭」，窗口始终置顶，方便随手记事。
// 两种状态：未关联笔记时内容属于小本本自己（数据目录下的 scratchpad.json）；
// 关联某篇笔记后，小本本直接编辑那篇笔记——笔记数据统一由主窗口渲染进程读写，
// 避免两个窗口各存一份、互相覆盖。
// 小本本还决定应用的存活时间：主窗口关闭后进程靠它继续运行，它也被关闭时应用才退出
// （关闭动作在这里上报给 main.js，由 main.js 决定去留）。
const { BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./data_path.js');
const { buildWindowAppearance, safeResolve } = require('./window_appearance.js');

const NOTE_HTML = path.join(__dirname, '..', 'renderer', 'scratchpad.html');
// 小本本状态 { noteId, title, content }：与笔记共用数据目录，随「数据存放位置」一起迁移
const STATE_FILE_NAME = 'scratchpad.json';
// 旧版本只保存正文，首次读取时并入新状态文件，避免升级后内容"消失"
const LEGACY_FILE_NAME = 'scratchpad.md';

// 窗口尺寸（内容尺寸）与停靠边距：默认贴在屏幕右下角，尺寸小巧不挡视线。
// 宽度需容纳标题栏里的 4 个按钮 + 标题输入，因此比纯文本框窗口略宽。
const NOTE_WIDTH = 320;
const NOTE_HEIGHT = 380;
const NOTE_MARGIN = 18;
const NOTE_MIN_WIDTH = 220;
const NOTE_MIN_HEIGHT = 180;

// 主窗口渲染进程回应的超时：超时按失败处理，界面不会一直悬在等待中
const BRIDGE_TIMEOUT = 5000;

let noteWin = null;
let resolveTheme = () => 'dark';
let resolveStyle = () => 'default';
let resolveAccent = () => '';
let resolveRadius = () => 'default';
// 字体：与主窗口一样的 { uiLatin, uiCjk, docLatin, docCjk }
let resolveFonts = () => ({});
let resolveDataDir = () => '';
let getOwnerWindow = () => null;
let iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
// 便利贴关闭后的回调（由 main.js 注入）：主窗口也已关闭时据此退出应用
let handleWindowClosed = () => {};
let ipcRegistered = false;
// 标题把手拖动窗口时的起点（窗口坐标），松手后清空
let dragOrigin = null;

// 由 main.js 注入主题、主题风格、主题色、圆角尺度、字体、数据目录、归属窗口、图标与关闭回调
function configureScratchpadWindow({ getTheme, getStyle, getAccent, getRadius, getFonts, getDataDir, getOwner, icon, onClosed } = {}) {
  if (typeof getTheme === 'function') resolveTheme = getTheme;
  if (typeof getStyle === 'function') resolveStyle = getStyle;
  if (typeof getAccent === 'function') resolveAccent = getAccent;
  if (typeof getRadius === 'function') resolveRadius = getRadius;
  if (typeof getFonts === 'function') resolveFonts = getFonts;
  if (typeof getDataDir === 'function') resolveDataDir = getDataDir;
  if (typeof getOwner === 'function') getOwnerWindow = getOwner;
  if (typeof icon === 'string' && icon) iconPath = icon;
  if (typeof onClosed === 'function') handleWindowClosed = onClosed;
}

// 当前外观：取值交给注入的读取函数，换算与参数拼装交给 window_appearance.js，
// 与弹窗窗口、三个窗口的渲染端用的是同一套逻辑
function currentAppearance() {
  return buildWindowAppearance({
    theme: safeResolve(resolveTheme, 'dark', '主题'),
    style: safeResolve(resolveStyle, 'default', '主题风格'),
    accent: safeResolve(resolveAccent, '', '主题色'),
    radius: safeResolve(resolveRadius, 'default', '圆角尺度'),
    fonts: safeResolve(resolveFonts, {}, '字体')
  });
}

function stateFilePath() {
  return path.join(resolveDataDir(), STATE_FILE_NAME);
}

function normalizeNoteState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    noteId: typeof source.noteId === 'string' ? source.noteId.trim() : '',
    title: typeof source.title === 'string' ? source.title : '',
    content: typeof source.content === 'string' ? source.content : ''
  };
}

function readNoteState() {
  try {
    const file = stateFilePath();
    if (fs.existsSync(file)) return normalizeNoteState(JSON.parse(fs.readFileSync(file, 'utf8')));

    // 升级路径：旧版只有 scratchpad.md，把其中的正文当作小本本的初始内容
    const legacy = path.join(resolveDataDir(), LEGACY_FILE_NAME);
    if (fs.existsSync(legacy)) {
      return { noteId: '', title: '', content: fs.readFileSync(legacy, 'utf8') };
    }
  } catch (error) {
    console.error('[Esprin Nemo] 读取小本本状态失败:', error);
  }
  return { noteId: '', title: '', content: '' };
}

function writeNoteState(raw) {
  try {
    fs.mkdirSync(resolveDataDir(), { recursive: true });
    const state = normalizeNoteState(raw);
    // 小本本未关联笔记时，内容只存在这份文件里，因此同样走原子写入
    writeFileAtomic(stateFilePath(), JSON.stringify(state, null, 2));
    return { ok: true };
  } catch (error) {
    console.error('[Esprin Nemo] 保存小本本状态失败:', error);
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

// 与主窗口渲染进程之间的请求 / 响应：笔记列表、打开、新建、保存全部在主窗口完成，
// 小本本只负责转发，保证同一时刻只有一份权威的笔记状态。
const bridgePending = new Map();
let bridgeSeq = 0;

function askMainWindow(channel, payload) {
  const owner = getOwnerWindow();
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) {
    return Promise.resolve({ ok: false, reason: 'no-window' });
  }

  return new Promise((resolve) => {
    const id = ++bridgeSeq;
    const timer = setTimeout(() => {
      bridgePending.delete(id);
      resolve({ ok: false, reason: 'timeout' });
    }, BRIDGE_TIMEOUT);

    bridgePending.set(id, { resolve, timer });
    owner.webContents.send(channel, { ...(payload || {}), id });
  });
}

function resolveBridgeReply(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const entry = bridgePending.get(data.id);
  if (!entry) return;

  bridgePending.delete(data.id);
  clearTimeout(entry.timer);

  if (data.ok === false) {
    entry.resolve({ ok: false, reason: typeof data.reason === 'string' ? data.reason : 'failed' });
    return;
  }
  entry.resolve({ ok: true, ...data });
}

// 右下角停靠：优先使用主窗口所在显示器的工作区（已排除任务栏），
// 主窗口不存在（或已销毁）时退回主显示器。
function resolveWorkArea() {
  const owner = getOwnerWindow();
  if (owner && !owner.isDestroyed()) {
    try {
      return screen.getDisplayMatching(owner.getBounds()).workArea;
    } catch (error) {
      // 忽略：退回主显示器
    }
  }
  return screen.getPrimaryDisplay().workArea;
}

function dockBounds() {
  const area = resolveWorkArea();
  return {
    width: NOTE_WIDTH,
    height: NOTE_HEIGHT,
    x: Math.round(area.x + area.width - NOTE_WIDTH - NOTE_MARGIN),
    y: Math.round(area.y + area.height - NOTE_HEIGHT - NOTE_MARGIN)
  };
}

function createScratchpadWindow() {
  // 外观（主题 / 风格 / 主题色 / 圆角尺度 / 字体）一次算完：
  // 一组用于窗口底色兜底，另一组经命令行参数注入页面，首屏渲染前就能应用
  const appearance = currentAppearance();

  const win = new BrowserWindow({
    ...dockBounds(),
    minWidth: NOTE_MIN_WIDTH,
    minHeight: NOTE_MIN_HEIGHT,
    frame: false,
    show: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: '小本本',
    // 便利贴的价值在于「一直看得见」，因此新窗口即为置顶窗口
    alwaysOnTop: true,
    backgroundColor: appearance.backgroundColor,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      additionalArguments: appearance.args
    }
  });

  noteWin = win;
  win.setAlwaysOnTop(true, 'floating');
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => win.show());
  win.once('closed', () => {
    if (noteWin === win) noteWin = null;
    // 便利贴也没了：此刻屏幕上是否还有窗口，只有 main.js 清楚
    handleWindowClosed();
  });

  win.loadFile(NOTE_HTML).catch((error) => {
    console.error('[Esprin Nemo] 加载小本本页面失败:', error);
    if (!win.isDestroyed()) win.destroy();
  });

  return win;
}

// 打开小本本：已存在则恢复并前置，否则新建一个右下角窗口
function openScratchpadWindow() {
  if (noteWin && !noteWin.isDestroyed()) {
    if (noteWin.isMinimized()) noteWin.restore();
    noteWin.show();
    noteWin.focus();
    return false;
  }
  createScratchpadWindow();
  return true;
}

// 便利贴是否正开着（含被最小化的情形）：主窗口关闭时据此决定是收起主窗口还是退出应用
function isScratchpadWindowOpen() {
  return !!(noteWin && !noteWin.isDestroyed());
}

// 把便利贴内容新建为一篇笔记：交给主窗口渲染进程落地，
// 成功后小本本直接关联到这篇新笔记，继续在原地编辑（主窗口保持后台，不抢焦点）。
async function createNoteFromScratchpad(title, content) {
  if (!String(title || '').trim() && !String(content || '').trim()) {
    return { ok: false, reason: 'empty' };
  }

  const reply = await askMainWindow('scratchpad:create-note', { title, content });
  if (!reply.ok || !reply.noteId) {
    return { ok: false, reason: reply.reason || 'failed' };
  }

  writeNoteState({ noteId: reply.noteId, title, content });
  return { ok: true, noteId: reply.noteId };
}

// 关联（或切换）笔记：从主窗口取回最新内容，成功后小本本进入笔记模式
async function bindNote(noteId) {
  const target = typeof noteId === 'string' ? noteId.trim() : '';
  if (!target) return { ok: false, reason: 'missing' };

  const reply = await askMainWindow('scratchpad:get-note', { noteId: target });
  if (!reply.ok || !reply.note) return { ok: false, reason: reply.reason || 'missing' };

  const note = normalizeNoteState(reply.note);
  note.noteId = reply.note.id || target;
  writeNoteState(note);
  return { ok: true, note: { id: note.noteId, title: note.title, content: note.content } };
}

// 解除关联：内容留给小本本自己保管（仅缓存，不会写回笔记）
function unbindNote(title, content) {
  writeNoteState({ noteId: '', title, content });
  return { ok: true };
}

// 保存到关联的笔记：由主窗口渲染进程更新笔记正文与元数据
async function saveBoundNote(noteId, title, content) {
  const reply = await askMainWindow('scratchpad:save-note', { noteId, title, content });
  // 写回笔记失败时也把内容缓存下来，重开窗口不至于丢内容
  writeNoteState({ noteId, title, content });
  return reply.ok ? { ok: true } : { ok: false, reason: reply.reason || 'failed' };
}

// 主窗口内变更主题 / 主题风格 / 主题色 / 圆角尺度 / 字体后同步到便利贴，避免两个窗口观感不一致。
// 渲染端收到后用与小本本首屏完全相同的那套逻辑重新应用（见 renderer/window_appearance.js）
function updateScratchpadAppearance(payload) {
  if (!noteWin || noteWin.isDestroyed()) return;
  const appearance = buildWindowAppearance(payload);

  try {
    // 窗口底色只是兜底，失败不影响窗口内容
    noteWin.setBackgroundColor(appearance.backgroundColor);
  } catch (error) {
    // 忽略：窗口可能刚好在这一刻被关掉
  }
  if (!noteWin.webContents.isDestroyed()) {
    noteWin.webContents.send('scratchpad:appearance', {
      theme: appearance.theme,
      style: appearance.style,
      radius: appearance.radius,
      accent: appearance.accent,
      fonts: appearance.fonts
    });
  }
}

function registerScratchpadIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('scratchpad:toggle', () => openScratchpadWindow());

  // 打开窗口时恢复上次的会话：关联的笔记优先取最新内容
  ipcMain.handle('scratchpad:load', async () => {
    const state = readNoteState();
    if (!state.noteId) return { ...state, bound: false };

    const reply = await askMainWindow('scratchpad:get-note', { noteId: state.noteId });
    if (reply.ok && reply.note) {
      return {
        noteId: reply.note.id || state.noteId,
        title: reply.note.title,
        content: reply.note.content,
        bound: true
      };
    }
    /* 笔记已不存在（例如被删或数据目录换过）：退回未关联状态，内容按缓存保留；
       笔记还在但正文已加密（reason 为 locked）时不保留缓存里的正文副本 */
    const keepContent = reply.reason !== 'locked';
    const fallback = { ...state, content: keepContent ? state.content : '' };
    writeNoteState(fallback);
    return { ...fallback, noteId: '', bound: false };
  });

  // 缓存：未关联时的内容、或关联笔记的内容快照，保证重开窗口能回到离开时的样子
  ipcMain.handle('scratchpad:persist', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return writeNoteState(data);
  });

  // 可选笔记列表（主窗口是笔记数据的权威来源）
  ipcMain.handle('scratchpad:list-notes', async () => {
    const reply = await askMainWindow('scratchpad:list-notes', {});
    if (!reply.ok) return { ok: false, reason: reply.reason || 'failed' };
    return { ok: true, notes: Array.isArray(reply.notes) ? reply.notes : [] };
  });

  // 自由模式下点保存：后台新建笔记并自动关联
  ipcMain.handle('scratchpad:create-note', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return createNoteFromScratchpad(data.title, data.content);
  });

  // 选择一篇已有笔记：直接在小本本里编辑它
  ipcMain.handle('scratchpad:bind', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return bindNote(data.noteId);
  });

  ipcMain.handle('scratchpad:unbind', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return unbindNote(data.title, data.content);
  });

  // 已关联笔记：保存回那篇笔记
  ipcMain.handle('scratchpad:save-note', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const noteId = typeof data.noteId === 'string' ? data.noteId.trim() : '';
    if (!noteId) return { ok: false, reason: 'missing' };
    return saveBoundNote(noteId, data.title, data.content);
  });

  // 主窗口渲染进程回传的应答
  ipcMain.on('scratchpad:reply', (event, payload) => resolveBridgeReply(payload));

  // 标题把手拖动：渲染进程没有移动窗口的能力，这里按屏幕增量搬运窗口。
  // 起点在第一次移动时才记录（此时窗口尚未位移），松手时清空。
  ipcMain.on('scratchpad:drag-move', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;

    if (!dragOrigin) {
      const [x, y] = win.getPosition();
      dragOrigin = { x, y };
    }

    const data = payload && typeof payload === 'object' ? payload : {};
    const dx = Math.round(Number(data.dx) || 0);
    const dy = Math.round(Number(data.dy) || 0);
    win.setPosition(dragOrigin.x + dx, dragOrigin.y + dy);
  });

  ipcMain.on('scratchpad:drag-end', () => {
    dragOrigin = null;
  });

  // 关窗兜底：渲染进程即将消失，异步保存只能由主进程接着完成
  ipcMain.on('scratchpad:flush', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const noteId = typeof data.noteId === 'string' ? data.noteId.trim() : '';

    /* 已关联笔记时只记绑定关系，不缓存正文：正文的权威副本就在笔记文件里，
       重开窗口会向主窗口重新取一次。缓存一份快照除了冗余，还会给「正文加密落盘」
       留个例外——scratchpad.json 与笔记同在一个数据目录，缓存的却是明文。
       未关联时内容只存在这份文件里，仍需整份存下 */
    writeNoteState({ noteId, title: data.title, content: noteId ? '' : data.content });
    if (noteId) saveBoundNote(noteId, data.title, data.content);
  });

  // 主窗口根据当前主题 / 主题色广播外观
  ipcMain.on('scratchpad:appearance', (event, payload) => updateScratchpadAppearance(payload));
}

module.exports = {
  configureScratchpadWindow,
  isScratchpadWindowOpen,
  openScratchpadWindow,
  registerScratchpadIpc
};
