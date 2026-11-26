const WINDOW_CONTROLS_ARG_PREFIX = '--esprin-nemo-window-controls=';

const winControls = {
    min: () => ipcRenderer.invoke('window:minimize'),
    max: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen')
};

function readWindowControlsArg() {
    try {
        const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith(WINDOW_CONTROLS_ARG_PREFIX));
        if (matched) return matched.slice(WINDOW_CONTROLS_ARG_PREFIX.length).trim() === 'mac' ? 'mac' : 'windows';
    } catch (err) {

    }
    return process.platform === 'darwin' ? 'mac' : 'windows';
}

function readInitialWindowControls() {
    try {
        const snapshot = ipcRenderer.sendSync('window:get-controls-sync');
        if (snapshot && typeof snapshot === 'object') {
            return {
                style: snapshot.style === 'mac' ? 'mac' : 'windows',
                native: !!snapshot.native,
                mac: !!snapshot.mac
            };
        }
    } catch (err) {

    }
    const style = readWindowControlsArg();
    return {
        style,
        native: style === 'mac' && process.platform === 'darwin',
        mac: process.platform === 'darwin'
    };
}

let windowControlsState = readInitialWindowControls();

function applyWindowControlsState(snapshot) {
    if (snapshot && typeof snapshot === 'object') {
        windowControlsState = {
            style: snapshot.style === 'mac' ? 'mac' : 'windows',
            native: !!snapshot.native,
            mac: !!snapshot.mac
        };
    }

    const root = document.documentElement;
    const isMac = windowControlsState.style === 'mac';
    root.classList.toggle('window-controls-mac', isMac);
    root.classList.toggle('window-controls-windows', !isMac);

    const row = document.getElementById('window-controls-row');
    if (row) row.classList.toggle('hidden', !windowControlsState.mac);

    const select = document.getElementById('setting-window-controls');
    if (select) select.value = windowControlsState.style;

    const platformDesc = document.getElementById('window-controls-platform-desc');
    if (platformDesc) {
        platformDesc.textContent = windowControlsState.mac
            ? (windowControlsState.style === 'mac'
                ? 'macOS：当前使用系统原生红绿灯，位于窗口左上角，应用图标与名称已隐藏。'
                : 'macOS：当前使用原有的自绘 Windows 样式按钮（右上角），左上角恢复应用图标与名称。')
            : '当前系统不是 macOS：没有可切换的窗口控件，始终使用原有的自绘 Windows 样式按钮。';
    }
}

async function refreshWindowControlsState() {
    try {
        const snapshot = await ipcRenderer.invoke('window:get-controls');
        applyWindowControlsState(snapshot);
    } catch (err) {
        console.error('[Desktop:ERROR] 读取窗口控件设置失败:', err);
    }
}

async function setWindowControlsStyle(style) {
    try {
        const snapshot = await ipcRenderer.invoke('window:set-controls', style);
        applyWindowControlsState(snapshot);
        showToast(snapshot.style === 'mac' ? '窗口控件已切换为 macOS 原生红绿灯' : '窗口控件已切换为原有 Windows 样式');
    } catch (err) {
        console.error('[Desktop:ERROR] 切换窗口控件失败:', err);
        showToast('切换窗口控件失败');
    }
}

function initWindowControls() {
    const minBtn = document.getElementById('win-min');
    if (minBtn) minBtn.onclick = winControls.min;

    const maxBtn = document.getElementById('win-max');
    if (maxBtn) maxBtn.onclick = winControls.max;

    const closeBtn = document.getElementById('win-close');
    if (closeBtn) closeBtn.onclick = winControls.close;

    const settingsMinBtn = document.getElementById('settings-win-min');
    if (settingsMinBtn) settingsMinBtn.onclick = winControls.min;

    const settingsMaxBtn = document.getElementById('settings-win-max');
    if (settingsMaxBtn) settingsMaxBtn.onclick = winControls.max;

    const settingsCloseBtn = document.getElementById('settings-win-close');
    if (settingsCloseBtn) settingsCloseBtn.onclick = winControls.close;

    const select = document.getElementById('setting-window-controls');
    if (select) select.onchange = (event) => setWindowControlsStyle(event.target.value);

    applyWindowControlsState(windowControlsState);
    refreshWindowControlsState();
}

async function openScratchpadWindow() {
    try {
        return await ipcRenderer.invoke('scratchpad:toggle');
    } catch (err) {
        console.error('[Desktop:ERROR] 打开小本本失败:', err);
        showToast('打开小本本失败');
        return false;
    }
}

function removeDesktopFullscreenButton() {
    const button = document.getElementById('btn-fullscreen');
    if (button) button.remove();
}

function updateFullscreenState(isFullscreen) {
    if (isFullscreen) {
        document.body.classList.add('is-fullscreen');
        const fsIcon = document.querySelector('#btn-fullscreen .icon');
        if (fsIcon) setLucideIcon(fsIcon, 'minimize');
        const fsBtn = document.getElementById('btn-fullscreen');
        if (fsBtn) fsBtn.title = '退出全屏';
    } else {
        document.body.classList.remove('is-fullscreen');
        const fsIcon = document.querySelector('#btn-fullscreen .icon');
        if (fsIcon) setLucideIcon(fsIcon, 'maximize');
        const fsBtn = document.getElementById('btn-fullscreen');
        if (fsBtn) fsBtn.title = '全屏';
    }
}

initWindowControls();

removeDesktopFullscreenButton();

ipcRenderer.on('window:fullscreen-changed', (event, isFullscreen) => {
    updateFullscreenState(isFullscreen);
});

ipcRenderer.on('window:controls-changed', (event, snapshot) => {
    applyWindowControlsState(snapshot);
});

const appTitlebar = document.getElementById('app-titlebar');
if (appTitlebar) {
    appTitlebar.ondblclick = (e) => {
        if (document.body.classList.contains('is-fullscreen')) return;
        if (windowControlsState.native) return;
        if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;

        winControls.max();
    };
}

const settingsWindowBar = document.getElementById('settings-window-bar');
if (settingsWindowBar) {
    settingsWindowBar.ondblclick = (e) => {
        if (windowControlsState.native) return;
        if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;

        winControls.max();
    };
}
