/* WebDAV 同步：设置页里的服务器地址、账号、口令与远程目录，以及测试连接与三种同步动作。

   同步本身在主进程完成（见 src/main/webdav.js）：地址、账号与远程目录和其余偏好一起写进
   config.json，口令只在提交时交给主进程（由系统密钥链加密保存，见 main/secret_store.js），
   界面只回显「有没有保存」与保管方式。上传 / 下载 / 同步的进度由主进程通过 webdav:progress 推回。

   下载会覆盖本地文件，因此同步开始前先把编辑中的内容落盘（比对的必须是磁盘上的最新内容）；
   下载完成后重新载入一次数据，让界面与刚被覆盖的磁盘内容保持一致。 */

// 输入过程中攒一下再落盘，避免每敲一个字符就写一次 config.json
const WEBDAV_CONFIG_SAVE_DELAY = 400;
// 远程目录的默认值：与主进程的 DEFAULT_REMOTE_DIR 保持一致
const WEBDAV_DEFAULT_REMOTE_DIR = 'EsprinNemo';
// 使用模式（把 WebDAV 直接当储存源）的标识：与主进程的 STORAGE_MODE 保持一致
const WEBDAV_STORAGE_MODE = 'storage';

let webdavConfigSaveTimer = null;
// 同步进行中：按钮统一置灰，避免重复点击（主进程侧也会拦并发）
let webdavBusy = false;

function isWebdavEnabled() {
    return !State.webdav || State.webdav.enabled !== false;
}

// 当前是否为「使用模式」：服务器是主储存源，本地目录只是缓存
function isWebdavStorageMode() {
    return normalizeWebdavConfig(State.webdav).mode === WEBDAV_STORAGE_MODE;
}

function scheduleWebdavConfigSave() {
    clearTimeout(webdavConfigSaveTimer);
    webdavConfigSaveTimer = setTimeout(() => {
        webdavConfigSaveTimer = null;
        saveConfig();
    }, WEBDAV_CONFIG_SAVE_DELAY);
}

function flushWebdavConfigSave() {
    if (webdavConfigSaveTimer) {
        clearTimeout(webdavConfigSaveTimer);
        webdavConfigSaveTimer = null;
        saveConfig();
    }
    // 间隔 / 地址 / 模式可能刚被改过：让主进程按最新配置重建自动同步的定时器
    syncWebdavAutoSyncSetting();
}

/* ---------------- 自动双向同步（同步模式） ----------------
   选项与取值规则在 storage.js 的 WEBDAV_AUTO_SYNC_* 里，主进程按同一套秒数启定时器。 */

// 秒数 → 人读的间隔（60 的整数倍按分钟写）
function formatWebdavInterval(seconds) {
    const num = normalizeAutoSyncSeconds(seconds);
    if (num >= 60 && num % 60 === 0) return `${num / 60} 分钟`;
    return `${num} 秒`;
}

// 自动同步设置的说明文字（关掉、每次启动，还是每隔多久）
function describeAutoSyncSetting() {
    const config = normalizeWebdavConfig(State.webdav);
    if (config.autoSync === 'startup') return '每次启动应用时同步一次';
    if (config.autoSync === 'custom') return `每 ${formatWebdavInterval(config.autoSyncSeconds)}`;
    const seconds = WEBDAV_AUTO_SYNC_PRESETS[config.autoSync];
    return seconds > 0 ? `每 ${formatWebdavInterval(seconds)}` : '已关闭';
}

// 下拉里选的预设（非法值按关闭处理）
function readAutoSyncSelection() {
    const select = document.getElementById('setting-webdav-autosync');
    const value = select ? select.value : 'off';
    return WEBDAV_AUTO_SYNC_VALUES.includes(value) ? value : 'off';
}

// 「自定义」间隔：把填的数字按所选单位换算成秒
function readAutoSyncSecondsFromForm() {
    const input = document.getElementById('setting-webdav-autosync-value');
    const unit = document.getElementById('setting-webdav-autosync-unit');
    const value = Number(input ? input.value : '');
    if (!Number.isFinite(value) || value <= 0) return normalizeAutoSyncSeconds(State.webdav.autoSyncSeconds);
    const seconds = unit && unit.value === 'minute' ? value * 60 : value;
    return normalizeAutoSyncSeconds(seconds);
}

