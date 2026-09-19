// 全局界面默认值：屏蔽 Chromium 自带的焦点描边与 Tab 键焦点切换。
// 由主进程向每个页面注入，主窗口、弹窗窗口以及后续新增的窗口统一生效，
// 页面里不需要再逐个元素写 outline: none。
const { app, BrowserWindow } = require('electron');

// 关掉 Chromium 默认的焦点描边（键盘 Tab 导航时出现的蓝色 focus ring）与触屏蓝色高亮
const GLOBAL_CSS = `
*:focus,
*:focus-visible,
*:focus-within {
    outline: none !important;
}
*::-moz-focus-inner {
    border: 0 !important;
}
* {
    -webkit-tap-highlight-color: transparent;
}
`;

// 捕获阶段拦下 Tab / Shift+Tab：只取消 Chromium 的默认焦点切换，不阻止事件传播，
// 因此页面自身对 Tab 的处理（例如编辑器里的缩进）仍然照常执行。
const GLOBAL_JS = `
(function () {
    if (window.__esprinNemoFocusDefaults) return;
    window.__esprinNemoFocusDefaults = true;
    document.addEventListener('keydown', function (event) {
        if (event.key !== 'Tab') return;
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        event.preventDefault();
    }, true);
})();
`;

function applyUiDefaults(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  // 页面刷新会清空注入内容，因此每次 dom-ready 都重新注入一次
  webContents.insertCSS(GLOBAL_CSS).catch((error) => {
    console.error('[Esprin Nemo] 注入全局样式失败:', error);
  });
  webContents.executeJavaScript(GLOBAL_JS, false).catch((error) => {
    console.error('[Esprin Nemo] 注入全局脚本失败:', error);
  });
}

function registerUiDefaults() {
  app.on('web-contents-created', (event, webContents) => {
    webContents.on('dom-ready', () => applyUiDefaults(webContents));
  });

  // 兜底：注册时已经存在的页面
  BrowserWindow.getAllWindows().forEach((win) => applyUiDefaults(win.webContents));
}

module.exports = { registerUiDefaults };
