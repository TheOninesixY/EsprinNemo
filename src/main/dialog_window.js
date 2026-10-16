const { BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const { buildWindowAppearance, safeResolve } = require('./window_appearance.js');

const DIALOG_HTML = path.join(__dirname, '..', 'renderer', 'dialog.html');

const TYPE_ICONS = { info: 'info', question: 'help', warning: 'warning', error: 'error' };

const MIN_WIDTH = 300;
const MAX_WIDTH = 640;

const MIN_HEIGHT = 150;

const MAX_HEIGHT = 720;

const MAX_TIMEOUT = 120000;

const REVEAL_DELAY = 90;

const entries = new Map();

let resolveTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

let resolveAccent = () => '';

let resolveBrandColor = () => 'brand';

let resolveRadius = () => 'default';

let resolveStyle = () => 'default';

let resolveFonts = () => ({});
let iconPath = path.join(__dirname, '..', '..', require('../../package.json').icon);
let ipcRegistered = false;

function configureDialogWindows({ getTheme, getStyle, getAccent, getBrandColor, getRadius, getFonts, icon } = {}) {
  if (typeof getTheme === 'function') resolveTheme = getTheme;
  if (typeof getStyle === 'function') resolveStyle = getStyle;
  if (typeof getAccent === 'function') resolveAccent = getAccent;
  if (typeof getBrandColor === 'function') resolveBrandColor = getBrandColor;
  if (typeof getRadius === 'function') resolveRadius = getRadius;
  if (typeof getFonts === 'function') resolveFonts = getFonts;
  if (typeof icon === 'string' && icon) iconPath = icon;
}

function currentAppearance() {
  return buildWindowAppearance({
    theme: safeResolve(resolveTheme, 'dark', '主题'),
    style: safeResolve(resolveStyle, 'default', '主题风格'),
    accent: safeResolve(resolveAccent, '', '主题色'),
    brandColor: safeResolve(resolveBrandColor, 'brand', '应用名颜色'),
    radius: safeResolve(resolveRadius, 'default', '圆角尺度'),
    fonts: safeResolve(resolveFonts, {}, '字体')
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function buttonVariant(value) {
  return value === 'primary' || value === 'danger' ? value : 'default';
}

function normalizeInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') return null;

  const choices = [];
  if (Array.isArray(rawInput.choices)) {
    rawInput.choices.forEach((item) => {
      const text = typeof item === 'string' ? item : (item && typeof item.value === 'string' ? item.value : '');
      const value = text.trim();
      if (value && !choices.includes(value)) choices.push(value);
    });
  }

  const selected = [];
  if (Array.isArray(rawInput.selected)) {
    rawInput.selected.forEach((item) => {
      const value = typeof item === 'string' ? item.trim() : '';
      if (value && choices.includes(value) && !selected.includes(value)) selected.push(value);
    });
  }

  return {
    value: rawInput.value == null ? '' : String(rawInput.value),
    placeholder: rawInput.placeholder == null ? '' : String(rawInput.placeholder),
    label: rawInput.label == null ? '' : String(rawInput.label),

    type: rawInput.type === 'password' ? 'password' : 'text',
    choices,
    selected,
    multiple: rawInput.multiple !== false
  };
}

function normalizeCheckbox(rawCheckbox) {
  if (!rawCheckbox || typeof rawCheckbox !== 'object') return null;
  const label = rawCheckbox.label == null ? '' : String(rawCheckbox.label);
  if (!label.trim()) return null;
  return { label, checked: !!rawCheckbox.checked };
}

function normalizeOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const rawButtons = Array.isArray(source.buttons) && source.buttons.length
    ? source.buttons
    : [{ label: '确定' }];
  const buttons = rawButtons.map((item, index) => {
    const button = item && typeof item === 'object' ? item : { label: item };
    return {
      id: typeof button.id === 'string' && button.id ? button.id : `btn-${index}`,
      label: button.label == null ? '确定' : String(button.label),
      variant: buttonVariant(button.variant),
      cancel: !!button.cancel,
      isDefault: !!button.default
    };
  });

  let defaultIndex = buttons.findIndex((button) => button.isDefault);
  if (defaultIndex === -1) defaultIndex = buttons.findIndex((button) => button.variant !== 'default');
  if (defaultIndex === -1) defaultIndex = 0;

  let cancelIndex = buttons.findIndex((button) => button.cancel);
  if (cancelIndex === -1) cancelIndex = buttons.length - 1;

  const type = TYPE_ICONS[source.type] ? source.type : 'info';
  const input = normalizeInput(source.input);

  return {
    title: source.title == null ? '' : String(source.title),
    message: source.message == null ? '' : String(source.message),
    detail: source.detail == null ? '' : String(source.detail),
    type,
    icon: typeof source.icon === 'string' && source.icon ? source.icon : TYPE_ICONS[type],
    width: clamp(Math.round(Number(source.width) || 420), MIN_WIDTH, MAX_WIDTH),
    buttons: buttons.map(({ id, label, variant }) => ({ id, label, variant })),
    defaultIndex,
    cancelIndex,
    cancelId: buttons[cancelIndex].id,
    input,
    checkbox: normalizeCheckbox(source.checkbox),

    timeoutMs: clamp(Math.round(Number(source.timeoutMs) || 0), 0, MAX_TIMEOUT)
  };
}

function estimateHeight(options) {
  const TITLEBAR = 40;
  const BODY_PADDING = 38;
  const ROW_GAP = 16;
  const MESSAGE_LINE = 20;
  const DETAIL_LINE = 18;
  const INPUT_FIELD = 35;
  const ACTION_ROW = 30;

  const messageLines = Math.max(1, Math.ceil(options.message.length / 24));
  let headHeight = Math.max(22, messageLines * MESSAGE_LINE);
  if (options.detail) {
    const detailLines = options.detail
      .split('\n')
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 34)), 0);
    headHeight += 6 + clamp(detailLines, 1, 8) * DETAIL_LINE;
  }

  const rows = [headHeight + (options.timeoutMs ? 6 + DETAIL_LINE : 0)];
  if (options.input) {
    let fieldHeight = INPUT_FIELD;
    if (options.input.choices.length) {
      fieldHeight += 8 + Math.ceil(options.input.choices.length / 4) * 26;
    }
    rows.push(fieldHeight);
  }
  if (options.checkbox) {
    rows.push(Math.max(1, Math.ceil(options.checkbox.label.length / 34)) * 19 + 4);
  }
  rows.push(ACTION_ROW);

  const height = TITLEBAR + BODY_PADDING
    + rows.reduce((total, row) => total + row, 0)
    + ROW_GAP * (rows.length - 1);
  return clamp(height, MIN_HEIGHT, MAX_HEIGHT);
}

