function syncAutoLaunchStatusText(result) {
    const status = document.getElementById('auto-launch-status');
    if (!status) return;

    if (!result) {
        status.textContent = '正在读取开机自启状态…';
        return;
    }
    if (result.supported === false) {
        status.textContent = '当前为开发运行（bun start）：开机自启仅对安装版与便携版生效，此处无法设置。';
        return;
    }
    status.textContent = result.enabled
        ? '已开启：登录系统后自动启动 EsprinNemo 并打开主窗口；无需常驻时可关闭主窗口（已开启托盘图标时窗口收进通知区域）。'
        : '已关闭：登录系统后不自动启动，需手动运行应用。';
}

function applyAutoLaunchState(result, options = {}) {
    if (!result || typeof result.enabled !== 'boolean') return;

    const toggle = document.getElementById('setting-auto-launch');

    if (result.supported === false) {
        if (toggle) {
            toggle.disabled = true;
            toggle.checked = State.autoLaunch === true;
        }
        syncAutoLaunchStatusText(result);
        if (options.notify && result.error) showToast(result.error);
        return;
    }

    const changed = (State.autoLaunch === true) !== result.enabled;
    State.autoLaunch = result.enabled;

    if (toggle) {
        toggle.disabled = false;
        toggle.checked = result.enabled;
    }
    syncAutoLaunchStatusText(result);
    if (changed) saveConfig();

    if (options.notify && result.error) showToast(result.error);
}

function syncAutoLaunchSetting(options = {}) {
    return ipcRenderer.invoke('app:set-auto-launch', { enabled: State.autoLaunch === true })
        .then((result) => applyAutoLaunchState(result, options))
        .catch((err) => console.error('同步开机自启失败:', err));
}

function initAutoLaunchSettings() {
    const toggle = document.getElementById('setting-auto-launch');
    if (toggle) {
        toggle.checked = State.autoLaunch === true;
        toggle.onchange = (e) => {
            State.autoLaunch = !!e.target.checked;
            saveConfig();
            showToast(State.autoLaunch ? '已开启开机自启' : '已关闭开机自启');
            syncAutoLaunchSetting({ notify: true });
        };
    }

ipcRenderer.invoke('app:get-auto-launch')
        .then((result) => applyAutoLaunchState(result))
        .catch((err) => console.error('读取开机自启状态失败:', err));

    syncAutoLaunchStatusText(null);
}
