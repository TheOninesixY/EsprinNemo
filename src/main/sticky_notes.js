const { BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./data_path.js');
const { keepDesktopLevel, raiseAboveDesktop, setDesktopLevel } = require('./desktop_layer.js');
const { syncDesktopMenu } = require('./desktop_menu.js');
const { buildWindowAppearance, safeResolve } = require('./window_appearance.js');

const STICKY_HTML = path.join(__dirname, '..', 'renderer', 'sticky.html');

const STATE_FILE_NAME = 'stickies.json';

const ITEM_ID_ARG = '--esprin-nemo-sticky-id=';
const DATA_DIR_ARG = '--esprin-nemo-data-dir=';

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 300;
const MIN_WIDTH = 180;
const MIN_HEIGHT = 120;

const SPAWN_MARGIN = 48;
const SPAWN_STEP = 26;
const SPAWN_WRAP = 10;

const KIND_VALUES = ['note', 'todo', 'free'];

const COLOR_VALUES = ['yellow', 'green', 'blue', 'pink', 'purple', 'gray'];

const COLOR_HUES = { yellow: 48, green: 96, blue: 205, pink: 335, purple: 268, gray: 220 };

const geometryTimers = new Map();

const BRIDGE_TIMEOUT = 5000;

const windows = new Map();

let resolveTheme = () => 'dark';
let resolveStyle = () => 'default';
let resolveAccent = () => '';
let resolveRadius = () => 'default';
let resolveFonts = () => ({});
let resolveDataDir = () => '';
let resolveConfig = () => ({});

let getOwnerWindow = () => null;
let iconPath = path.join(__dirname, '..', '..', require('../../package.json').icon);

let handleWindowClosed = () => {};
let ipcRegistered = false;

let quitting = false;

let loadedDir = '';
let items = [];

function isStickyFeatureSupported() {
  return process.platform === 'win32';
}

function configureStickyNotes({ getTheme, getStyle, getAccent, getRadius, getFonts, getDataDir, getConfig, getOwner, icon, onClosed } = {}) {
  if (typeof getTheme === 'function') resolveTheme = getTheme;
  if (typeof getStyle === 'function') resolveStyle = getStyle;
  if (typeof getAccent === 'function') resolveAccent = getAccent;
  if (typeof getRadius === 'function') resolveRadius = getRadius;
  if (typeof getFonts === 'function') resolveFonts = getFonts;
  if (typeof getDataDir === 'function') resolveDataDir = getDataDir;
  if (typeof getConfig === 'function') resolveConfig = getConfig;
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

function readStickyConfig() {
  const config = safeResolve(resolveConfig, {}, '便利贴设置');
  const source = config && typeof config === 'object' && config.stickyNotes && typeof config.stickyNotes === 'object'
    ? config.stickyNotes
    : {};

  return {
    enabled: source.enabled !== false,
    color: COLOR_VALUES.includes(source.color) ? source.color : 'yellow'
  };
}

function stateFilePath() {
  return path.join(resolveDataDir(), STATE_FILE_NAME);
}

function randomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 10; index++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

function normalizeItem(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const id = typeof source.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(source.id.trim()) ? source.id.trim() : '';
  if (!id) return null;

  const kind = KIND_VALUES.includes(source.kind) ? source.kind : 'free';
  return {
    id,
    kind,

    refId: ['note', 'todo'].includes(kind) && typeof source.refId === 'string' ? source.refId.trim() : '',
    title: typeof source.title === 'string' ? source.title : '',
    content: typeof source.content === 'string' ? source.content : '',
    isDone: source.isDone === true,
    color: COLOR_VALUES.includes(source.color) ? source.color : 'yellow',

    readonly: source.readonly === true,

    hidden: source.hidden === true,
    x: Number.isFinite(Number(source.x)) ? Math.round(Number(source.x)) : null,
    y: Number.isFinite(Number(source.y)) ? Math.round(Number(source.y)) : null,
    width: clampNumber(source.width, MIN_WIDTH, 4000, DEFAULT_WIDTH),
    height: clampNumber(source.height, MIN_HEIGHT, 4000, DEFAULT_HEIGHT),
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : Date.now()
  };
}

function readItemsFromDisk(dir) {
  try {
    const file = path.join(dir, STATE_FILE_NAME);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = parsed && Array.isArray(parsed.items) ? parsed.items : [];
    const seen = new Set();
    const result = [];
    list.forEach((entry) => {
      const item = normalizeItem(entry);
      if (!item || seen.has(item.id)) return;
      seen.add(item.id);
      result.push(item);
    });
    return result;
  } catch (error) {
    console.error('[Esprin Nemo] 读取桌面便利贴记录失败:', error);
    return [];
  }
}

function ensureLoaded() {
  const dir = resolveDataDir();
  if (loadedDir === dir) return;
  loadedDir = dir;
  items = readItemsFromDisk(dir);
}

function writeState() {
  try {
    fs.mkdirSync(resolveDataDir(), { recursive: true });
    writeFileAtomic(stateFilePath(), JSON.stringify({ items }, null, 2));

    syncDesktopMenu();
    return true;
  } catch (error) {
    console.error('[Esprin Nemo] 保存桌面便利贴记录失败:', error);
    return false;
  }
}

function findItem(id) {
  ensureLoaded();
  return items.find((entry) => entry.id === id) || null;
}

function notifyMainWindowListChanged() {
  const win = getOwnerWindow();
  if (!win || win.isDestroyed()) return;
  if (!win.webContents || win.webContents.isDestroyed()) return;
  win.webContents.send('sticky:list-changed');
}

function patchItem(id, patch) {
  const item = findItem(id);
  if (!item || !patch || typeof patch !== 'object') return null;

  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    if (value === undefined) return;
    item[key] = value;
  });
  item.updatedAt = Date.now();
  writeState();
  return item;
}