function centerOver(win, owner) {
  if (!owner || owner.isDestroyed()) {
    win.center();
    return;
  }
  const ownerBounds = owner.getBounds();
  const bounds = win.getBounds();
  win.setPosition(
    Math.round(ownerBounds.x + (ownerBounds.width - bounds.width) / 2),
    Math.round(ownerBounds.y + (ownerBounds.height - bounds.height) / 2)
  );
}

function canceledResult(entry) {
  const { buttons, cancelIndex, checkbox } = entry.options;
  const button = buttons[cancelIndex] || buttons[buttons.length - 1];
  return {
    id: button ? button.id : 'cancel',
    index: cancelIndex,
    value: '',
    selected: [],

    checked: !!(checkbox && checkbox.checked),
    dismissed: true
  };
}

function revealDialog(entry) {
  if (entry.settled || entry.revealed || entry.win.isDestroyed()) return;
  entry.revealed = true;
  centerOver(entry.win, entry.owner);
  entry.win.show();
  entry.win.focus();
  armTimeout(entry);
}

function armTimeout(entry) {
  const ms = entry.options.timeoutMs;
  if (!ms || entry.timeoutTimer) return;
  entry.timeoutTimer = setTimeout(() => {
    entry.timeoutTimer = null;
    finishDialog(entry, canceledResult(entry));
  }, ms);
}