// 自定义间隔的输入框：秒数能被 60 整除时用「分钟」显示；非自定义时整块隐藏
function syncAutoSyncCustomInputs(config) {
    const row = document.getElementById('setting-webdav-autosync-custom-row');
    if (!row) return;

    const custom = config.autoSync === 'custom';
    row.classList.toggle('hidden', !custom);
    if (!custom) return;

    const seconds = normalizeAutoSyncSeconds(config.autoSyncSeconds);
    const useMinute = seconds % 60 === 0;
    const unit = document.getElementById('setting-webdav-autosync-unit');
    const input = document.getElementById('setting-webdav-autosync-value');
    if (unit) unit.value = useMinute ? 'minute' : 'second';
    if (input) input.value = String(useMinute ? seconds / 60 : seconds);
}

// 配置改完后让主进程按新间隔重建定时器，并把最新状态回填到状态行
async function syncWebdavAutoSyncSetting() {
    try {
        applyWebdavAutoStatus(await ipcRenderer.invoke('webdav:apply-auto-sync'));
    } catch (err) {
        console.error('应用 WebDAV 自动同步设置失败:', err);
    }
}

// 主进程上报的自动同步状态：只在出错 / 有文件待上传时改写状态行
function applyWebdavAutoStatus(status) {
    if (!status) return;
    if (status.lastError) {
        setWebdavStatus(`自动同步最近一次未成功 —— ${status.lastError}`, 'error');
    } else if (status.pending) {
        setWebdavStatus(`使用模式：有 ${status.pending} 个文件正在上传…`);
    }
}

async function refreshWebdavAutoStatus() {
    try {
        applyWebdavAutoStatus(await ipcRenderer.invoke('webdav:auto-status'));
    } catch (err) {
        console.error('读取 WebDAV 自动同步状态失败:', err);
    }
}

/* ---------------- 状态与配置 ---------------- */