const bridgePending = new Map();
let bridgeSeq = 0;

function askMainWindow(channel, payload) {
  const owner = ownerWindow();
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) {
    return Promise.resolve({ ok: false, reason: 'no-window' });
  }

  const contents = owner.webContents;

  return new Promise((resolve) => {
    const deliver = () => {
      if (contents.isDestroyed()) {
        resolve({ ok: false, reason: 'no-window' });
        return;
      }

      const id = ++bridgeSeq;
      const timer = setTimeout(() => {
        bridgePending.delete(id);
        resolve({ ok: false, reason: 'timeout' });
      }, BRIDGE_TIMEOUT);

      bridgePending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        timer
      });
      contents.send(channel, { ...(payload || {}), id });
    };

if (contents.isLoadingMainFrame() || !contents.getURL()) contents.once('did-finish-load', deliver);
    else deliver();
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

function ownerWindow() {
  const owner = getOwnerWindow();
  return owner && !owner.isDestroyed() ? owner : null;
}

function workArea() {
  const owner = ownerWindow();
  if (owner) {
    try {
      return screen.getDisplayMatching(owner.getBounds()).workArea;
    } catch (error) {

    }
  }
  return screen.getPrimaryDisplay().workArea;
}

function spawnBounds() {
  const area = workArea();
  const step = (items.length % SPAWN_WRAP) * SPAWN_STEP;
  const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, area.width - SPAWN_MARGIN * 2));
  const height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, area.height - SPAWN_MARGIN * 2));

  return {
    width,
    height,
    x: Math.round(Math.min(area.x + SPAWN_MARGIN + step, area.x + Math.max(0, area.width - width - 8))),
    y: Math.round(Math.min(area.y + SPAWN_MARGIN + step, area.y + Math.max(0, area.height - height - 8)))
  };
}

function boundsForItem(item) {
  const fallback = spawnBounds();
  const width = clampNumber(item.width, MIN_WIDTH, 4000, fallback.width);
  const height = clampNumber(item.height, MIN_HEIGHT, 4000, fallback.height);
  if (item.x === null || item.y === null) return { ...fallback, width, height };

  const rect = { x: item.x, y: item.y, width, height };
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return rect.x < area.x + area.width && rect.x + rect.width > area.x
      && rect.y < area.y + area.height && rect.y + rect.height > area.y;
  });
  return visible ? rect : { ...fallback, width, height };
}

function applyStickyWindowTraits(win) {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(false);
  if (typeof win.setSkipTaskbar === 'function') win.setSkipTaskbar(true);
}

