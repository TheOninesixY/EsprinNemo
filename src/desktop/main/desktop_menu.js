const { app, nativeImage } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MENU_KEY = 'Software\\Classes\\DesktopBackground\\Shell\\EsprinNemoStickies';
const MENU_KEY_FULL = `HKEY_CURRENT_USER\\${MENU_KEY}`;

const ITEMS_KEY = 'Software\\Classes\\EsprinNemoStickyMenu';
const ITEMS_KEY_FULL = `HKEY_CURRENT_USER\\${ITEMS_KEY}`;
const ITEMS_KEY_NAME = 'EsprinNemoStickyMenu';
const MENU_LABEL = 'EsprinNemo 便利贴';

const ACTION_PREFIX = '--sticky-action=';
const ID_PREFIX = '--sticky-id=';

const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
const TEMP_FILE_NAME = 'esprin_nemo_sticky_menu.reg';

const MENU_ICON_NAME = 'sticky_menu.ico';
const ICON_SIZE = 256;

const ICON_SMALL_SIZE = 32;

const LABEL_MAX = 40;

const SYNC_DELAY = 600;

const UNTITLED = '未命名便利贴';

let enabled = false;
let timer = null;

let lastSignature = null;

let appIconPath = '';

let menuIcon = null;

let getItems = () => [];
let onAction = () => {};

function isSupported() {
  if (process.platform !== 'win32') return false;
  return fs.existsSync(REG_EXE);
}

function launchTarget() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  }
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [app.getAppPath()] };
}

function buildIco(images, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length + images.length * 16;
  const entries = images.map((data, index) => {
    const size = sizes[index];
    const entry = Buffer.alloc(16);

    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images]);
}

function ensureMenuIcon() {
  if (menuIcon !== null) return menuIcon;
  menuIcon = '';

  if (!appIconPath || !fs.existsSync(appIconPath)) return menuIcon;

  try {
    const image = nativeImage.createFromPath(appIconPath);
    if (image.isEmpty()) return menuIcon;

    const sizes = [ICON_SMALL_SIZE, ICON_SIZE];
    const images = sizes.map((size) => image.resize({ width: size, height: size }).toPNG());
    const file = path.join(app.getPath('userData'), MENU_ICON_NAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildIco(images, sizes));
    menuIcon = file;
  } catch (error) {
    console.error('[Desktop:ERROR] 生成菜单图标失败:', error);
  }
  return menuIcon;
}

function menuIconValue() {
  const icon = ensureMenuIcon();
  return icon || `${launchTarget().exe},0`;
}

