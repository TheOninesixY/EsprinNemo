/* 系统托盘：设置项与托盘菜单动作。
   托盘图标由主进程创建（见 src/main/tray.js），右键菜单里的「小本本」与「退出」在主进程内
   直接完成；「新建笔记 / 新建待办 / 设置」需要界面配合，由主进程先唤回主窗口，再把动作以
   tray:action 推送到这里执行。

   托盘在时关闭窗口不会退出应用，只是把界面收进托盘，因此设置页的说明文字会随开关改写，
   免得关掉托盘后还留着「应用仍驻留在托盘」的说法。 */

// 托盘动作 -> 界面操作（动作标识与 src/main/tray.js 中的常量一一对应）
const TRAY_ACTIONS = {
    'new-note': () => createNewNote(),
    'new-todo': () => createNewTodo(),
    'open-settings': () => openSettingsTab()
};

// 从托盘发起的操作：窗口已由主进程叫回前台，这里只把界面切到对应的位置
function handleTrayAction(action) {
    const run = TRAY_ACTIONS[action];
    if (typeof run === 'function') run();
}

// 说明文字跟着开关走：托盘在时「关闭窗口不退出」，托盘没了应用就重新回到
// 「关闭主窗口即退出」的原有行为
function syncTrayStatusText() {
    const status = document.getElementById('tray-status');
    if (!status) return;
    status.textContent = State.trayEnabled !== false
        ? '托盘图标显示中：右键菜单可打开小本本、新建笔记 / 待办或进入设置。此时关闭窗口仅将界面收进托盘，应用继续在后台运行；完全退出请使用托盘菜单的「退出」。'
        : '托盘图标已隐藏：关闭主窗口即退出应用（小本本仍开启时应用继续运行，直到小本本关闭）。';
}

// 采用主进程回传的真实状态：想开却开不出来（例如系统不允许）时改回界面并说明原因，
// 同时把配置也写成关闭，免得每次启动都白试一遍
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

// 把当前开关同步给主进程：拨动开关、切换数据目录后都走这里，
// 保证界面上的状态、config.json 里的记录与实际的图标三者一致
function syncTraySetting(options = {}) {
    return ipcRenderer.invoke('tray:set-enabled', { enabled: State.trayEnabled !== false })
        .then((result) => applyTrayState(result, options))
        .catch((err) => console.error('同步托盘开关失败:', err));
}

function initTraySettings() {
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

    // 启动时与主进程对一次状态：托盘图标没建出来时界面不会显示成已开启
    ipcRenderer.invoke('tray:get-state')
        .then((result) => applyTrayState(result))
        .catch((err) => console.error('读取托盘状态失败:', err));

    // 托盘菜单里的「新建笔记 / 新建待办 / 设置」
    ipcRenderer.on('tray:action', (event, action) => handleTrayAction(action));

    syncTrayStatusText();
}