function saveGeometryNow(id, win) {
  if (geometryTimers.has(id)) {
    clearTimeout(geometryTimers.get(id));
    geometryTimers.delete(id);
  }
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  patchItem(id, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}

function flushAllGeometries() {
  windows.forEach((win, id) => {
    saveGeometryNow(id, win);
  });
}

function scheduleGeometryWrite(id, win) {
  if (geometryTimers.has(id)) clearTimeout(geometryTimers.get(id));
  geometryTimers.set(id, setTimeout(() => {
    geometryTimers.delete(id);
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    patchItem(id, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }, 250));
}

function itemSnapshot(item) {
  return {
    id: item.id,
    kind: item.kind,
    refId: item.refId,
    title: item.title,
    content: item.content,
    isDone: item.isDone,
    color: item.color,
    hue: COLOR_HUES[item.color] || COLOR_HUES.yellow,
    readonly: item.readonly === true
  };
}

function createWindowForItem(item) {
  if (windows.has(item.id)) {
    showStickyNote(item.id);
    return windows.get(item.id);
  }

  const appearance = currentAppearance();
  const win = new BrowserWindow({
    ...boundsForItem(item),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: '桌面便利贴',

    alwaysOnTop: false,
    backgroundColor: appearance.backgroundColor,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      additionalArguments: [...appearance.args, `${ITEM_ID_ARG}${item.id}`, `${DATA_DIR_ARG}${resolveDataDir()}`]
    }
  });

  windows.set(item.id, win);
  applyStickyWindowTraits(win);
  keepDesktopLevel(win);
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {

    win.showInactive();
    setDesktopLevel(win);
  });

win.on('close', (event) => {
    if (quitting || !findItem(item.id)) return;
    event.preventDefault();
    if (!win.webContents.isDestroyed()) win.webContents.send('sticky:request-close');
  });

  win.on('moved', () => scheduleGeometryWrite(item.id, win));
  win.on('resized', () => scheduleGeometryWrite(item.id, win));

  win.once('closed', () => {
    windows.delete(item.id);
    if (geometryTimers.has(item.id)) {
      clearTimeout(geometryTimers.get(item.id));
      geometryTimers.delete(item.id);
    }

    if (findItem(item.id)) patchItem(item.id, { hidden: true });
    handleWindowClosed();
  });

  win.loadFile(STICKY_HTML).catch((error) => {
    console.error('[Esprin Nemo] 加载桌面便利贴页面失败:', error);
    if (!win.isDestroyed()) win.destroy();
  });

  return win;
}

function showStickyNote(id) {
  const win = windows.get(id);
  if (!win || win.isDestroyed()) return false;
  patchItem(id, { hidden: false });
  if (win.isMinimized()) win.restore();
  win.showInactive();
  setDesktopLevel(win);
  return true;
}

function closeStickyNote(id) {
  if (!isStickyFeatureSupported()) return { ok: false, reason: 'disabled' };
  ensureLoaded();
  items = items.filter((entry) => entry.id !== id);
  writeState();

  const win = windows.get(id);

  if (win && !win.isDestroyed()) win.destroy();
  else handleWindowClosed();
  notifyMainWindowListChanged();
  return { ok: true };
}

function isStickyNoteOpen() {
  if (!isStickyFeatureSupported()) return false;
  for (const win of windows.values()) {
    if (!win.isDestroyed() && win.isVisible()) return true;
  }
  return false;
}

function listStickyNotes() {
  if (!isStickyFeatureSupported()) return [];
  ensureLoaded();
  return items.map((item) => ({ id: item.id, title: String(item.title || '') }));
}

function revealStickyNote(id) {
  if (!isStickyFeatureSupported()) return false;
  const item = findItem(id);
  if (!item) return false;

  const win = windows.get(id);
  if (!win || win.isDestroyed()) {
    createWindowForItem({ ...item, hidden: false });
    return true;
  }
  return showStickyNote(id);
}

function showAllStickyNotes() {
  if (!isStickyFeatureSupported()) return 0;

  if (!readStickyConfig().enabled) return 0;

  ensureLoaded();
  let shown = 0;
  items.forEach((item) => {
    const win = windows.get(item.id);
    if (win && !win.isDestroyed()) {
      showStickyNote(item.id);
      shown++;
      return;
    }
    createWindowForItem({ ...item, hidden: false });
    shown++;
  });
  return shown;
}

function hideAllStickyNotes() {
  if (!isStickyFeatureSupported()) return 0;
  let hidden = 0;
  windows.forEach((win, id) => {
    patchItem(id, { hidden: true });
    if (!win.isDestroyed()) win.hide();
    hidden++;
  });

  handleWindowClosed();
  return hidden;
}

