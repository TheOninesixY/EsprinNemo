/* 应用更新设置：版本与项目地址展示、检查更新、下载进度与重启安装。
   检查、下载、安装全部由主进程完成（见 src/main/updater.js），这里只做两件事：
   把主进程上报的状态画到界面上，把用户的操作转成 IPC 调用。

   状态有两个来源：
   - 打开设置页时主动查询一次（update:get-info）
   - 主进程在后台自动检查 / 下载 / 读取当前版本发布记录后推送的 update:state

   「更新与版本」页里有两个开关：「自动检查并下载更新」（config.json 的 autoUpdate）与
   「使用 gh-proxy 加速」（config.json 的 ghProxyEnabled）。两者都由这里写进配置，
   主进程读到后分别决定要不要自动检查、检查更新与下载安装包时先走代理还是直连
   （见 main/updater.js 的 githubUrls）。

   两处说明文字（新版本、当前版本）都按 Markdown 渲染：marked.parse 会先转义 HTML，
   发布页里的内容（包括 <script>）只会以纯文本形式出现，不会被当成 HTML 执行。

   便携版没有更新功能（主进程不注册更新 IPC，也不做自动检查），因此这里整体跳过：
   「系统」分类里的更新分区会被整块摘掉，也不绑定任何事件。 */

// 主进程最近一次上报的更新状态（字段与 main/updater.js 的 snapshot 一一对应）
let updateState = {
    status: 'idle', // idle / checking / latest / available / downloading / downloaded / error
    currentVersion: '',
    repoUrl: '',
    autoUpdate: true,
    // gh-proxy 加速（默认关闭）：开启后主进程检查更新与下载安装包都先走代理，失败回落直连
    ghProxyEnabled: false,
    canAutoInstall: false,
    packaged: false,
    checking: false,
    downloading: false,
    downloaded: false,
    progress: null,
    lastCheckAt: 0,
    error: '',
    // 当前版本的发布记录：{ version, notes, publishedAt, releaseUrl }
    currentRelease: null,
    currentReleaseStatus: 'idle', // idle / loading / ready / missing / error
    currentReleaseError: '',
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

// 运行方式不再在界面上区分：能不能自动安装由按钮显隐与状态文字自己说明
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
                ? `发现新版本 v${version}，但发布页中没有符合命名规则的安装包（文件名需含 setup 且以 .exe 结尾），请用「打开发布页」手动下载`
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

// 状态行的着色：出错的红色，其余成功态用强调色
function updateStatusTone(state) {
    if (state.status === 'error') return 'error';
    if (state.status === 'latest' || state.status === 'downloaded') return 'ok';
    return '';
}

// 说明文字统一按 Markdown 渲染；没有正文时退回到一句纯文本说明。
// innerHTML 在这里是安全的：marked.parse 会先做 HTML 转义，链接也会过协议白名单。
function setReleaseNotesBody(el, notes, fallback) {
    if (!el) return;
    const text = String(notes || '').trim();
    el.innerHTML = marked.parse(text || fallback);
}

// 当前版本说明：版本号做成指向该版本发布页的链接，正文来自更新源上对应的 release
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
            // idle 也走这里：界面打开时主进程已经在读了，显示“读取中”比“尚未读取”更贴切
            if (dateEl) dateEl.textContent = '';
            setReleaseNotesBody(body, '', '正在向更新源读取当前版本的发布说明…');
            break;
        case 'missing':
            // 本地构建（bun start / 未发布的版本）在更新源上不会有对应的发布记录
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
    // 便携版没有更新功能：更新分区已整块摘掉，不再改动任何界面
    if (IS_PORTABLE_RUN) return;

    const toggle = updateEl('setting-auto-update');
    if (toggle) toggle.checked = updateState.autoUpdate !== false;

    const proxyToggle = updateEl('setting-gh-proxy');
    if (proxyToggle) proxyToggle.checked = updateState.ghProxyEnabled === true;

    const versionEl = updateEl('update-current-version');
    if (versionEl) versionEl.textContent = updateState.currentVersion ? `v${updateState.currentVersion}` : '未知版本';

    // 版本号下面那行显示项目地址（原来这里是「更新源」）
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

    // 新版本说明：只在真的有新版本可看时展开，正文按 Markdown 渲染
    const showNotes = !!update && ['available', 'downloading', 'downloaded'].includes(updateState.status);
    setUpdatesHidden('update-notes-section', !showNotes);
    if (showNotes) {
        const versionText = updateEl('update-notes-version');
        if (versionText) versionText.textContent = `v${update.version}`;
        const dateText = updateEl('update-notes-date');
        if (dateText) dateText.textContent = formatReleaseDate(update.publishedAt);
        setReleaseNotesBody(updateEl('update-notes-body'), update.notes, '该版本没有填写更新说明。');
    }

    // 当前版本说明：内容取自更新源上该版本的发布记录，没读到就显示对应的状态说明
    renderCurrentReleaseNotes();
}

// 主进程状态里有缺项时用当前值兜底，保证渲染函数拿到的字段齐全
function adoptUpdateState(payload) {
    if (!payload || typeof payload !== 'object') return;
    updateState = { ...updateState, ...payload };
    // 自动更新开关以配置为准，主进程读到的就是 config.json 里的值
    State.autoUpdate = updateState.autoUpdate !== false;
    State.ghProxyEnabled = updateState.ghProxyEnabled === true;
    renderUpdateUI();
}

// 打开设置页 / 切换数据目录后调用：开关状态跟随配置，其余沿用最近一次状态
function syncUpdateSettingsUI() {
    if (IS_PORTABLE_RUN) return;
    const toggle = updateEl('setting-auto-update');
    if (toggle) toggle.checked = State.autoUpdate !== false;
    // gh-proxy 加速开关以 State 为准（便携版不会走到这里，因为整个更新分类已被移除）
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
        detail: '应用将先退出，安装程序完成升级后自动重新打开；当前编辑的内容会先保存。',
        confirmLabel: '重启并安装'
    });
    if (!confirmed) return;

    // 升级过程会结束进程：先把待保存的编辑落盘，避免丢内容
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

// 项目地址：交给主进程用系统浏览器打开
function openProjectPage() {
    ipcRenderer.invoke('update:open-repo').catch((err) => {
        console.error('打开项目主页失败:', err);
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

// 便携版：把「系统」分类里的更新与版本分区（自动更新 / 新版本说明 / 版本信息 / 当前版本说明）从界面上摘掉
function removeUpdateSettingsUI() {
    document.querySelectorAll('#settings-view .settings-update-block').forEach((block) => block.remove());
}

function initUpdateSettings() {
    // 便携版整体移除更新功能：设置项与全部事件都不启用
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

    // gh-proxy 加速：与自动更新同一套做法，渲染进程写配置，主进程每次检查 / 下载时现读
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

    // 「永不提醒」：勾选后关闭更新弹窗，主进程会把配置里的自动更新关掉，这里同步开关并说明一次
    ipcRenderer.on('update:auto-disabled', () => {
        State.autoUpdate = false;
        updateState = { ...updateState, autoUpdate: false };
        syncUpdateSettingsUI();
        showToast('已按「永不提醒」关闭自动检查并下载更新，可在设置中重新开启');
    });

    syncUpdateSettingsUI();
    refreshUpdateInfo();
}