// 面板状态行：tone 为 ok / error 时着色，缺省为普通说明文字
function setWebdavStatus(text, tone) {
    const status = document.getElementById('webdav-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone || '';
}

function formatWebdavTime(stamp) {
    if (!stamp) return '';
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeWebdavConfigState() {
    const config = normalizeWebdavConfig(State.webdav);
    if (!config.url) {
        return '尚未配置：填写服务器地址、账号与口令后，即可把笔记与待办备份到 WebDAV 服务器。';
    }
    if (config.username && !State.webdavHasPassword) {
        return '还差口令：已填写账号，还需要保存对应的口令（多数网盘要的是「应用密码」而不是登录密码）。';
    }

    const who = config.username ? `${config.username} @ ` : '';
    const remote = config.remoteDir || WEBDAV_DEFAULT_REMOTE_DIR;
    const last = config.lastSyncAt
        ? `上次同步：${formatWebdavTime(config.lastSyncAt)}${config.lastSyncSummary ? `（${config.lastSyncSummary}）` : ''}。`
        : '还没有同步过。';
    const mode = isWebdavStorageMode()
        ? '使用模式：服务器是主储存源，本地目录只是它的缓存——保存后即时上传，本地删除也会同步到服务器，'
            + '启动后与每 5 分钟自动对齐一次。'
        : `同步模式：本地数据目录是主副本，自动双向同步${describeAutoSyncSetting()}。`;
    return `${mode} 已配置：${who}${config.url}，远程目录 ${remote}。${last}`;
}

// 文本类字段：输入时只更新内存并稍后落盘，失焦/回车时立即落盘（与 AI 面板一致）
function readWebdavConfigFromForm() {
    const field = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    };

    State.webdav = normalizeWebdavConfig({
        // 保留上次同步的时刻与结果（表单里没有这两项）
        ...State.webdav,
        url: field('setting-webdav-url'),
        username: field('setting-webdav-username'),
        remoteDir: field('setting-webdav-remote'),
        autoSync: readAutoSyncSelection(),
        autoSyncSeconds: readAutoSyncSecondsFromForm()
    });
}

function refreshWebdavConfigViews() {
    setWebdavStatus(describeWebdavConfigState());
}

// 把配置落回界面：读写输入框、总开关与配置状态行
function syncWebdavSettingsUI() {
    const urlInput = document.getElementById('setting-webdav-url');
    if (!urlInput) return;

    const webdav = normalizeWebdavConfig(State.webdav);
    State.webdav = webdav;

    urlInput.value = webdav.url;
    document.getElementById('setting-webdav-username').value = webdav.username;
    document.getElementById('setting-webdav-remote').value = webdav.remoteDir;
    document.getElementById('setting-webdav-enabled').checked = webdav.enabled !== false;
    const modeSelect = document.getElementById('setting-webdav-mode');
    if (modeSelect) modeSelect.value = webdav.mode;

    // 自动双向同步只在同步模式下可选：使用模式有自己的节奏（保存即上传 + 每 5 分钟对齐）
    const autoRow = document.getElementById('setting-webdav-autosync-row');
    if (autoRow) autoRow.classList.toggle('hidden', webdav.mode === WEBDAV_STORAGE_MODE);
    const autoSelect = document.getElementById('setting-webdav-autosync');
    if (autoSelect) autoSelect.value = webdav.autoSync;
    syncAutoSyncCustomInputs(webdav);

    // 两种模式下那几个按钮的含义不同：使用模式已经在自动同步，它们只作手动兜底
    const syncDesc = document.getElementById('webdav-sync-desc');
    if (syncDesc) {
        syncDesc.textContent = webdav.mode === WEBDAV_STORAGE_MODE
            ? '使用模式下这几个按钮通常用不上：每次保存已即时上传，启动后与每 5 分钟自动对齐；刚从离线状态恢复、或想立刻与服务器对齐时可以手动点一次「双向同步」'
            : '上传＝把本地数据备份到服务器（服务器上多出来的文件不动）；下载＝用服务器上的版本覆盖本地同名文件；双向同步＝两侧同名的文件由较新的一方胜出。三者都不会删除任何一侧多出来的文件';
    }

    // 关掉设置页再回来时输入框恢复为空 + 掩码显示（里面从不保留明文）
    const passwordInput = document.getElementById('setting-webdav-password');
    passwordInput.value = '';
    passwordInput.type = 'password';
    const passwordToggle = document.getElementById('btn-webdav-password-toggle');
    if (passwordToggle) passwordToggle.innerHTML = '<span class="ms-icon xs">visibility</span>';

    applyWebdavPasswordStatus({
        hasPassword: State.webdavHasPassword,
        encrypted: State.webdavPasswordStorage === 'encrypted',
        strong: State.webdavPasswordStorage === 'keychain'
    });
    refreshWebdavPasswordStatus();
    applyWebdavEnabledState();
    refreshWebdavConfigViews();
    refreshWebdavAutoStatus();
}

// 总开关状态落到界面上：配置区一起显隐
function applyWebdavEnabledState() {
    const enabled = isWebdavEnabled();
    document.querySelectorAll('#settings-view .webdav-config-section').forEach((section) => {
        section.classList.toggle('hidden', !enabled);
    });
    const hint = document.getElementById('webdav-disabled-hint');
    if (hint) hint.classList.toggle('hidden', enabled);
}

function toggleWebdavEnabled(enabled) {
    State.webdav = normalizeWebdavConfig({ ...State.webdav, enabled });
    flushWebdavConfigSave();
    applyWebdavEnabledState();
    // 总开关也决定自动同步能不能跑（关掉就不该再定时联网）
    syncWebdavAutoSyncSetting();
    showToast(enabled ? '已启用 WebDAV 同步' : '已关闭 WebDAV 同步');
}

// 地址快捷填入：把常用服务的地址一键写进输入框（端口与路径仍按实际部署调整）
function applyWebdavUrlPreset(url) {
    const input = document.getElementById('setting-webdav-url');
    if (!input || !url) return;

    input.value = url;
    readWebdavConfigFromForm();
    flushWebdavConfigSave();
    refreshWebdavConfigViews();
    showToast(`已填入服务器地址：${url}`);
}

/* ---------------- 口令：只经主进程进出，渲染进程不留明文 ---------------- */

// 主进程上报的保管方式：keychain（系统密钥链）/ encrypted（系统加密但非密钥链）/ plain（仅本机可读的文件）
function webdavPasswordStorageKind(status) {
    if (!status || !status.hasPassword) return '';
    if (status.strong) return 'keychain';
    return status.encrypted ? 'encrypted' : 'plain';
}

function describeWebdavPasswordStorage() {
    if (!State.webdavHasPassword) return '尚未保存口令：填写后回车即可保存，口令不会写入配置或笔记文件。';
    if (State.webdavPasswordStorage === 'keychain') return '已保存到系统密钥链（内存与磁盘上均为密文）。';
    if (State.webdavPasswordStorage === 'encrypted') return '已保存（当前系统未提供密钥链，仅做了基础加密）。';
    return '已保存（当前系统不支持加密存储，已按仅本机可读的文件权限保存）。';
}

// 把主进程返回的口令状态落到界面：输入框提示语、清除按钮与状态说明
function applyWebdavPasswordStatus(status) {
    State.webdavHasPassword = !!(status && status.hasPassword);
    State.webdavPasswordStorage = webdavPasswordStorageKind(status);

    const passwordInput = document.getElementById('setting-webdav-password');
    if (passwordInput) {
        // 输入框里永远不放明文：已保存时留空，填写即表示「换成新的」
        passwordInput.placeholder = State.webdavHasPassword ? '已保存，如需更换请直接输入新的口令' : '密码 / 应用密码';
    }
    const clearBtn = document.getElementById('btn-webdav-password-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !State.webdavHasPassword);

    const hint = document.getElementById('webdav-password-hint');
    if (hint) hint.textContent = describeWebdavPasswordStorage();
}

async function refreshWebdavPasswordStatus() {
    try {
        applyWebdavPasswordStatus(await ipcRenderer.invoke('webdav:password-status'));
    } catch (err) {
        console.error('读取 WebDAV 口令状态失败:', err);
    }
}

// 提交输入框里的新口令：成功后立即清空输入框，界面只保留状态
async function commitWebdavPasswordFromForm() {
    const input = document.getElementById('setting-webdav-password');
    if (!input) return false;
    const password = input.value.trim();
    if (!password) return false;

    try {
        const result = await ipcRenderer.invoke('webdav:set-password', { password });
        if (!result || !result.ok) {
            setWebdavStatus((result && result.error) || '保存 WebDAV 口令失败', 'error');
            return false;
        }
        input.value = '';
        applyWebdavPasswordStatus(result);
        refreshWebdavConfigViews();
        // 口令刚补上：之前因缺口令而没起来的自动同步定时器这时才有意义
        syncWebdavAutoSyncSetting();
        showToast('WebDAV 口令已保存到本机安全存储');
        return true;
    } catch (err) {
        console.error('保存 WebDAV 口令失败:', err);
        setWebdavStatus('保存 WebDAV 口令失败', 'error');
        return false;
    }
}

// 清除已保存的口令：需要确认，避免误点后同步失败
async function clearWebdavPassword() {
    const confirmed = await showConfirm('清除已保存的 WebDAV 口令？', {
        title: '清除 WebDAV 口令',
        detail: '清除后同步需要重新填写口令；已填写的服务器地址、账号与远程目录不受影响。',
        confirmLabel: '清除',
        danger: true
    });
    if (!confirmed) return;

    try {
        const result = await ipcRenderer.invoke('webdav:clear-password');
        if (!result || !result.ok) {
            setWebdavStatus((result && result.error) || '清除 WebDAV 口令失败', 'error');
            return;
        }
        applyWebdavPasswordStatus(result);
        refreshWebdavConfigViews();
        // 口令没了，自动同步也跑不动：让主进程重算一次定时器
        syncWebdavAutoSyncSetting();
        showToast('已清除保存的 WebDAV 口令');
    } catch (err) {
        console.error('清除 WebDAV 口令失败:', err);
        setWebdavStatus('清除 WebDAV 口令失败', 'error');
    }
}

/* ---------------- 同步动作 ---------------- */

/* 诊断：生成一份报告（服务器原始响应 + 解析结果 + 两侧文件 + 同步计划）并打开。
   同步方向不对时把这份报告发出来就能定位，不必来回猜。 */
async function runWebdavDiagnose() {
    if (webdavBusy) return;
    readWebdavConfigFromForm();
    flushWebdavConfigSave();

    setWebdavBusy(true);
    setWebdavStatus('正在生成诊断报告…');
    try {
        const result = await ipcRenderer.invoke('webdav:diagnose');
        if (!result || !result.ok) {
            setWebdavStatus('生成诊断报告失败', 'error');
            return;
        }
        setWebdavStatus(result.path
            ? `诊断报告已生成并打开：${result.path}`
            : '诊断报告已生成，但没能写入文件（配置目录不可用）', 'ok');
        showToast('WebDAV 诊断报告已生成');
    } catch (err) {
        console.error('生成 WebDAV 诊断报告失败:', err);
        setWebdavStatus('生成诊断报告失败', 'error');
    } finally {
        setWebdavBusy(false);
    }
}

/* 切换使用方式。
   同步模式 → 使用模式：先把两侧对齐一次（较新者胜出、不删任何一侧多出来的文件），
   之后由主进程接管——每次保存即时上传，启动与定时自动对齐；
   使用模式 → 同步模式：停掉自动动作，本地改动回到手动同步。 */
async function changeWebdavMode(mode) {
    const next = mode === WEBDAV_STORAGE_MODE ? WEBDAV_STORAGE_MODE : 'sync';
    const current = normalizeWebdavConfig(State.webdav).mode;
    if (next === current || webdavBusy) {
        syncWebdavSettingsUI();
        return;
    }

    const toStorage = next === WEBDAV_STORAGE_MODE;
    if (toStorage && !State.webdav.url) {
        setWebdavStatus('请先填写服务器地址并保存口令，再切换到使用模式', 'error');
        syncWebdavSettingsUI();
        return;
    }

    const confirmed = await showConfirm(toStorage ? '切换到使用模式？' : '切换回同步模式？', {
        title: 'WebDAV 使用方式',
        detail: toStorage
            ? '使用模式把 WebDAV 服务器直接当作储存源：本地数据目录只是它的缓存，'
                + '每次保存即时上传，本地删除也会同步到服务器，启动后与每 5 分钟自动对齐一次。\n'
                + '切换时会先做一次双向对齐：两侧同名的文件由较新的一方覆盖较旧的一方，'
                + '任何一侧多出来的文件都不会被删除。'
            : '切换后不再自动上传与对齐，本地改动要手动点「上传到服务器」或「双向同步」才会同步；'
                + '已经同步到服务器的内容不受影响。',
        confirmLabel: '切换'
    });
    if (!confirmed) {
        syncWebdavSettingsUI();
        return;
    }

    // 先写配置（主进程按它判断模式），并把编辑中的内容落盘，首次对齐比对的才是最新内容
    State.webdav = normalizeWebdavConfig({ ...State.webdav, mode: next });
    saveConfig();
    flushPendingSave();
    flushActiveAiChatSave();

    setWebdavBusy(true);
    setWebdavStatus(toStorage ? '正在切换到使用模式并做首次对齐…' : '正在切换回同步模式…');
    try {
        const result = await ipcRenderer.invoke('webdav:set-mode', { mode: next });
        const align = result && result.firstAlign;

        if (align && align.lastSyncAt) {
            State.webdav = normalizeWebdavConfig({
                ...State.webdav,
                lastSyncAt: align.lastSyncAt,
                lastSyncSummary: align.summary || ''
            });
            saveConfig();
        }

        // 首次对齐下载了文件（哪怕其中有个别失败）也要重载一次：界面与磁盘必须一致
        if (align && align.downloaded > 0) {
            adoptDataDir(DATA_DIR, { message: align.summary || '已从服务器载入数据' });
        }

        if (!result || !result.ok) {
            const error = (result && result.error) || '未知原因';
            setWebdavStatus(`${toStorage ? '已切换到使用模式' : '已切换模式'}，但首次对齐未完全成功：${error}`, 'error');
            showToast('模式已切换，但首次对齐未完全成功，详情见设置页');
            return;
        }

        const conflictNote = align && align.conflictCount
            ? `　${align.conflictCount} 个文件两侧都有且内容不同、无法判断哪边更新，本轮没有动它们`
                + `（${align.conflicts.slice(0, 3).join('、')}）：想以服务器为准请点「从服务器下载」，想以本地为准请点「上传到服务器」`
            : '';
        setWebdavStatus(toStorage
            ? `已启用使用模式：${align ? `${align.summary}（上传 ${align.uploaded}、下载 ${align.downloaded}），` : ''}`
                + `此后保存即上传，启动与每 5 分钟自动对齐。${conflictNote}`
            : '已切换回同步模式：本地改动需要手动同步。', 'ok');
        showToast(toStorage ? 'WebDAV 已启用使用模式' : 'WebDAV 已切换回同步模式');
    } catch (err) {
        console.error('切换 WebDAV 使用方式失败:', err);
        setWebdavStatus('切换使用方式失败，请检查服务器地址与网络', 'error');
    } finally {
        setWebdavBusy(false);
        syncWebdavSettingsUI();
    }
}

function setWebdavProgress(done, total, text) {
    const fill = document.getElementById('webdav-progress-fill');
    const label = document.getElementById('webdav-progress-text');
    if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    if (label) label.textContent = text || '';
}

function setWebdavBusy(busy) {
    webdavBusy = busy;
    ['btn-webdav-test', 'btn-webdav-diagnose', 'btn-webdav-upload', 'btn-webdav-download', 'btn-webdav-sync'].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = busy;
    });

    const progress = document.getElementById('webdav-progress');
    if (progress) progress.classList.toggle('hidden', !busy);
    setWebdavProgress(0, 0, '');
}