function createStickyNote(payload = {}) {
  if (!isStickyFeatureSupported()) return { ok: false, reason: 'disabled' };
  const config = readStickyConfig();
  if (!config.enabled) return { ok: false, reason: 'disabled' };

  ensureLoaded();
  const kind = KIND_VALUES.includes(payload.kind) ? payload.kind : 'free';
  const refId = kind === 'free' ? '' : String(payload.refId || '').trim();

if (refId) {
    const existing = items.find((entry) => entry.refId === refId);
    if (existing) {
      showStickyNote(existing.id);
      return { ok: true, id: existing.id, shown: true };
    }
  }

  const item = {
    id: randomId(),
    kind,
    refId,
    title: typeof payload.title === 'string' ? payload.title : '',
    content: typeof payload.content === 'string' ? payload.content : '',
    isDone: payload.isDone === true,
    color: COLOR_VALUES.includes(payload.color) ? payload.color : config.color,
    readonly: false,
    hidden: false,
    x: null,
    y: null,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  items.push(item);
  writeState();
  createWindowForItem(item);
  notifyMainWindowListChanged();
  return { ok: true, id: item.id };
}

function restoreStickyNotes() {
  if (!isStickyFeatureSupported()) return 0;
  const config = readStickyConfig();
  if (!config.enabled) return 0;

  ensureLoaded();
  const visible = items.filter((entry) => !entry.hidden);
  visible.forEach((item) => createWindowForItem(item));
  if (visible.length) {
    console.log(`[INFO] [StickyNotes] Restored ${visible.length} desktop note(s)`);
  }
  return visible.length;
}

function updateStickyNoteAppearance(payload) {
  const appearance = buildWindowAppearance(payload);
  windows.forEach((win) => {
    if (win.isDestroyed()) return;
    try {
      win.setBackgroundColor(appearance.backgroundColor);
    } catch (error) {

    }
    if (win.webContents.isDestroyed()) return;
    win.webContents.send('sticky:appearance', {
      theme: appearance.theme,
      style: appearance.style,
      radius: appearance.radius,
      accent: appearance.accent,
      fonts: appearance.fonts
    });
  });
}

function broadcastItemChanged(itemId, detail) {
  ensureLoaded();
  items
    .filter((entry) => entry.refId && entry.refId === itemId)
    .forEach((entry) => {
      const win = windows.get(entry.id);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send('sticky:item', detail);
    });
}

function idFromSender(event) {
  const sender = event && event.sender;
  if (!sender) return '';
  for (const [id, win] of windows) {
    if (!win.isDestroyed() && win.webContents === sender) return id;
  }
  return '';
}

async function fetchBoundItem(item) {
  if (!item.refId) return { ok: false, reason: 'unbound' };
  const reply = await askMainWindow('sticky:get-item', { itemId: item.refId });
  if (!reply.ok || !reply.item) return { ok: false, reason: reply.reason || 'missing' };
  return { ok: true, item: reply.item };
}

async function loadStickyNote(id) {
  const item = findItem(id);
  if (!item) return { ok: false, reason: 'missing' };

  if (!item.refId) return { ok: true, sticky: itemSnapshot(item), bound: false };

  const fetched = await fetchBoundItem(item);
  if (!fetched.ok) {

    if (fetched.reason === 'no-window' || fetched.reason === 'timeout') {
      return { ok: true, sticky: itemSnapshot(item), bound: true, reason: fetched.reason };
    }

patchItem(id, { refId: '', kind: 'free', readonly: false });
    return { ok: true, sticky: itemSnapshot(findItem(id)), bound: false, reason: fetched.reason };
  }

  const bound = fetched.item;
  const readonly = bound.readonly === true;
  patchItem(id, {
    title: bound.title || '',
    content: bound.content || '',
    isDone: bound.isDone === true,
    readonly
  });
  return { ok: true, sticky: itemSnapshot(findItem(id)), bound: true };
}

async function saveStickyNote(id, payload) {
  const item = findItem(id);
  if (!item) return { ok: false, reason: 'missing' };

  const title = typeof payload.title === 'string' ? payload.title : item.title;
  const content = typeof payload.content === 'string' ? payload.content : item.content;
  const isDone = payload.isDone === undefined ? item.isDone : payload.isDone === true;

  patchItem(id, { title, content, isDone });
  if (!item.refId) return { ok: true, readonly: false };

  const reply = await askMainWindow('sticky:save-item', { itemId: item.refId, title, content, isDone });
  if (reply.ok) {
    const readonly = reply.readonly === true;
    patchItem(id, { readonly });
    return { ok: true, readonly };
  }

if (reply.reason === 'missing') {
    patchItem(id, { refId: '', kind: 'free', readonly: false });
    return { ok: true, reason: 'missing', readonly: false };
  }
  return { ok: false, reason: reply.reason || 'failed' };
}

async function toggleStickyDone(id, done) {
  const item = findItem(id);
  if (!item) return { ok: false, reason: 'missing' };

  const next = done === undefined ? !item.isDone : done === true;
  patchItem(id, { isDone: next });
  if (!item.refId) return { ok: true, isDone: next };

  const reply = await askMainWindow('sticky:toggle-done', { itemId: item.refId, isDone: next });
  if (!reply.ok) return { ok: false, reason: reply.reason || 'failed', isDone: item.isDone };

  patchItem(id, { isDone: reply.isDone === true });
  return { ok: true, isDone: reply.isDone === true };
}

function registerStickyNotesIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

ipcMain.handle('sticky:create', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    return createStickyNote(data);
  });

  ipcMain.handle('sticky:list', () => {
    ensureLoaded();
    return {
      enabled: readStickyConfig().enabled,
      items: items.map((item) => ({ ...itemSnapshot(item), windowOpen: windows.has(item.id) }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    };
  });

  ipcMain.handle('sticky:show-all', () => ({ ok: true, count: showAllStickyNotes() }));
  ipcMain.handle('sticky:hide-all', () => ({ ok: true, count: hideAllStickyNotes() }));

  ipcMain.handle('sticky:clear-all', () => {
    ensureLoaded();
    const ids = items.map((item) => item.id);
    ids.forEach((id) => closeStickyNote(id));
    return { ok: true, count: ids.length };
  });

ipcMain.handle('sticky:set-enabled', (event, payload) => {
    const enabled = !(payload && payload.enabled === false);
    if (enabled) return { ok: true, enabled: true, count: showAllStickyNotes() };
    return { ok: true, enabled: false, count: hideAllStickyNotes() };
  });

ipcMain.handle('sticky:resolve', (event) => {
    const id = idFromSender(event);
    return id ? loadStickyNote(id) : { ok: false, reason: 'missing' };
  });

  ipcMain.handle('sticky:save', (event, payload) => {
    const id = idFromSender(event);
    if (!id) return { ok: false, reason: 'missing' };
    return saveStickyNote(id, payload && typeof payload === 'object' ? payload : {});
  });

  ipcMain.handle('sticky:toggle-done', (event, payload) => {
    const id = idFromSender(event);
    const data = payload && typeof payload === 'object' ? payload : {};
    if (!id) return { ok: false, reason: 'missing' };
    return toggleStickyDone(id, data.isDone);
  });

  ipcMain.handle('sticky:set-color', (event, payload) => {
    const id = idFromSender(event);
    const data = payload && typeof payload === 'object' ? payload : {};
    if (!id) return { ok: false, reason: 'missing' };
    if (!COLOR_VALUES.includes(data.color)) return { ok: false, reason: 'invalid' };
    patchItem(id, { color: data.color });
    return { ok: true, color: data.color, hue: COLOR_HUES[data.color] };
  });

  ipcMain.handle('sticky:close', (event) => {
    const id = idFromSender(event);
    return id ? closeStickyNote(id) : { ok: false, reason: 'missing' };
  });

ipcMain.on('sticky:reply', (event, payload) => resolveBridgeReply(payload));

ipcMain.on('sticky:raise', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) raiseAboveDesktop(win);
  });

