const { app, Menu } = require('electron');

const APP_NAME = 'EsprinNemo';

function run(action) {
  return () => {
    if (typeof action === 'function') action();
  };
}

function buildMacApplicationMenu(actions = {}) {
  const viewSubmenu = [
    { role: 'togglefullscreen', label: '切换全屏' }
  ];
  if (!app.isPackaged) {
    viewSubmenu.push({ type: 'separator' });
    viewSubmenu.push({ role: 'reload', label: '重新载入' });
    viewSubmenu.push({ role: 'toggleDevTools', label: '开发者工具' });
  }

  const fileSubmenu = [
    { label: '打开主窗口', click: run(actions.onOpenMain) },
    { label: '小本本', click: run(actions.onOpenScratchpad) },
    {
      label: '桌面便利贴',
      submenu: [
        { label: '贴上便利贴…', click: run(actions.onPickStickyNote) },
        { label: '显示全部便利贴', click: run(actions.onShowStickyNotes) },
        { label: '收起全部便利贴', click: run(actions.onHideStickyNotes) }
      ]
    },
    { type: 'separator' },
    { label: '新建笔记', click: run(actions.onNewNote) },
    { label: '新建待办', click: run(actions.onNewTodo) },
    { type: 'separator' },
    { label: '设置…', click: run(actions.onOpenSettings) }
  ];

  return Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { label: `关于 ${APP_NAME}`, click: run(actions.onOpenAbout) },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${APP_NAME}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${APP_NAME}` }
      ]
    },
    {
      label: '文件',
      submenu: fileSubmenu
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: viewSubmenu
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
        { role: 'front', label: '前置全部窗口' }
      ]
    }
  ]);
}

function installAppMenu(actions = {}) {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(buildMacApplicationMenu(actions));
    return;
  }
  Menu.setApplicationMenu(null);
}

module.exports = { installAppMenu };