function regEscape(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function quoteArg(value) {
  const text = String(value == null ? '' : value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function commandLine(extraArgs) {
  const target = launchTarget();
  return [quoteArg(target.exe), ...target.args.map(quoteArg), ...extraArgs].join(' ');
}
function menuLabel(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return UNTITLED;
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

function buildRegFile(items) {
  const lines = [
    'Windows Registry Editor Version 5.00',
    '',
    `[-${MENU_KEY_FULL}]`,
    `[-${ITEMS_KEY_FULL}]`,
    '',
    `[${MENU_KEY_FULL}]`,
    `@="${regEscape(MENU_LABEL)}"`,
    `"MUIVerb"="${regEscape(MENU_LABEL)}"`,
    `"Icon"="${regEscape(menuIconValue())}"`,
    '"Position"="Bottom"',
    `"ExtendedSubCommandsKey"="${ITEMS_KEY_NAME}"`
  ];

  const entries = [
    { verb: '01-new', label: '贴上便利贴', args: [`${ACTION_PREFIX}pick`] }
  ];
  items.forEach((item, index) => {
    entries.push({
      verb: `20-${String(index + 1).padStart(3, '0')}-${item.id}`,
      label: menuLabel(item.title),
      args: [`${ACTION_PREFIX}show`, `${ID_PREFIX}${item.id}`]
    });
  });
  items.forEach((item, index) => {
    entries.push({
      verb: `30-${String(index + 1).padStart(3, '0')}-${item.id}`,
      label: `关闭「${menuLabel(item.title)}」`,
      args: [`${ACTION_PREFIX}close`, `${ID_PREFIX}${item.id}`]
    });
  });
  entries.push({ verb: '90-show-all', label: '全部显示', args: [`${ACTION_PREFIX}show-all`] });
  entries.push({ verb: '91-hide-all', label: '全部收起', args: [`${ACTION_PREFIX}hide-all`] });

  entries.forEach((entry) => {
    const base = `${ITEMS_KEY_FULL}\\shell\\${entry.verb}`;
    lines.push(
      '',
      `[${base}]`,
      `@="${regEscape(entry.label)}"`,
      '',
      `[${base}\\command]`,
      `@="${regEscape(commandLine(entry.args))}"`
    );
  });

  return `${lines.join('\r\n')}\r\n`;
}
function applyMenu(items) {
  if (!isSupported()) return false;

  let file = '';
  try {
    file = path.join(app.getPath('temp'), TEMP_FILE_NAME);
    fs.writeFileSync(file, Buffer.from(`\ufeff${buildRegFile(items)}`, 'utf16le'));
  } catch (error) {
    console.error('[Desktop:ERROR] 写入注册表脚本失败:', error);
    return false;
  }

  try {
    execFileSync(REG_EXE, ['import', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {

    const detail = [error && error.stdout, error && error.stderr, error && error.message]
      .map((part) => String(part || '').trim().split(/\r?\n/).filter(Boolean).pop() || '')
      .find(Boolean) || '';
    console.warn(`[Desktop:WARN] 注册桌面右键菜单失败: ${detail} (script=${file})`);
    return false;
  }

  try {
    fs.unlinkSync(file);
  } catch (error) {
  }
  return true;
}

function currentItems() {
  try {
    const items = getItems();
    return Array.isArray(items) ? items : [];
  } catch (error) {
    console.error('[Desktop:ERROR] 读取便利贴清单失败:', error);
    return [];
  }
}
function signatureOf(items) {
  return items.map((item) => `${item.id}\u0000${item.title || ''}`).join('\u0001');
}

function flushMenu() {
  if (!enabled) return;
  const items = currentItems();
  const signature = signatureOf(items);
  if (signature === lastSignature) return;
  if (!applyMenu(items)) return;

  lastSignature = signature;
}

function syncDesktopMenu() {
  if (!enabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flushMenu();
  }, SYNC_DELAY);
}
function registerDesktopMenu() {
  if (!isSupported()) {
    console.warn('[Desktop:WARN] 当前平台没有可用的 reg.exe，跳过桌面右键菜单注册');
    return false;
  }

  enabled = true;
  const items = currentItems();
  if (!applyMenu(items)) {
    enabled = false;
    return false;
  }

  lastSignature = signatureOf(items);
  console.log(`[Desktop:INFO] Registered desktop context menu (items=${items.length} icon=${menuIcon ? 'generated' : 'exe'})`);
  return true;
}
function unregisterDesktopMenu() {
  enabled = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!isSupported()) return;
  [MENU_KEY_FULL, ITEMS_KEY_FULL].forEach((key) => {
    try {
      execFileSync(REG_EXE, ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore' });
      console.log(`[Desktop:INFO] Removed desktop context menu (key=${key})`);
    } catch (error) {

    }
  });
}

function readArg(argv, prefix) {
  const found = (argv || []).find((item) => typeof item === 'string' && item.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : '';
}

function handleDesktopMenuArgv(argv) {
  const action = readArg(argv, ACTION_PREFIX);
  if (!action) return false;

  try {
    onAction(action, readArg(argv, ID_PREFIX));
  } catch (error) {
    console.error('[Desktop:ERROR] 执行桌面菜单动作失败:', error);
  }
  return true;
}

function configureDesktopMenu({ getItems: readItems, onAction: runAction, icon } = {}) {
  if (typeof readItems === 'function') getItems = readItems;
  if (typeof runAction === 'function') onAction = runAction;
  if (typeof icon === 'string' && icon) appIconPath = icon;
}

module.exports = {
  configureDesktopMenu,
  handleDesktopMenuArgv,
  registerDesktopMenu,
  syncDesktopMenu,
  unregisterDesktopMenu
};
