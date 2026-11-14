const winControls = {
    min: () => ipcRenderer.invoke('window:minimize'),
    max: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen')
};

async function openScratchpadWindow() {
    try {
        return await ipcRenderer.invoke('scratchpad:toggle');
    } catch (err) {
        console.error('打开小本本失败:', err);
        showToast('打开小本本失败');
        return false;
    }
}

function removeDesktopFullscreenButton() {
    if (IS_WEB_RUNTIME) return;
    const button = document.getElementById('btn-fullscreen');
    if (button) button.remove();
}

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

document.getElementById('win-min').onclick = winControls.min;
document.getElementById('win-max').onclick = winControls.max;
document.getElementById('win-close').onclick = winControls.close;

removeDesktopFullscreenButton();

ipcRenderer.on('window:fullscreen-changed', (event, isFullscreen) => {
    updateFullscreenState(isFullscreen);
});

document.getElementById('app-titlebar').ondblclick = (e) => {
    if (document.body.classList.contains('is-fullscreen')) return;
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;

    winControls.max();
};
