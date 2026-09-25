// 窗口式消息弹窗（alert / confirm / prompt）：
// 每个弹窗都是独立的无边框 BrowserWindow，标题栏与主窗口一致（自绘品牌名 + 自绘按钮），
// 不再使用系统原生消息框，也不使用渲染进程内叠加的"假弹窗"。
const { BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const { buildWindowAppearance, safeResolve } = require('./window_appearance.js');

// 弹窗页面与主窗口同属渲染进程资源，位于 ../renderer/
const DIALOG_HTML = path.join(__dirname, '..', 'renderer', 'dialog.html');

// 弹窗类型 -> 默认图标（Material Symbols 名称）
const TYPE_ICONS = { info: 'info', question: 'help', warning: 'warning', error: 'error' };

const MIN_WIDTH = 300;
const MAX_WIDTH = 640;
// 最小高度至少要放得下标题栏 + 内容内边距 + 一行消息 + 按钮行
const MIN_HEIGHT = 150;
// 高度上限，与 dialog.html 里的 MAX_CONTENT_HEIGHT 保持一致
const MAX_HEIGHT = 720;
// 自动关闭时长的上限（毫秒）：防止误传一个极大的值把弹窗钉在屏幕上
const MAX_TIMEOUT = 120000;
// 显示前等待渲染进程回传内容高度的时间，避免出现"先小后大"的尺寸跳动
const REVEAL_DELAY = 90;

const entries = new Map(); // webContents.id -> entry

let resolveTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
// 主题色（#RRGGBB）：空字符串表示沿用 dialog.html 样式表里的默认强调色
let resolveAccent = () => '';
// 应用名文字颜色模式：brand / mono / accent，非法值回退为品牌色
let resolveBrandColor = () => 'brand';
// 圆角尺度：square / slight / default / large，非法值回退为默认
let resolveRadius = () => 'default';
// 主题风格（皮肤）：alom 为 Alom 风格，弹窗与主窗口用同一套配色
let resolveStyle = () => 'default';
// 字体：与主窗口一样的 { uiLatin, uiCjk, docLatin, docCjk }
let resolveFonts = () => ({});
let iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
let ipcRegistered = false;

// 由 main.js 注入主题解析与图标路径（主题需要读取用户数据目录中的 config.json）
function configureDialogWindows({ getTheme, getStyle, getAccent, getBrandColor, getRadius, getFonts, icon } = {}) {
  if (typeof getTheme === 'function') resolveTheme = getTheme;
  if (typeof getStyle === 'function') resolveStyle = getStyle;
  if (typeof getAccent === 'function') resolveAccent = getAccent;
  if (typeof getBrandColor === 'function') resolveBrandColor = getBrandColor;
  if (typeof getRadius === 'function') resolveRadius = getRadius;
  if (typeof getFonts === 'function') resolveFonts = getFonts;
  if (typeof icon === 'string' && icon) iconPath = icon;
}

// 当前外观：取值交给注入的读取函数，换算与参数拼装交给 window_appearance.js，
// 与小本本窗口、三个窗口的渲染端用的是同一套逻辑（选 Alom 风格后弹窗不再是另一副长相）
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

// 输入框配置：文本 / 占位符 / 标签，外加可选的候选项列表
// 候选项以气泡形式显示在输入框下方，multiple 为 true 时支持多选（结果回传在 selected 里）
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
    // 输入框类型：只认 password（口令输入），其余一律按普通文本框处理
    type: rawInput.type === 'password' ? 'password' : 'text',
    choices,
    selected,
    multiple: rawInput.multiple !== false
  };
}

// 勾选框配置：label 为说明文字（为空则视为没有勾选框），checked 为初始勾选状态。
// 结果通过 resolve 回传的 checked 字段取回，与 input 并列。
function normalizeCheckbox(rawCheckbox) {
  if (!rawCheckbox || typeof rawCheckbox !== 'object') return null;
  const label = rawCheckbox.label == null ? '' : String(rawCheckbox.label);
  if (!label.trim()) return null;
  return { label, checked: !!rawCheckbox.checked };
}

