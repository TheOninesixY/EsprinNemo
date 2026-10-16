const { BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./data_path.js');
const { buildWindowAppearance, safeResolve } = require('./window_appearance.js');

const NOTE_HTML = path.join(__dirname, '..', 'renderer', 'scratchpad.html');

const STATE_FILE_NAME = 'scratchpad.json';

const LEGACY_FILE_NAME = 'scratchpad.md';

const NOTE_WIDTH = 320;
const NOTE_HEIGHT = 380;
const NOTE_MARGIN = 18;
const NOTE_MIN_WIDTH = 220;
const NOTE_MIN_HEIGHT = 180;

const BRIDGE_TIMEOUT = 5000;

let noteWin = null;
let resolveTheme = () => 'dark';
let resolveStyle = () => 'default';
let resolveAccent = () => '';
let resolveRadius = () => 'default';

let resolveFonts = () => ({});
let resolveDataDir = () => '';
let getOwnerWindow = () => null;
let iconPath = path.join(__dirname, '..', '..', require('../../package.json').icon);

let handleWindowClosed = () => {};
let ipcRegistered = false;

let dragOrigin = null;

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

    writeFileAtomic(stateFilePath(), JSON.stringify(state, null, 2));
    return { ok: true };
  } catch (error) {
    console.error('[Esprin Nemo] 保存小本本状态失败:', error);
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

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

function resolveWorkArea() {
  const owner = getOwnerWindow();
  if (owner && !owner.isDestroyed()) {
    try {
      return screen.getDisplayMatching(owner.getBounds()).workArea;
    } catch (error) {

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

    handleWindowClosed();
  });

  win.loadFile(NOTE_HTML).catch((error) => {
    console.error('[Esprin Nemo] 加载小本本页面失败:', error);
    if (!win.isDestroyed()) win.destroy();
  });

  return win;
}

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

function isScratchpadWindowOpen() {
  return !!(noteWin && !noteWin.isDestroyed());
}

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

function unbindNote(title, content) {
  writeNoteState({ noteId: '', title, content });
  return { ok: true };
}

async function saveBoundNote(noteId, title, content) {
  const reply = await askMainWindow('scratchpad:save-note', { noteId, title, content });

  writeNoteState({ noteId, title, content });
  return reply.ok ? { ok: true } : { ok: false, reason: reply.reason || 'failed' };
}

function updateScratchpadAppearance(payload) {
  if (!noteWin || noteWin.isDestroyed()) return;
  const appearance = buildWindowAppearance(payload);

  try {

    noteWin.setBackgroundColor(appearance.backgroundColor);
  } catch (error) {

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

    const keepContent = reply.reason !== 'locked';
    const fallback = { ...state, content: keepContent ? state.content : '' };
    writeNoteState(fallback);
    return { ...fallback, noteId: '', bound: false };
  });

ipcMain.handle('scratchpad:persist', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return writeNoteState(data);
  });

ipcMain.handle('scratchpad:list-notes', async () => {
    const reply = await askMainWindow('scratchpad:list-notes', {});
    if (!reply.ok) return { ok: false, reason: reply.reason || 'failed' };
    return { ok: true, notes: Array.isArray(reply.notes) ? reply.notes : [] };
  });

ipcMain.handle('scratchpad:create-note', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return createNoteFromScratchpad(data.title, data.content);
  });

ipcMain.handle('scratchpad:bind', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return bindNote(data.noteId);
  });

  ipcMain.handle('scratchpad:unbind', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return unbindNote(data.title, data.content);
  });

ipcMain.handle('scratchpad:save-note', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const noteId = typeof data.noteId === 'string' ? data.noteId.trim() : '';
    if (!noteId) return { ok: false, reason: 'missing' };
    return saveBoundNote(noteId, data.title, data.content);
  });

ipcMain.on('scratchpad:reply', (event, payload) => resolveBridgeReply(payload));

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

ipcMain.on('scratchpad:flush', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const noteId = typeof data.noteId === 'string' ? data.noteId.trim() : '';

writeNoteState({ noteId, title: data.title, content: noteId ? '' : data.content });
    if (noteId) saveBoundNote(noteId, data.title, data.content);
  });

ipcMain.on('scratchpad:appearance', (event, payload) => updateScratchpadAppearance(payload));
}

module.exports = {
  configureScratchpadWindow,
  isScratchpadWindowOpen,
  openScratchpadWindow,
  registerScratchpadIpc
};
