/* 应用更新设置：版本与更新源展示、检查更新、下载进度与重启安装。
   检查、下载、安装全部由主进程完成（见 src/main/updater.js），这里只做两件事：
   把主进程上报的状态画到界面上，把用户的操作转成 IPC 调用。

   状态有两个来源：
   - 打开设置页时主动查询一次（update:get-info）
   - 主进程在后台自动检查 / 下载过程中推送的 update:state */

// 主进程最近一次上报的更新状态（字段与 main/updater.js 的 snapshot 一一对应）
let updateState = {
    status: 'idle', // idle / checking / latest / available / downloading / downloaded / error
    currentVersion: '',
    source: '',
    sourceUrl: '',
    autoUpdate: true,
    canAutoInstall: false,
    portable: false,
    packaged: false,
    checking: false,
    downloading: false,
    downloaded: false,
    progress: null,
    lastCheckAt: 0,
    error: '',
    update: null
};

// 后台自动下载只提示一次，避免每一轮进度都弹一条 toast
let updateDownloadNotified = false;
// 发现了新版本、但发布页里没有符合规则的安装包时只提示一次
let updateNoAssetNotified = false;
// 本次下载是否由界面按钮发起：自己点的不用再提示“正在后台下载”
let updateManualDownload = false;

function updateEl(id) {
    return document.getElementById(id);
}

// 显示类按钮的显隐统一走这里，避免散落的 style 操作
function setUpdatesHidden(id, hidden) {
    const el = updateEl(id);
    if (el) el.classList.toggle('hidden', !!hidden);
}