function finishDialog(entry, result) {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.timeoutTimer) {
    clearTimeout(entry.timeoutTimer);
    entry.timeoutTimer = null;
  }
  entries.delete(entry.wsId);
  if (entry.owner && entry.onOwnerClosed) {
    entry.owner.removeListener('closed', entry.onOwnerClosed);
  }
  if (!entry.win.isDestroyed()) entry.win.destroy();
  entry.resolve(result);
}

function showDialogWindow(owner, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const parentWin = owner && !owner.isDestroyed() ? owner : null;

  const appearance = currentAppearance();

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: options.width,
      height: estimateHeight(options),
      useContentSize: true,
      parent: parentWin || undefined,
      modal: !!parentWin,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: appearance.backgroundColor,
      icon: iconPath,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        additionalArguments: appearance.args
      }
    });

    const entry = {
      win,
      wsId: win.webContents.id,
      owner: parentWin,
      options,
      resolve,
      settled: false,
      revealed: false,
      timeoutTimer: null,
      onOwnerClosed: null
    };
    entries.set(entry.wsId, entry);

if (parentWin) {
      entry.onOwnerClosed = () => finishDialog(entry, canceledResult(entry));
      parentWin.once('closed', entry.onOwnerClosed);
    }

    win.webContents.once('did-finish-load', () => {
      setTimeout(() => revealDialog(entry), REVEAL_DELAY);
    });
    win.webContents.on('render-process-gone', () => finishDialog(entry, canceledResult(entry)));
    win.once('closed', () => {
      entries.delete(entry.wsId);
      if (!entry.settled) {
        entry.settled = true;
        resolve(canceledResult(entry));
      }
    });

    win.loadFile(DIALOG_HTML).catch((error) => {
      console.error('[Esprin Nemo] 加载弹窗页面失败:', error);
      finishDialog(entry, canceledResult(entry));
    });
  });
}

function handleRespond(event, payload) {
  const entry = entries.get(event.sender.id);
  if (!entry || entry.settled) return;

  const data = payload && typeof payload === 'object' ? payload : {};
  const { buttons, cancelIndex } = entry.options;
  let index = typeof data.id === 'string' ? buttons.findIndex((button) => button.id === data.id) : -1;
  if (index === -1) index = cancelIndex;

  finishDialog(entry, {
    id: buttons[index].id,
    index,
    value: typeof data.value === 'string' ? data.value : '',
    selected: Array.isArray(data.selected) ? data.selected.filter((item) => typeof item === 'string') : [],
    checked: !!data.checked,
    dismissed: !!data.dismissed
  });
}

function registerDialogIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

ipcMain.handle('dialog:get-options', (event) => {
    const entry = entries.get(event.sender.id);
    return entry ? entry.options : null;
  });

ipcMain.on('dialog:resize', (event, payload) => {
    const entry = entries.get(event.sender.id);
    if (!entry || entry.settled || entry.win.isDestroyed()) return;
    const height = clamp(Math.round(Number(payload && payload.height) || 0), MIN_HEIGHT, MAX_HEIGHT);
    const [width] = entry.win.getContentSize();
    entry.win.setContentSize(width, height);
    if (entry.revealed) centerOver(entry.win, entry.owner);
  });

  ipcMain.on('dialog:respond', handleRespond);

ipcMain.handle('dialog:message', (event, rawOptions) => {
    return showDialogWindow(BrowserWindow.fromWebContents(event.sender), rawOptions);
  });
}

module.exports = {
  configureDialogWindows,
  registerDialogIpc,
  showDialogWindow
};
