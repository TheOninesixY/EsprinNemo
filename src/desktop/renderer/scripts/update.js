let updateState = {
    status: 'idle',
    currentVersion: '',
    repoUrl: '',
    autoUpdate: true,

    ghProxyEnabled: false,
    canAutoInstall: false,
    packaged: false,
    checking: false,
    downloading: false,
    downloaded: false,
    progress: null,
    lastCheckAt: 0,
    error: '',

    currentRelease: null,
    currentReleaseStatus: 'idle',
    currentReleaseError: '',
    update: null
};

let updateDownloadNotified = false;

let updateNoAssetNotified = false;

let updateManualDownload = false;

function updateEl(id) {
    return document.getElementById(id);
}

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

function describeUpdateStatus(state) {
    const version = state.update ? state.update.version : '';
    switch (state.status) {
        case 'checking':
            return '正在检查更新…';
        case 'latest':
            return `已是最新版本（v${state.currentVersion}）`;
        case 'available':

            return state.update && state.update.hasAsset === false
                ? `发现新版本 v${version}，但发布页中没有符合命名规则的安装包（Windows 需为 Setup .exe，Linux 需为 .AppImage），请用「打开发布页」手动下载`
                : `发现新版本 v${version}，可立即下载`;
        case 'downloading':
            return `正在下载 v${version}…`;
        case 'downloaded':
            return state.canAutoInstall
                ? `v${version} 已下载完成，重启应用即可完成安装`
                : `v${version} 已下载完成，请用该安装包手动升级`;
        case 'error':
            return state.error || '检查更新失败：未获取到原因，请重试';
        default:
            return '尚未检查更新：可开启「自动检查并下载更新」自动检查，也可点「检查更新」立即检查';
    }
}

function updateStatusTone(state) {
    if (state.status === 'error') return 'error';
    if (state.status === 'latest' || state.status === 'downloaded') return 'ok';
    return '';
}

function setReleaseNotesBody(el, notes, fallback) {
    if (!el) return;
    const text = String(notes || '').trim();
    el.innerHTML = marked.parse(text || fallback);
}

function renderCurrentReleaseNotes() {
    const release = updateState.currentRelease;
    const label = updateState.currentVersion ? `v${updateState.currentVersion}` : '当前版本';

    const versionEl = updateEl('update-current-notes-version');
    if (versionEl) {
        versionEl.textContent = '';
        if (release && release.releaseUrl) {
            const link = document.createElement('a');
            link.href = release.releaseUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = label;
            link.title = '在系统浏览器中打开该版本的发布页';
            versionEl.appendChild(link);
        } else {
            versionEl.textContent = label;
        }
    }

    const dateEl = updateEl('update-current-notes-date');
    const body = updateEl('update-current-notes-body');

    switch (updateState.currentReleaseStatus) {
        case 'ready':
            if (dateEl) dateEl.textContent = formatReleaseDate(release && release.publishedAt);
            setReleaseNotesBody(body, release && release.notes, '该版本没有填写更新说明。');
            break;
        case 'loading':

            if (dateEl) dateEl.textContent = '';
            setReleaseNotesBody(body, '', '正在向更新源读取当前版本的发布说明…');
            break;
        case 'missing':

            if (dateEl) dateEl.textContent = '';
            setReleaseNotesBody(body, '', `更新源上没有 ${label} 的发布记录：可能是本地运行的未发布版本。`);
            break;
        case 'error':
            if (dateEl) dateEl.textContent = '';
            setReleaseNotesBody(body, '', updateState.currentReleaseError || '读取当前版本的发布说明失败：请检查网络后重试。');
            break;
        default:
            if (dateEl) dateEl.textContent = '';
            setReleaseNotesBody(body, '', '正在向更新源读取当前版本的发布说明…');
    }
}