ipcMain.on('sticky:keep-bottom', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) setDesktopLevel(win);
  });

ipcMain.on('sticky:appearance', (event, payload) => updateStickyNoteAppearance(payload));
  ipcMain.on('sticky:item-changed', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const itemId = typeof data.itemId === 'string' ? data.itemId : '';
    if (!itemId) return;

const detail = { itemId, exists: data.exists !== false, readonly: data.readonly === true };
    if (data.exists !== false) {
      detail.title = typeof data.title === 'string' ? data.title : '';
      detail.content = typeof data.content === 'string' ? data.content : '';
      detail.isDone = data.isDone === true;
    }
    broadcastItemChanged(itemId, detail);
  });

ipcMain.on('sticky:flush', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id) return;
    saveStickyNote(id, data).catch((error) => {
      console.error('[Esprin Nemo] 便利贴关窗保存失败:', error);
    });
  });
}

function releaseStickyNotes() {
  quitting = true;
  flushAllGeometries();
}

module.exports = {
  configureStickyNotes,
  registerStickyNotesIpc,
  closeStickyNote,
  createStickyNote,
  flushAllGeometries,
  hideAllStickyNotes,
  isStickyNoteOpen,
  listStickyNotes,
  releaseStickyNotes,
  restoreStickyNotes,
  revealStickyNote,
  showAllStickyNotes,
  showStickyNote
};