function setUpdatesDisabled(id, disabled) {
    const el = updateEl(id);
    if (el) el.disabled = !!disabled;
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatReleaseDate(value) {
    const time = Date.parse(String(value || ''));
    if (!Number.isFinite(time)) return '';
    const d = new Date(time);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 运行方式：开发运行 / 便携版 / 安装版，只有最后一种支持自动安装
function describeUpdateBuildKind(state) {
    if (!state.packaged) return '开发运行';
    if (state.portable) return '便携版';
    return '安装版';
}

function describeUpdateStatus(state) {
    const version = state.update ? state.update.version : '';
    switch (state.status) {
        case 'checking':
            return '正在检查更新…';
        case 'latest':
            return `已是最新版本（v${state.currentVersion}）`;
        case 'available':
            // 发布页里没有符合命名规则的安装包（setup 段 + .exe）时只能去发布页手动下载
            return state.update && state.update.hasAsset === false
                ? `发现新版本 v${version}，但发布页里没有符合规则的安装包（文件名需带 setup 且为 .exe），请点「打开发布页」手动下载`
                : `发现新版本 v${version}，可立即下载`;
        case 'downloading':
            return `正在下载 v${version}…`;
        case 'downloaded':
            return state.canAutoInstall
                ? `v${version} 已下载完成，重启应用即可完成安装`
                : `v${version} 已下载完成，请用该安装包手动升级`;
        case 'error':
            return state.error || '检查更新失败';
        default:
            return '尚未检查更新：可打开上方开关自动检查，也可点右侧按钮立即检查';
    }
}

// 状态行的着色：出错的红色，其余成功态用强调色
function updateStatusTone(state) {
    if (state.status === 'error') return 'error';
    if (state.status === 'latest' || state.status === 'downloaded') return 'ok';
    return '';
}

function renderUpdateUI() {
    const toggle = updateEl('setting-auto-update');
    if (toggle) toggle.checked = updateState.autoUpdate !== false;

    const versionEl = updateEl('update-current-version');
    if (versionEl) versionEl.textContent = updateState.currentVersion ? `v${updateState.currentVersion}` : '未知版本';

    const buildEl = updateEl('update-build-kind');
    if (buildEl) {
        const kind = describeUpdateBuildKind(updateState);
        buildEl.textContent = updateState.canAutoInstall
            ? `运行方式：${kind}，支持自动下载并安装更新`
            : `运行方式：${kind}，只支持下载安装包后手动升级`;
    }

    const sourceEl = updateEl('update-source');
    if (sourceEl) sourceEl.textContent = updateState.source ? `更新源：${updateState.source}` : '';

    const statusEl = updateEl('update-status');
    if (statusEl) {
        statusEl.textContent = describeUpdateStatus(updateState);
        statusEl.dataset.tone = updateStatusTone(updateState);
    }

    const busy = updateState.checking || updateState.downloading;
    const update = updateState.update;
    const downloaded = !!updateState.downloaded;
    const canInstall = downloaded && updateState.canAutoInstall;

    // 按钮显隐：同一时刻最多出现一个主动作
    setUpdatesHidden('btn-update-download', !(updateState.status === 'available' && update && update.hasAsset && !updateState.downloading));
    setUpdatesHidden('btn-update-install', !canInstall);
    setUpdatesHidden('btn-update-open-file', !(downloaded && !updateState.canAutoInstall));
    setUpdatesHidden('btn-update-cancel', !updateState.downloading);

    setUpdatesDisabled('btn-update-check', busy);
    setUpdatesDisabled('btn-update-download', busy);

    // 进度条：下载中显示实时进度，下载完成后保留 100% 的完成态
    const progress = updateState.progress;
    const showProgress = updateState.downloading || (downloaded && !!progress);
    setUpdatesHidden('update-progress', !showProgress);
    if (showProgress) {
        const percent = progress ? Math.max(0, Math.min(100, Number(progress.percent) || 0)) : 0;
        const bar = updateEl('update-progress-bar');
        if (bar) bar.style.width = `${percent}%`;

        const textEl = updateEl('update-progress-text');
        if (textEl) {
            if (downloaded) {
                textEl.textContent = progress && progress.total ? `已下载 ${formatBytes(progress.total)}` : '下载完成';
            } else if (progress && progress.total) {
                const speed = progress.bytesPerSecond ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : '';
                textEl.textContent = `${formatBytes(progress.received)} / ${formatBytes(progress.total)}${speed}`;
            } else {
                textEl.textContent = progress ? `已下载 ${formatBytes(progress.received)}` : '准备下载…';
            }
        }
        const percentEl = updateEl('update-progress-percent');
        if (percentEl) percentEl.textContent = downloaded ? '已完成' : `${percent}%`;
    }

    // 更新说明：只在真的有新版本可看时展开
    const showNotes = !!update && ['available', 'downloading', 'downloaded'].includes(updateState.status);
    setUpdatesHidden('update-notes-section', !showNotes);
    if (showNotes) {
        const versionText = updateEl('update-notes-version');
        if (versionText) versionText.textContent = `v${update.version}`;
        const dateText = updateEl('update-notes-date');
        if (dateText) dateText.textContent = formatReleaseDate(update.publishedAt);
        const body = updateEl('update-notes-body');
        // 更新说明按纯文本呈现：不渲染 Markdown，避免把发布页里的任意内容当 HTML 执行
        if (body) body.textContent = String(update.notes || '').trim() || '该版本没有填写更新说明。';
    }
}

// 主进程状态里有缺项时用当前值兜底，保证渲染函数拿到的字段齐全
function adoptUpdateState(payload) {
    if (!payload || typeof payload !== 'object') return;
    updateState = { ...updateState, ...payload };
    // 自动更新开关以配置为准，主进程读到的就是 config.json 里的值
    State.autoUpdate = updateState.autoUpdate !== false;
    renderUpdateUI();
}

// 打开设置页 / 切换数据目录后调用：开关状态跟随配置，其余沿用最近一次状态
function syncUpdateSettingsUI() {
    const toggle = updateEl('setting-auto-update');
    if (toggle) toggle.checked = State.autoUpdate !== false;
    renderUpdateUI();
}

async function refreshUpdateInfo() {
    try {
        adoptUpdateState(await ipcRenderer.invoke('update:get-info'));
    } catch (err) {
        console.error('读取更新状态失败:', err);
    }
    renderUpdateUI();
}

async function checkUpdatesNow() {
    setUpdatesDisabled('btn-update-check', true);
    updateState = { ...updateState, status: 'checking', checking: true, error: '' };
    renderUpdateUI();

    try {
        const result = await ipcRenderer.invoke('update:check');
        adoptUpdateState(result);
        if (result && result.status === 'available') {
            showToast(`发现新版本 v${result.update ? result.update.version : ''}`);
        } else if (result && result.status === 'latest') {
            showToast('已是最新版本');
        }
    } catch (err) {
        console.error('检查更新失败:', err);
        adoptUpdateState({ status: 'error', error: '检查更新失败', checking: false });
    }
}

async function downloadUpdate() {
    updateManualDownload = true;
    updateState = { ...updateState, downloading: true, status: 'downloading' };
    renderUpdateUI();

    try {
        const result = await ipcRenderer.invoke('update:download');
        if (result && result.ok === false) {
            updateManualDownload = false;
            adoptUpdateState({ status: 'error', error: result.error || '下载更新失败', downloading: false });
            showToast(result.error || '下载更新失败');
        }
    } catch (err) {
        console.error('下载更新失败:', err);
        updateManualDownload = false;
        adoptUpdateState({ status: 'error', error: '下载更新失败', downloading: false });
    }
}

async function cancelUpdateDownload() {
    try {
        adoptUpdateState(await ipcRenderer.invoke('update:cancel-download'));
        showToast('已取消下载');
    } catch (err) {
        console.error('取消下载失败:', err);
    }
}

// 便携版 / 开发运行下没有可自动安装的目标，只能打开安装包让用户手动升级
async function openDownloadedPackage() {
    try {
        await ipcRenderer.invoke('update:open-file');
        showToast('已打开安装包所在文件夹');
    } catch (err) {
        console.error('打开安装包失败:', err);
    }
}

async function installUpdate() {
    if (!updateState.canAutoInstall) {
        await openDownloadedPackage();
        return;
    }

    const confirmed = await showConfirm('立即重启并安装更新？', {
        title: '安装更新',
        detail: '应用会先退出，安装程序完成升级后自动重新打开。当前编辑的内容会先保存。',
        confirmLabel: '重启并安装'
    });
    if (!confirmed) return;

    // 升级过程会结束进程：先把待保存的编辑落盘，避免丢内容
    flushPendingSave();

    try {
        const result = await ipcRenderer.invoke('update:install');
        if (result && result.ok === false) {
            showToast(result.error || '启动安装程序失败');
        }
    } catch (err) {
        console.error('安装更新失败:', err);
        showToast('启动安装程序失败');
    }
}

function openUpdatePage() {
    ipcRenderer.invoke('update:open-release').catch((err) => {
        console.error('打开发布页失败:', err);
    });
}

// 主进程推送的状态：后台自动下载开始时提示一次，下载完成后提示一次
function handleUpdateStatePush(payload) {
    const previousStatus = updateState.status;
    adoptUpdateState(payload);

    if (updateState.status === 'downloading' && previousStatus !== 'downloading' && !updateManualDownload && !updateDownloadNotified) {
        updateDownloadNotified = true;
        const version = updateState.update ? updateState.update.version : '';
        showToast(`正在后台下载更新 ${version ? `v${version}` : ''}`.trim());
    }
    // 有新版但发布页没有可自动安装的包：提示一次，让用户知道要去发布页手动下载
    if (updateState.status === 'available' && updateState.update && updateState.update.hasAsset === false && !updateNoAssetNotified) {
        updateNoAssetNotified = true;
        showToast(`发现新版本 v${updateState.update.version}，发布页里没有可用的安装包，请在设置中手动下载`);
    }
    if (updateState.status === 'downloaded' && previousStatus !== 'downloaded') {
        updateDownloadNotified = false;
        updateManualDownload = false;
    }
    if (updateState.status === 'available' || updateState.status === 'idle') {
        updateDownloadNotified = false;
        if (updateState.status === 'idle') updateNoAssetNotified = false;
    }
}

function initUpdateSettings() {
    const toggle = updateEl('setting-auto-update');
    if (toggle) {
        toggle.onchange = (e) => {
            State.autoUpdate = !!e.target.checked;
            saveConfig();
            ipcRenderer.invoke('update:set-auto', { enabled: State.autoUpdate })
                .then((payload) => adoptUpdateState(payload))
                .catch((err) => console.error('同步自动更新开关失败:', err));
            showToast(State.autoUpdate ? '已开启自动更新' : '已关闭自动更新');
        };
    }

    const bind = (id, handler) => {
        const el = updateEl(id);
        if (el) el.onclick = handler;
    };
    bind('btn-update-check', checkUpdatesNow);
    bind('btn-update-download', downloadUpdate);
    bind('btn-update-install', installUpdate);
    bind('btn-update-cancel', cancelUpdateDownload);
    bind('btn-update-page', openUpdatePage);
    bind('btn-update-open-file', openDownloadedPackage);

    ipcRenderer.on('update:state', (event, payload) => handleUpdateStatePush(payload));

    syncUpdateSettingsUI();
    refreshUpdateInfo();
}