// 主进程推回来的同步进度：连接 / 列举阶段没有总数，用文字说明当前在做什么
function handleWebdavProgress(payload) {
    if (!payload || !webdavBusy) return;
    if (payload.phase === 'connect') {
        setWebdavProgress(0, 0, '正在连接服务器…');
        return;
    }
    if (payload.phase === 'list') {
        setWebdavProgress(0, 0, '正在读取远程目录…');
        return;
    }
    if (payload.phase === 'done') {
        setWebdavProgress(1, 1, '正在收尾…');
        return;
    }
    setWebdavProgress(payload.done, payload.total, `${payload.done}/${payload.total}  ${payload.current}`);
}

// 连接测试：登入服务器、建出远程目录，并报告其中已有的文件数
async function testWebdavConnection() {
    if (webdavBusy) return;
    readWebdavConfigFromForm();
    if (!State.webdav.url) {
        setWebdavStatus('请先填写服务器地址', 'error');
        return;
    }
    flushWebdavConfigSave();
    // 刚粘贴进来的口令可能还没失焦提交，先落定再测试
    await commitWebdavPasswordFromForm();

    setWebdavBusy(true);
    setWebdavStatus('正在测试连接…');
    try {
        const result = await ipcRenderer.invoke('webdav:test');
        if (!result || !result.ok) {
            setWebdavStatus((result && result.error) || '连接测试失败', 'error');
            return;
        }
        // 连接成功也刷新一次状态行：测试会顺带把远程目录建出来
        setWebdavStatus(`连接正常：远程目录 ${result.remoteDir} 已就绪，其中有 ${result.fileCount} 个文件。`, 'ok');
        showToast('WebDAV 连接测试通过');
    } catch (err) {
        console.error('WebDAV 连接测试失败:', err);
        setWebdavStatus('连接测试失败', 'error');
    } finally {
        setWebdavBusy(false);
    }
}