function renderUpdateUI() {

    if (IS_PORTABLE_RUN) return;

    const toggle = updateEl('setting-auto-update');
    if (toggle) toggle.checked = updateState.autoUpdate !== false;

    const proxyToggle = updateEl('setting-gh-proxy');
    if (proxyToggle) proxyToggle.checked = updateState.ghProxyEnabled === true;

    const versionEl = updateEl('update-current-version');
    if (versionEl) versionEl.textContent = updateState.currentVersion ? `v${updateState.currentVersion}` : '未知版本';

const repoEl = updateEl('update-repo-url');
    if (repoEl) repoEl.textContent = updateState.repoUrl ? `项目地址：${updateState.repoUrl}` : '正在读取项目地址…';

    const statusEl = updateEl('update-status');
    if (statusEl) {
        statusEl.textContent = describeUpdateStatus(updateState);
        statusEl.dataset.tone = updateStatusTone(updateState);
    }

    const busy = updateState.checking || updateState.downloading;
    const update = updateState.update;
    const downloaded = !!updateState.downloaded;
    const canInstall = downloaded && updateState.canAutoInstall;

setUpdatesHidden('btn-update-download', !(updateState.status === 'available' && update && update.hasAsset && !updateState.downloading));
    setUpdatesHidden('btn-update-install', !canInstall);
    setUpdatesHidden('btn-update-open-file', !(downloaded && !updateState.canAutoInstall));
    setUpdatesHidden('btn-update-cancel', !updateState.downloading);

    setUpdatesDisabled('btn-update-check', busy);
    setUpdatesDisabled('btn-update-download', busy);

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

const showNotes = !!update && ['available', 'downloading', 'downloaded'].includes(updateState.status);
    setUpdatesHidden('update-notes-section', !showNotes);
    if (showNotes) {
        const versionText = updateEl('update-notes-version');
        if (versionText) versionText.textContent = `v${update.version}`;
        const dateText = updateEl('update-notes-date');
        if (dateText) dateText.textContent = formatReleaseDate(update.publishedAt);
        setReleaseNotesBody(updateEl('update-notes-body'), update.notes, '该版本没有填写更新说明。');
    }

renderCurrentReleaseNotes();
}

function adoptUpdateState(payload) {
    if (!payload || typeof payload !== 'object') return;
    updateState = { ...updateState, ...payload };

    State.autoUpdate = updateState.autoUpdate !== false;
    State.ghProxyEnabled = updateState.ghProxyEnabled === true;
    renderUpdateUI();
}

function syncUpdateSettingsUI() {
    if (IS_PORTABLE_RUN) return;
    const toggle = updateEl('setting-auto-update');
    if (toggle) toggle.checked = State.autoUpdate !== false;

    const proxyToggle = updateEl('setting-gh-proxy');
    if (proxyToggle) proxyToggle.checked = State.ghProxyEnabled === true;
    renderUpdateUI();
}

async function refreshUpdateInfo() {
    if (IS_PORTABLE_RUN) return;
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
        detail: '应用将先退出，安装程序完成升级后自动重新打开；当前编辑的内容会先保存。',
        confirmLabel: '重启并安装'
    });
    if (!confirmed) return;

flushPendingSave();

    try {
        const result = await ipcRenderer.invoke('update:install');
        if (result && result.ok === false) {
            showToast(result.error || '启动安装程序失败：请手动运行已下载的安装包');
        }
    } catch (err) {
        console.error('安装更新失败:', err);
        showToast('启动安装程序失败：请手动运行已下载的安装包');
    }
}

function openUpdatePage() {
    ipcRenderer.invoke('update:open-release').catch((err) => {
        console.error('打开发布页失败:', err);
    });
}

function openProjectPage() {
    ipcRenderer.invoke('update:open-repo').catch((err) => {
        console.error('打开项目主页失败:', err);
    });
}

function handleUpdateStatePush(payload) {
    const previousStatus = updateState.status;
    adoptUpdateState(payload);

    if (updateState.status === 'downloading' && previousStatus !== 'downloading' && !updateManualDownload && !updateDownloadNotified) {
        updateDownloadNotified = true;
        const version = updateState.update ? updateState.update.version : '';
        showToast(`正在后台下载更新 ${version ? `v${version}` : ''}`.trim());
    }

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

function removeUpdateSettingsUI() {
    document.querySelectorAll('#settings-view .settings-update-block').forEach((block) => block.remove());
}

function initUpdateSettings() {

    if (IS_PORTABLE_RUN) {
        removeUpdateSettingsUI();
        return;
    }

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

const proxyToggle = updateEl('setting-gh-proxy');
    if (proxyToggle) {
        proxyToggle.onchange = (e) => {
            State.ghProxyEnabled = !!e.target.checked;
            saveConfig();
            ipcRenderer.invoke('update:set-gh-proxy')
                .then((payload) => adoptUpdateState(payload))
                .catch((err) => console.error('同步 gh-proxy 加速开关失败:', err));
            showToast(State.ghProxyEnabled ? '已开启 gh-proxy 加速' : '已关闭 gh-proxy 加速');
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
    bind('btn-update-repo', openProjectPage);
    bind('btn-update-open-file', openDownloadedPackage);

    ipcRenderer.on('update:state', (event, payload) => handleUpdateStatePush(payload));

ipcRenderer.on('update:auto-disabled', () => {
        State.autoUpdate = false;
        updateState = { ...updateState, autoUpdate: false };
        syncUpdateSettingsUI();
        showToast('已按「永不提醒」关闭自动检查并下载更新，可在设置中重新开启');
    });

    syncUpdateSettingsUI();
    refreshUpdateInfo();
}
