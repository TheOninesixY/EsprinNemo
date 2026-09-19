/* 无边框窗口按钮与全屏状态 */

// Window Controls
const winControls = {
    min: () => ipcRenderer.invoke('window:minimize'),
    max: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen')
};

document.getElementById('win-min').onclick = winControls.min;
document.getElementById('win-max').onclick = winControls.max;
document.getElementById('win-close').onclick = winControls.close;

function updateFullscreenState(isFullscreen) {
    if (isFullscreen) {
        document.body.classList.add('is-fullscreen');
        const fsIcon = document.querySelector('#btn-fullscreen .ms-icon');
        if (fsIcon) fsIcon.textContent = 'fullscreen_exit';
        const fsBtn = document.getElementById('btn-fullscreen');
        if (fsBtn) fsBtn.title = '退出全屏';
    } else {
        document.body.classList.remove('is-fullscreen');
        const fsIcon = document.querySelector('#btn-fullscreen .ms-icon');
        if (fsIcon) fsIcon.textContent = 'fullscreen';
        const fsBtn = document.getElementById('btn-fullscreen');
        if (fsBtn) fsBtn.title = '全屏';
    }
}

ipcRenderer.on('window:fullscreen-changed', (event, isFullscreen) => {
    updateFullscreenState(isFullscreen);
});

document.addEventListener('fullscreenchange', () => {
    const isFullscreen = !!document.fullscreenElement;
    updateFullscreenState(isFullscreen);
});

document.getElementById('app-titlebar').ondblclick = (e) => {
    if (document.body.classList.contains('is-fullscreen')) return;
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;
    // 品牌名是“回到首页”按钮，双击时不应顺带最大化窗口
    if (e.target.closest('.titlebar-brand')) return;
    winControls.max();
};
