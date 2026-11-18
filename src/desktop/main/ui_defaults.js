const { app, BrowserWindow } = require('electron');

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

BrowserWindow.getAllWindows().forEach((win) => applyUiDefaults(win.webContents));
}

module.exports = { registerUiDefaults };
