const TRAY_ACTIONS = {
    'new-note': () => createNewNote(),
    'new-todo': () => createNewTodo(),
    'open-settings': () => openSettingsTab(),
    'open-about': () => openAboutTab(),
    'pick-sticky-note': () => pickNoteToStick()
};

function isMacPlatform() {
    return process.platform === 'darwin';
}

function handleTrayAction(action) {
    const run = TRAY_ACTIONS[action];
    if (typeof run === 'function') run();
}

function syncTrayStatusText() {
    const status = document.getElementById('tray-status');
    if (!status) return;

    if (isMacPlatform()) {
        status.textContent = 'macOS 不显示托盘图标：打开主窗口、小本本、新建笔记 / 待办、设置与退出都在屏幕顶部的菜单栏里（EsprinNemo → 文件 / 窗口）。';
        return;
    }

    status.textContent = State.trayEnabled !== false
        ? '托盘图标显示中：右键菜单可打开小本本与桌面便利贴、新建笔记 / 待办或进入设置。此时关闭窗口仅将界面收进托盘，应用继续在后台运行；完全退出请使用托盘菜单的「退出」。'
        : '托盘图标已隐藏：关闭主窗口即退出应用（小本本仍开启或仍贴着便利贴时应用继续运行，直到两者都关闭）。';
}

function applyTrayState(result, options = {}) {
    if (!result || typeof result.enabled !== 'boolean') return;

    const changed = (State.trayEnabled !== false) !== result.enabled;
    State.trayEnabled = result.enabled;

    const toggle = document.getElementById('setting-tray-enabled');
    if (toggle) toggle.checked = result.enabled;
    syncTrayStatusText();
    if (changed) saveConfig();

    if (options.notify && result.error) showToast(result.error);
}

function syncTraySetting(options = {}) {
    if (isMacPlatform()) return Promise.resolve();
    return ipcRenderer.invoke('tray:set-enabled', { enabled: State.trayEnabled !== false })
        .then((result) => applyTrayState(result, options))
        .catch((err) => console.error('同步托盘开关失败:', err));
}

function initTraySettings() {
    ipcRenderer.on('tray:action', (event, action) => handleTrayAction(action));

    if (isMacPlatform()) {
        const row = document.getElementById('setting-tray-row');
        if (row) row.classList.add('hidden');
        syncTrayStatusText();
        return;
    }

    const toggle = document.getElementById('setting-tray-enabled');
    if (toggle) {
        toggle.checked = State.trayEnabled !== false;
        toggle.onchange = (e) => {
            State.trayEnabled = !!e.target.checked;
            saveConfig();
            syncTrayStatusText();
            showToast(State.trayEnabled ? '已开启系统托盘图标' : '已关闭系统托盘图标');
            syncTraySetting({ notify: true });
        };
    }

    ipcRenderer.invoke('tray:get-state')
        .then((result) => applyTrayState(result))
        .catch((err) => console.error('读取托盘状态失败:', err));

    syncTrayStatusText();
}