// 三种同步动作的确认文案：写清「谁覆盖谁」以及不会发生什么，避免误操作丢数据
const WEBDAV_SYNC_CONFIRM = {
    upload: {
        message: '把本地数据上传到 WebDAV 服务器？',
        detail: '服务器上的同名文件会被本地版本覆盖；服务器上多出来的文件保持不动，不会被删除。',
        confirmLabel: '开始上传'
    },
    download: {
        message: '从 WebDAV 服务器下载并覆盖本地数据？',
        detail: '本地同名文件会被服务器上的版本覆盖，此操作不可撤销；本地多出来的文件不会删除。'
            + '建议先做一次「上传到服务器」，给当前内容留一份备份。',
        confirmLabel: '开始下载'
    },
    both: {
        message: '在本地与 WebDAV 服务器之间双向同步？',
        detail: '两侧同名的文件由修改时间较新的一方覆盖较旧的一方；任何一侧多出来的文件都不会被删除。',
        confirmLabel: '开始同步'
    }
};

async function runWebdavSync(mode) {
    if (webdavBusy) return;
    const confirmText = WEBDAV_SYNC_CONFIRM[mode];
    if (!confirmText) return;

    readWebdavConfigFromForm();
    if (!State.webdav.url) {
        setWebdavStatus('请先填写服务器地址', 'error');
        return;
    }

    const confirmed = await showConfirm(confirmText.message, {
        title: 'WebDAV 同步',
        detail: confirmText.detail,
        confirmLabel: confirmText.confirmLabel,
        danger: mode === 'download'
    });
    if (!confirmed) return;

    // 同步比对的是磁盘上的文件：先把编辑中的笔记与当前对话落盘
    flushPendingSave();
    flushActiveAiChatSave();
    flushWebdavConfigSave();

    setWebdavBusy(true);
    setWebdavStatus('正在同步…');
    try {
        const result = await ipcRenderer.invoke('webdav:sync', { mode });

        if (result && result.lastSyncAt) {
            State.webdav = normalizeWebdavConfig({
                ...State.webdav,
                lastSyncAt: result.lastSyncAt,
                lastSyncSummary: result.summary || ''
            });
            saveConfig();
        }

        // 本地文件被服务器版本覆盖时，重新载入一遍：界面、编辑器与磁盘必须一致
        if (result && result.downloaded > 0) {
            adoptDataDir(DATA_DIR, { message: result.summary || '已从 WebDAV 服务器下载数据' });
        }

        if (!result || !result.ok) {
            if (!result) {
                setWebdavStatus('同步失败，请检查服务器地址与网络', 'error');
                return;
            }
            // 失败明细逐条写进控制台，状态行里给出数量与前两个文件名，便于判断是哪一类文件出的问题
            (result.failures || []).forEach((item) => {
                console.warn(`WebDAV 同步失败：${item.path}（${item.action === 'upload' ? '上传' : '下载'}）：${item.error}`);
            });
            const names = (result.failures || []).slice(0, 2).map((item) => item.path).join('、');
            setWebdavStatus(`${result.error}（上传 ${result.uploaded}、下载 ${result.downloaded}`
                + `${names ? `，如 ${names}` : ''}）`, 'error');
            showToast('WebDAV 同步未完全成功，详情见设置页');
            return;
        }

        const conflictNote = result.conflictCount
            ? `　${result.conflictCount} 个文件两侧都有且内容不同、判断不出哪边更新（服务器没有提供可用的修改时间），本轮没有动它们`
                + `（${result.conflicts.slice(0, 3).join('、')}${result.conflictCount > 3 ? ' 等' : ''}）：`
                + '想以服务器为准请点「从服务器下载」，想以本地为准请点「上传到服务器」'
            : '';
        setWebdavStatus(`${result.summary}（上传 ${result.uploaded}、下载 ${result.downloaded}、未变化 ${result.skipped}，`
            + `用时 ${Math.max(Math.round(result.durationMs / 1000), 1)} 秒）${conflictNote}`, 'ok');
        showToast(result.summary);
    } catch (err) {
        console.error('WebDAV 同步失败:', err);
        setWebdavStatus('同步失败，请检查服务器地址与网络', 'error');
    } finally {
        setWebdavBusy(false);
        refreshWebdavConfigViews();
    }
}