// 规范化调用方传入的弹窗参数，保证渲染进程拿到的一定是完整、可用的结构
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
    // 自动关闭时长：0 表示一直等用户回应（与 requestResize 高度估算里的倒计时行对应）
    timeoutMs: clamp(Math.round(Number(source.timeoutMs) || 0), 0, MAX_TIMEOUT)
  };
}

// 根据文字量粗略估算初始高度，显示前会由渲染进程量得的真实高度覆盖。
// 各行高度、内边距与行间距都按 dialog.html 里的实际取值来算：估算偏小会让首屏出现
// 「底部被裁、按钮贴着窗口下沿」的观感，所以宁可略高一点。
function estimateHeight(options) {
  const TITLEBAR = 40;      // .titlebar
  const BODY_PADDING = 38;  // .dialog-body 上下内边距（20 + 18）
  const ROW_GAP = 16;       // .dialog-body 的行间距
  const MESSAGE_LINE = 20;  // 消息：13px 字号 × 1.5 行高
  const DETAIL_LINE = 18;   // 详情：12px 字号 × 1.6 行高，与消息之间还有 6px
  const INPUT_FIELD = 35;   // 输入框：8px 内边距 ×2 + 13px 文字 + 上下边框
  const ACTION_ROW = 30;    // 按钮行：6px 内边距 ×2 + 12px 文字

  const messageLines = Math.max(1, Math.ceil(options.message.length / 24));
  let headHeight = Math.max(22, messageLines * MESSAGE_LINE); // 图标与文字取较高者
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
      fieldHeight += 8 + Math.ceil(options.input.choices.length / 4) * 26; // 候选项气泡大致占用的行数
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
    // 窗口被系统收掉这类极端情况下取不到页面里的实际勾选状态，回退为初始状态
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

/* 自动关闭（timeoutMs）：给「改了要确认、超时就回退」这类设置用（见 renderer 的自定义界面尺寸）。
   计时从窗口真正显示开始：用户此时能看见它和它自己的倒计时，到点没回应就按取消处理。 */
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

// 打开一个窗口式弹窗，返回 Promise<{ id, index, value, selected, checked, dismissed }>
function showDialogWindow(owner, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const parentWin = owner && !owner.isDestroyed() ? owner : null;
  // 外观一次算完：一组用于窗口底色兜底，另一组经命令行参数注入页面，首屏渲染前就能应用
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

    // 主窗口关闭时同步收掉弹窗，避免留下孤儿窗口
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

  // 弹窗页面启动时取回自己的参数
  ipcMain.handle('dialog:get-options', (event) => {
    const entry = entries.get(event.sender.id);
    return entry ? entry.options : null;
  });

  // 弹窗页面量好内容高度后调整窗口尺寸（渲染进程无法直接改窗口大小）
  ipcMain.on('dialog:resize', (event, payload) => {
    const entry = entries.get(event.sender.id);
    if (!entry || entry.settled || entry.win.isDestroyed()) return;
    const height = clamp(Math.round(Number(payload && payload.height) || 0), MIN_HEIGHT, MAX_HEIGHT);
    const [width] = entry.win.getContentSize();
    entry.win.setContentSize(width, height);
    if (entry.revealed) centerOver(entry.win, entry.owner);
  });

  ipcMain.on('dialog:respond', handleRespond);

  // 渲染进程侧的统一入口：ipcRenderer.invoke('dialog:message', options)
  ipcMain.handle('dialog:message', (event, rawOptions) => {
    return showDialogWindow(BrowserWindow.fromWebContents(event.sender), rawOptions);
  });
}

module.exports = {
  configureDialogWindows,
  registerDialogIpc,
  showDialogWindow
};
