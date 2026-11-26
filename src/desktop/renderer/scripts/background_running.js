function syncBackgroundRunningControl() {
    const row = document.getElementById('setting-background-running-row');
    if (row) row.classList.toggle('hidden', process.platform !== 'darwin');
    const toggle = document.getElementById('setting-background-running');
    if (toggle) toggle.checked = State.backgroundRunning !== false;
}

function setBackgroundRunning(value) {
    State.backgroundRunning = value !== false;
    syncBackgroundRunningControl();
    saveConfig();
    showToast(State.backgroundRunning ? '已开启后台运行' : '已关闭后台运行，关闭窗口将退出应用');
}

function initBackgroundRunningSettings() {
    syncBackgroundRunningControl();
    if (process.platform !== 'darwin') return;
    const toggle = document.getElementById('setting-background-running');
    if (toggle) toggle.onchange = () => setBackgroundRunning(!!toggle.checked);
}
