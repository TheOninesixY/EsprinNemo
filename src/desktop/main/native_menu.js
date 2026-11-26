const { BrowserWindow, Menu, nativeImage, ipcMain } = require('electron');

const MENU_SYMBOLS = {
  'external-link': 'arrow.up.right.square',
  'circle-check': 'checkmark.circle',
  'circle-help': 'questionmark.circle',
  square: 'circle',
  pin: 'pin',
  'pin-off': 'pin.slash',
  eye: 'eye',
  'eye-off': 'eye.slash',
  lock: 'lock',
  'lock-open': 'lock.open',
  'key-round': 'lock.open',
  'share-2': 'square.and.arrow.up',
  download: 'square.and.arrow.down',
  'trash-2': 'trash',
  trash: 'trash.slash',
  'undo-2': 'arrow.uturn.left',
  unlink: 'xmark.circle',
  pencil: 'pencil',
  'file-plus': 'doc.badge.plus',
  users: 'person.2',
  user: 'person',
  mail: 'envelope',
  ban: 'nosign'
};

function createMenuIcon(name) {
  if (typeof name !== 'string' || !name) return null;

  const symbol = MENU_SYMBOLS[name] || name;

  let image = null;
  try {
    image = nativeImage.createMenuSymbol(symbol);
  } catch (error) {
    console.warn(`[Desktop:WARN] 系统图标「${symbol}」不可用，已忽略。`);
    return null;
  }

  if (!image || image.isEmpty()) return null;
  image.setTemplateImage(true);
  return image;
}

function buildMenuTemplate(entries, onPick) {
  const template = [];

  entries.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;

    if (entry.type === 'separator') {
      template.push({ type: 'separator' });
      return;
    }

    if (entry.type === 'submenu') {
      const submenu = buildMenuTemplate(Array.isArray(entry.items) ? entry.items : [], onPick);
      if (submenu.length && typeof entry.label === 'string' && entry.label) {
        template.push({ label: entry.label, submenu });
      }
      return;
    }

    if (typeof entry.label !== 'string' || !entry.label) return;

    const item = {
      label: entry.label,
      click: () => onPick(typeof entry.action === 'string' ? entry.action : null)
    };

    if (entry.disabled === true) item.enabled = false;

    const icon = createMenuIcon(entry.icon);
    if (icon) item.icon = icon;

    template.push(item);
  });

  return template;
}

function registerNativeMenuIpc() {
  ipcMain.handle('menu:popup', (event, payload) => {
    if (process.platform !== 'darwin') return null;

    const entries = payload && Array.isArray(payload.items) ? payload.items : [];
    if (!entries.length) return null;

    let picked = null;
    const template = buildMenuTemplate(entries, (action) => {
      picked = action;
    });
    if (!template.length) return null;

    const win = BrowserWindow.fromWebContents(event.sender);

    return new Promise((resolve) => {
      const menu = Menu.buildFromTemplate(template);
      menu.popup({
        window: win && !win.isDestroyed() ? win : undefined,
        callback: () => resolve(picked)
      });
    });
  });

  if (process.platform === 'darwin') {
    console.log('[Desktop:INFO] 已启用 macOS 系统原生右键菜单。');
  }
}

module.exports = { registerNativeMenuIpc };
