/* 开机自启：设置项与主进程登记的系统登录启动项保持一致。

   系统启动项由主进程读写（见 src/main/auto_launch.js），配置项 autoLaunch 随
   config.json 落盘（默认关闭）。这里只做两件事：把开关画成实际的状态，
   把用户的操作转成 IPC 调用；主进程回读到的真实状态优先，写不进去时不谎报成功。

   开发运行（bun start）下没有稳定的可执行文件，主进程会回 supported: false，
   此时开关置灰并说明原因，配置不动（免得把安装版的设置一并改掉）。 */

// 说明文字跟着开关走：开启后登录即启动，关闭后需要手动运行
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

// 采用主进程回传的真实状态：系统不允许写入时改回界面，同时把配置也写成实际状态，
// 避免下次启动又白试一遍
function applyAutoLaunchState(result, options = {}) {
    if (!result || typeof result.enabled !== 'boolean') return;

    const toggle = document.getElementById('setting-auto-launch');
    // 开发运行不支持：保持配置原样，只把开关置灰并说明原因
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

// 把当前开关同步给主进程：拨动开关、切换数据目录后都走这里
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

    // 启动时与主进程对一次状态：登记失败时界面不会显示成已开启
    ipcRenderer.invoke('app:get-auto-launch')
        .then((result) => applyAutoLaunchState(result))
        .catch((err) => console.error('读取开机自启状态失败:', err));

    syncAutoLaunchStatusText(null);
}