function initWebdavSettings() {
    const urlInput = document.getElementById('setting-webdav-url');
    if (!urlInput) return;

    // 文本类字段：输入时只更新内存并稍后落盘，失焦/回车时立即落盘
    ['setting-webdav-url', 'setting-webdav-username', 'setting-webdav-remote'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.oninput = () => {
            readWebdavConfigFromForm();
            scheduleWebdavConfigSave();
        };
        el.onchange = () => {
            readWebdavConfigFromForm();
            flushWebdavConfigSave();
            refreshWebdavConfigViews();
        };
    });

    // 口令：失焦或回车即提交给主进程保存（成功后输入框立即清空）
    const passwordInput = document.getElementById('setting-webdav-password');
    if (passwordInput) {
        passwordInput.onchange = () => { commitWebdavPasswordFromForm(); };
        passwordInput.onkeydown = (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commitWebdavPasswordFromForm();
        };
    }

    const passwordClearBtn = document.getElementById('btn-webdav-password-clear');
    if (passwordClearBtn) passwordClearBtn.onclick = clearWebdavPassword;

    const passwordToggle = document.getElementById('btn-webdav-password-toggle');
    if (passwordToggle) {
        passwordToggle.onclick = () => {
            const input = document.getElementById('setting-webdav-password');
            const reveal = input.type === 'password';
            input.type = reveal ? 'text' : 'password';
            passwordToggle.innerHTML = `<span class="ms-icon xs">${reveal ? 'visibility_off' : 'visibility'}</span>`;
        };
    }

    // 地址快捷填入：坚果云 / Alist 等常见服务一键填好地址
    document.querySelectorAll('#settings-view .webdav-quick-chip').forEach((chip) => {
        chip.onclick = () => applyWebdavUrlPreset(chip.dataset.url || '');
    });

    const enabledToggle = document.getElementById('setting-webdav-enabled');
    if (enabledToggle) enabledToggle.onchange = (event) => toggleWebdavEnabled(event.target.checked);

    // 使用方式：同步模式（手动）/ 使用模式（把 WebDAV 当储存源）
    const modeSelect = document.getElementById('setting-webdav-mode');
    if (modeSelect) modeSelect.onchange = (event) => changeWebdavMode(event.target.value);

    // 自动双向同步（同步模式）：间隔预设 + 自定义秒数 / 分钟
    const autoSelect = document.getElementById('setting-webdav-autosync');
    if (autoSelect) {
        autoSelect.onchange = () => {
            readWebdavConfigFromForm();
            saveConfig();
            syncWebdavSettingsUI();
            syncWebdavAutoSyncSetting();
            showToast(`WebDAV 自动双向同步：${describeAutoSyncSetting()}`);
        };
    }
    ['setting-webdav-autosync-value', 'setting-webdav-autosync-unit'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.onchange = () => {
            readWebdavConfigFromForm();
            saveConfig();
            syncWebdavSettingsUI();
            syncWebdavAutoSyncSetting();
        };
    });

    const testBtn = document.getElementById('btn-webdav-test');
    if (testBtn) testBtn.onclick = testWebdavConnection;

    const diagnoseBtn = document.getElementById('btn-webdav-diagnose');
    if (diagnoseBtn) diagnoseBtn.onclick = runWebdavDiagnose;

    const uploadBtn = document.getElementById('btn-webdav-upload');
    if (uploadBtn) uploadBtn.onclick = () => runWebdavSync('upload');

    const downloadBtn = document.getElementById('btn-webdav-download');
    if (downloadBtn) downloadBtn.onclick = () => runWebdavSync('download');

    const syncBtn = document.getElementById('btn-webdav-sync');
    if (syncBtn) syncBtn.onclick = () => runWebdavSync('both');

    // 同步进度由主进程主动推送（设置页关掉时同样在后台收着，重新打开即可继续显示）
    ipcRenderer.on('webdav:progress', (event, payload) => handleWebdavProgress(payload));

    /* 使用模式的自动对齐下载了新内容：重新载入一次，界面才会看到别的设备改过的文件。
       先落盘再重载——对齐覆盖掉的可能是编辑器里正在编辑的那一篇 */
    ipcRenderer.on('webdav:remote-changed', (event, payload) => {
        if (!payload) return;
        if (payload.lastSyncAt) {
            State.webdav = normalizeWebdavConfig({
                ...State.webdav,
                lastSyncAt: payload.lastSyncAt,
                lastSyncSummary: payload.lastSyncSummary || ''
            });
            saveConfig();
        }
        if (!payload.downloaded) {
            refreshWebdavConfigViews();
            return;
        }

        flushPendingSave();
        flushActiveAiChatSave();
        adoptDataDir(DATA_DIR, { message: payload.summary || `已从服务器同步 ${payload.downloaded} 个文件` });
        refreshWebdavConfigViews();
    });

    syncWebdavSettingsUI();
}
