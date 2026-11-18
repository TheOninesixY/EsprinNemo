const SYNC_CONFIG_SAVE_DELAY = 400;
let syncConfigSaveTimer = null;

const SYNC_PASSWORD_MIN = 8;

let syncBusy = false;

let syncServerStatus = null;

function isSyncEnabled() {
    return !!(State.syncServer && State.syncServer.enabled === true);
}

function syncConfig() {
    return normalizeSyncServerConfig(State.syncServer);
}

function scheduleSyncConfigSave() {
    clearTimeout(syncConfigSaveTimer);
    syncConfigSaveTimer = setTimeout(() => {
        syncConfigSaveTimer = null;
        saveConfig();
    }, SYNC_CONFIG_SAVE_DELAY);
}

function flushSyncConfigSave() {
    clearTimeout(syncConfigSaveTimer);
    syncConfigSaveTimer = null;
    saveConfig();

    syncSyncAutoSetting();
}

function formatSyncInterval(seconds) {
    const num = normalizeAutoSyncSeconds(seconds);
    if (num >= 60 && num % 60 === 0) return `${num / 60} 分钟`;
    return `${num} 秒`;
}

function describeSyncAutoSetting() {
    const config = syncConfig();
    if (config.autoSync === 'custom') return `每 ${formatSyncInterval(config.autoSyncSeconds)}`;
    const seconds = SYNC_AUTO_SYNC_PRESETS[config.autoSync];

    return seconds > 0 ? `每 ${formatSyncInterval(seconds)}` : '不定时（每次启动仍同步一次）';
}

function readSyncAutoSelection() {
    const select = document.getElementById('setting-sync-autosync');
    const value = select ? select.value : 'off';
    return SYNC_AUTO_SYNC_VALUES.includes(value) ? value : 'off';
}

function readSyncAutoSecondsFromForm() {
    const input = document.getElementById('setting-sync-autosync-value');
    const unit = document.getElementById('setting-sync-autosync-unit');
    const value = Number(input ? input.value : '');
    if (!Number.isFinite(value) || value <= 0) return normalizeAutoSyncSeconds(syncConfig().autoSyncSeconds);
    const seconds = unit && unit.value === 'minute' ? value * 60 : value;
    return normalizeAutoSyncSeconds(seconds);
}

function syncSyncAutoCustomInputs(config) {
    const row = document.getElementById('setting-sync-autosync-custom-row');
    if (!row) return;

    const custom = config.autoSync === 'custom';
    row.classList.toggle('hidden', !custom);
    if (!custom) return;

    const seconds = normalizeAutoSyncSeconds(config.autoSyncSeconds);
    const useMinute = seconds % 60 === 0;
    const unit = document.getElementById('setting-sync-autosync-unit');
    const input = document.getElementById('setting-sync-autosync-value');
    if (unit) unit.value = useMinute ? 'minute' : 'second';
    if (input) input.value = String(useMinute ? seconds / 60 : seconds);
}

function setSyncStatus(text, tone) {
    const status = document.getElementById('sync-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone || '';
}

function formatSyncTime(stamp) {
    if (!stamp) return '';
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeSyncState() {
    const config = syncConfig();
    if (!config.url) {
        return '尚未配置：填写服务器地址，再用「账户登录」生成令牌（或在服务端管理页创建令牌后填入）即可同步。';
    }

    const device = config.device ? `，设备名 ${config.device}` : '';
    const last = config.lastSyncAt
        ? `上次同步：${formatSyncTime(config.lastSyncAt)}${config.lastSyncSummary ? `（${config.lastSyncSummary}）` : ''}。`
        : '尚无同步记录。';
    const progress = syncServerStatus
        ? `已应用到序号 ${syncServerStatus.lastSeq}${syncServerStatus.pending ? `，待推送 ${syncServerStatus.pending} 条` : ''}。`
        : '';

    return `已配置：${config.url}${device}；自动同步：${describeSyncAutoSetting()}。${progress}${last}`;
}

function applySyncStatus(status) {
    if (!status) return;
    syncServerStatus = status;
    State.syncTokenSaved = !!status.hasToken;
    applySyncDeviceId(status);

    applySyncLoginHint();

    if (status.lastError) setSyncStatus(`同步失败：${status.lastError}`, 'error');
    else setSyncStatus(describeSyncState());
}

async function refreshSyncStatus() {
    try {
        applySyncStatus(await ipcRenderer.invoke('sync:status'));
    } catch (err) {
        console.error('读取同步状态失败:', err);
    }
}

async function syncSyncAutoSetting() {
    try {
        applySyncStatus(await ipcRenderer.invoke('sync:apply-auto-sync'));
    } catch (err) {
        console.error('应用同步设置失败:', err);
    }
}

function applySyncDeviceId(status) {
    const input = document.getElementById('setting-sync-device-id');
    if (!input || !status) return;
    if (typeof status.deviceId !== 'string' || !status.deviceId) return;
    input.value = status.deviceId;
}

function copySyncDeviceId() {
    const input = document.getElementById('setting-sync-device-id');
    const value = input ? input.value.trim() : '';
    if (!value) {
        showToast('设备 ID 尚未生成，请稍后再试');
        return;
    }
    try {
        require('electron').clipboard.writeText(value);
        showToast('已复制设备 ID');
    } catch (err) {
        console.error('复制设备 ID 失败:', err);
        showToast('复制失败');
    }
}

const RECYCLE_CLAIM_COUNT = 2;

let recycledIdPool = [];

let locallyFreedIds = [];
let recycledRefillPending = false;

async function refillRecycledIds(kind = '', retry = true) {
    if (!isSyncEnabled() || recycledRefillPending) return;
    recycledRefillPending = true;
    try {

        const wanted = kind === 'todo' ? 'todos' : (kind === 'note' ? 'notes' : '');
        const claim = () => ipcRenderer.invoke('sync:claim-ids', { count: RECYCLE_CLAIM_COUNT, kind: wanted });

        let result = await claim();

        if (result && result.ok && !result.ids.length && result.pending && retry) {
            const synced = await ipcRenderer.invoke('sync:now');
            if (synced && synced.ok) result = await claim();
        }
        if (!result || !result.ok) return;

        const ids = (Array.isArray(result.ids) ? result.ids : [])

            .filter((item) => item && item.id && !itemIdTaken(String(item.id)))
            .map((item) => ({ id: String(item.id), kind: String(item.kind || '') }));
        if (ids.length) recycledIdPool = ids;
    } catch (err) {
        console.error('领取可复用 ID 失败:', err);
    } finally {
        recycledRefillPending = false;
    }
}

function releaseRecycledItemId(relative) {
    const match = /^(notes|todos)\/([A-Za-z0-9_-]{1,64})\.md$/.exec(String(relative || ''));
    if (!match) return;
    const entry = { id: match[2], kind: match[1] };
    locallyFreedIds = [entry].concat(locallyFreedIds.filter((item) => item.id !== entry.id));
}

function takePoolId(list, prefix) {
    if (!list.length) return '';
    const sameKind = list.findIndex((item) => item.kind === prefix);
    const entry = list.splice(sameKind === -1 ? 0 : sameKind, 1)[0];
    return entry ? String(entry.id) : '';
}

function takeRecycledItemId(kind) {
    const prefix = kind === 'todo' ? 'todos' : 'notes';

    const local = takePoolId(locallyFreedIds, prefix);
    if (local) return local;

    if (!recycledIdPool.length) {

        refillRecycledIds(kind, false).catch(() => {});
        return '';
    }
    const id = takePoolId(recycledIdPool, prefix);

    if (!recycledIdPool.length) refillRecycledIds(kind).catch(() => {});
    return id;
}

function applySyncTokenStatus(status) {
    State.syncTokenSaved = !!(status && status.hasToken);
    State.syncTokenStrong = !!(status && status.strong);

    const input = document.getElementById('setting-sync-token');
    if (input) {

        input.placeholder = State.syncTokenSaved ? '已保存；输入新的令牌即可替换' : '令牌';
    }
    const clearBtn = document.getElementById('btn-sync-token-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !State.syncTokenSaved);

    const hint = document.getElementById('sync-token-hint');
    if (hint) {
        if (!State.syncTokenSaved) {
            hint.textContent = '尚未保存令牌：可用上方的「账户登录」生成一个，或在服务端管理页（服务器地址 + /admin）创建后填入。';
        } else if (State.syncTokenStrong) {
            hint.textContent = '已保存到系统密钥链（内存与磁盘上均为密文）。';
        } else {
            hint.textContent = '已保存：当前系统未提供密钥链，仅按本机可读的文件权限保存。';
        }
    }

    applySyncLoginHint();
}

async function refreshSyncTokenStatus() {
    try {
        applySyncTokenStatus(await ipcRenderer.invoke('sync:token-status'));
    } catch (err) {
        console.error('读取同步令牌状态失败:', err);
    }
}

async function commitSyncTokenFromForm() {
    const input = document.getElementById('setting-sync-token');
    if (!input) return false;
    const token = input.value.trim();
    if (!token) return false;

    try {
        const result = await ipcRenderer.invoke('sync:set-token', { token });
        if (!result || !result.ok) {
            setSyncStatus((result && result.error) || '保存令牌失败：与主进程通信异常，请重试', 'error');
            return false;
        }
        input.value = '';
        applySyncTokenStatus(result);
        refreshSyncStatus();

        syncSyncAutoSetting();
        showToast('同步令牌已保存');
        return true;
    } catch (err) {
        console.error('保存同步令牌失败:', err);
        setSyncStatus('保存令牌失败：与主进程通信异常，请重试', 'error');
        return false;
    }
}

async function clearSyncToken() {
    const confirmed = await showConfirm('清除已保存的同步令牌？', {
        title: '清除同步令牌',
        detail: '清除后需重新填写令牌才能同步；服务器地址、设备名与自动同步设置不受影响。',
        confirmLabel: '清除',
        danger: true
    });
    if (!confirmed) return;

    try {
        const result = await ipcRenderer.invoke('sync:clear-token');
        if (!result || !result.ok) {
            setSyncStatus((result && result.error) || '清除令牌失败：与主进程通信异常，请重试', 'error');
            return;
        }
        applySyncTokenStatus(result);
        refreshSyncStatus();
        showToast('同步令牌已清除');
    } catch (err) {
        console.error('清除同步令牌失败:', err);
        setSyncStatus('清除令牌失败：与主进程通信异常，请重试', 'error');
    }
}

function setSyncLoginHint(text) {
    const hint = document.getElementById('sync-login-hint');
    if (hint) hint.textContent = text;
}

function describeSyncLoginState() {
    const account = syncConfig().account;
    const who = account ? `上次登录的账户「${account}」` : '尚未登录';
    if (!State.syncTokenSaved) return `${who}：填写账户名与密码后点「登录并生成令牌」`;
    return `${who}；令牌已保存，重新登录会为该账户再签发一个令牌`;
}

function applySyncLoginHint() {
    setSyncLoginHint(describeSyncLoginState());
}

async function loginSyncAccount() {
    if (syncBusy) return;
    readSyncConfigFromForm();
    const config = syncConfig();
    if (!config.url) {
        setSyncStatus('请先填写服务器地址', 'error');
        return;
    }

    const passwordInput = document.getElementById('setting-sync-password');
    const password = passwordInput ? passwordInput.value : '';
    if (!password) {
        setSyncLoginHint('请填写账户密码');
        return;
    }
    if (password.length < SYNC_PASSWORD_MIN) {
        setSyncLoginHint(`密码至少 ${SYNC_PASSWORD_MIN} 位`);
        return;
    }

if (State.syncTokenSaved) {
        const confirmed = await showConfirm('当前已保存访问令牌，仍要重新登录？', {
            title: '账户登录',
            detail: '服务端会为该账户再签发一个访问令牌，本机随即改用新的那个；旧令牌不会因此失效，'
                + '如不再需要可在服务端管理页（服务器地址 + /admin）里删除。',
            confirmLabel: '登录'
        });
        if (!confirmed) return;
    }

    ensureSyncEnabled();
    flushSyncConfigSave();

    setSyncBusy(true);
    setSyncStatus('正在登录并生成访问令牌…');
    try {
        const result = await ipcRenderer.invoke('sync:login', {
            account: config.account,
            password,

            tokenName: config.device ? `Esprin Nemo · ${config.device}` : 'Esprin Nemo'
        });
        if (!result || !result.ok) {
            setSyncStatus(`登录失败：${(result && result.error) || '与主进程通信异常，请重试'}`, 'error');
            return;
        }

        if (passwordInput) passwordInput.value = '';
        applySyncTokenStatus(result);
        await syncSyncAutoSetting();
        await refreshSyncStatus();
        const name = result.user && result.user.name ? result.user.name : (config.account || '内置账户');
        setSyncStatus(`已登录账户「${name}」，访问令牌已生成并保存；若该账户在服务端还没有数据，可接着点「首次接入」。`, 'ok');
        showToast('已登录并保存访问令牌');
    } catch (err) {
        console.error('账户登录失败:', err);
        setSyncStatus('登录失败：与主进程通信异常，请重试', 'error');
    } finally {
        setSyncBusy(false);
    }
}

function readSyncConfigFromForm() {
    const field = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    };

    State.syncServer = normalizeSyncServerConfig({

        ...State.syncServer,
        url: field('setting-sync-url'),
        account: field('setting-sync-account'),
        device: field('setting-sync-device'),
        autoSync: readSyncAutoSelection(),
        autoSyncSeconds: readSyncAutoSecondsFromForm()
    });
}

function syncSyncServerSettingsUI() {
    const urlInput = document.getElementById('setting-sync-url');
    if (!urlInput) return;

    const config = normalizeSyncServerConfig(State.syncServer);
    State.syncServer = config;

    urlInput.value = config.url;
    const accountInput = document.getElementById('setting-sync-account');
    if (accountInput) accountInput.value = config.account;
    document.getElementById('setting-sync-device').value = config.device;
    document.getElementById('setting-sync-enabled').checked = config.enabled === true;

    const autoSelect = document.getElementById('setting-sync-autosync');
    if (autoSelect) autoSelect.value = config.autoSync;
    syncSyncAutoCustomInputs(config);

const tokenInput = document.getElementById('setting-sync-token');
    if (tokenInput) {
        tokenInput.value = '';
        tokenInput.type = 'password';
    }
    const tokenToggle = document.getElementById('btn-sync-token-toggle');
    if (tokenToggle) tokenToggle.innerHTML = '<span class="ms-icon xs">visibility</span>';

const passwordInput = document.getElementById('setting-sync-password');
    if (passwordInput) passwordInput.value = '';

    applySyncTokenStatus({ hasToken: State.syncTokenSaved, strong: State.syncTokenStrong });
    applySyncEnabledState();
    refreshSyncTokenStatus();
    refreshSyncStatus();

    refillRecycledIds().catch(() => {});
}

function applySyncEnabledState() {
    const enabled = isSyncEnabled();
    document.querySelectorAll('#settings-view .sync-config-section').forEach((section) => {
        section.classList.toggle('hidden', !enabled);
    });
    const hint = document.getElementById('sync-disabled-hint');
    if (hint) hint.classList.toggle('hidden', enabled);
}

function toggleSyncEnabled(enabled) {
    State.syncServer = normalizeSyncServerConfig({ ...State.syncServer, enabled });

    saveConfig();
    applySyncEnabledState();

    syncSyncAutoSetting();
    showToast(enabled ? '已启用自建同步' : '已关闭自建同步');
}

function ensureSyncEnabled() {
    if (isSyncEnabled()) return false;
    State.syncServer = normalizeSyncServerConfig({ ...State.syncServer, enabled: true });
    saveConfig();
    applySyncEnabledState();
    return true;
}

function setSyncBusy(busy) {
    syncBusy = busy;
    ['btn-sync-test', 'btn-sync-now', 'btn-sync-import', 'btn-sync-diagnose', 'btn-sync-login'].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = busy;
    });
}

async function testSyncConnection() {
    if (syncBusy) return;
    readSyncConfigFromForm();
    if (!syncConfig().url) {
        setSyncStatus('请先填写服务器地址', 'error');
        return;
    }
    ensureSyncEnabled();
    flushSyncConfigSave();

    await commitSyncTokenFromForm();

    setSyncBusy(true);
    setSyncStatus('正在连接服务器…');
    try {
        const result = await ipcRenderer.invoke('sync:test');
        if (!result || !result.ok) {
            setSyncStatus((result && result.error) || '连接失败：请检查服务器地址与网络', 'error');
            return;
        }
        setSyncStatus(`连接正常：${result.server} v${result.version}，最新序号 ${result.latestSeq}，`
            + `服务端已有 ${result.fileCount} 个文件${result.deletedCount ? `、${result.deletedCount} 条删除记录` : ''}。`, 'ok');
        showToast('同步服务器连接正常');
    } catch (err) {
        console.error('测试同步连接失败:', err);
        setSyncStatus('连接失败：请检查服务器地址与网络', 'error');
    } finally {
        setSyncBusy(false);
    }
}

async function runSyncNow() {
    if (syncBusy) return;
    readSyncConfigFromForm();
    if (!syncConfig().url) {
        setSyncStatus('请先填写服务器地址', 'error');
        return;
    }
    ensureSyncEnabled();
    flushSyncConfigSave();
    flushPendingSave();
    flushActiveAiChatSave();

    setSyncBusy(true);
    setSyncStatus('正在同步…');
    try {
        const result = await ipcRenderer.invoke('sync:now');
        if (!result || !result.ok) {
            setSyncStatus(`同步失败：${(result && result.error) || '未返回错误详情，可生成诊断报告排查'}`, 'error');
            return;
        }

if (result.written || result.deleted) {
            adoptDataDir(DATA_DIR, { message: result.summary });
        }
        const resetNote = result.journalReset
            ? '服务端日志已更换（序号从头开始），本轮已重新完整重放。'
            : '';
        setSyncStatus(`${result.summary}（已应用到序号 ${result.lastSeq}）${resetNote}`, 'ok');
        showToast(result.summary);
    } catch (err) {
        console.error('同步失败:', err);
        setSyncStatus('同步失败，请检查服务器地址与网络', 'error');
    } finally {
        setSyncBusy(false);
        refreshSyncStatus();
    }
}

async function importFromServer() {
    if (syncBusy) return;
    readSyncConfigFromForm();
    if (!syncConfig().url) {
        setSyncStatus('请先填写服务器地址', 'error');
        return;
    }

    const confirmed = await showConfirm('从服务器接入并开始同步？', {
        title: '首次接入',
        detail: '先将服务端日志完整重放到本地：服务端已有的内容写入本地，服务端删除过的文件在本地同样删除'
            + '（包括标记为「已删除」的路径，不会被本地陈旧副本重新导入）。\n'
            + '随后本地独有的文件推送到服务端，此后两端按操作日志同步。',
        confirmLabel: '开始接入'
    });
    if (!confirmed) return;

    ensureSyncEnabled();
    flushSyncConfigSave();
    flushPendingSave();
    flushActiveAiChatSave();

    setSyncBusy(true);
    setSyncStatus('正在接入服务器数据…');
    try {
        const result = await ipcRenderer.invoke('sync:import-local');
        if (!result || !result.ok) {
            setSyncStatus(`接入失败：${(result && result.error) || '未返回错误详情，可生成诊断报告排查'}`, 'error');
            return;
        }
        adoptDataDir(DATA_DIR, { message: result.summary });
        setSyncStatus(`${result.summary}（重放 ${result.pulled} 条，推送 ${result.pushed} 个本地文件）`, 'ok');
        showToast(result.summary);
    } catch (err) {
        console.error('首次接入失败:', err);
        setSyncStatus('接入失败，请检查服务器地址与网络', 'error');
    } finally {
        setSyncBusy(false);
        refreshSyncStatus();
    }
}

async function runSyncDiagnose() {
    if (syncBusy) return;
    readSyncConfigFromForm();
    flushSyncConfigSave();

    setSyncBusy(true);
    setSyncStatus('正在生成诊断报告…');
    try {
        const result = await ipcRenderer.invoke('sync:diagnose');
        if (!result || !result.ok) {
            setSyncStatus('生成诊断报告失败：与主进程通信异常，请重试', 'error');
            return;
        }
        setSyncStatus(result.path
            ? `诊断报告已生成并打开：${result.path}`
            : '诊断报告已生成，但没能写入文件（配置目录不可用）', 'ok');
        showToast('同步诊断报告已生成');
    } catch (err) {
        console.error('生成同步诊断报告失败:', err);
        setSyncStatus('生成诊断报告失败：与主进程通信异常，请重试', 'error');
    } finally {
        setSyncBusy(false);
    }
}

function openSyncServerRepo() {
    ipcRenderer.invoke('app:open-external', 'serverRepo').catch((err) => {
        console.error('打开服务端项目主页失败:', err);
    });
}

function initSyncServerSettings() {
    const urlInput = document.getElementById('setting-sync-url');
    if (!urlInput) return;

['setting-sync-url', 'setting-sync-account', 'setting-sync-device'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.oninput = () => {
            readSyncConfigFromForm();
            scheduleSyncConfigSave();
        };
        el.onchange = () => {
            readSyncConfigFromForm();
            flushSyncConfigSave();
            refreshSyncStatus();
        };
    });

const tokenInput = document.getElementById('setting-sync-token');
    if (tokenInput) {
        tokenInput.onchange = () => { commitSyncTokenFromForm(); };
        tokenInput.onkeydown = (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commitSyncTokenFromForm();
        };
    }

    const tokenClearBtn = document.getElementById('btn-sync-token-clear');
    if (tokenClearBtn) tokenClearBtn.onclick = clearSyncToken;

    const tokenToggle = document.getElementById('btn-sync-token-toggle');
    if (tokenToggle) {
        tokenToggle.onclick = () => {
            const input = document.getElementById('setting-sync-token');
            const reveal = input.type === 'password';
            input.type = reveal ? 'text' : 'password';
            tokenToggle.innerHTML = `<span class="ms-icon xs">${reveal ? 'visibility_off' : 'visibility'}</span>`;
        };
    }

    const autoSelect = document.getElementById('setting-sync-autosync');
    if (autoSelect) {
        autoSelect.onchange = () => {
            readSyncConfigFromForm();
            saveConfig();
            syncSyncServerSettingsUI();
            syncSyncAutoSetting();
            showToast(`自动同步：${describeSyncAutoSetting()}`);
        };
    }
    ['setting-sync-autosync-value', 'setting-sync-autosync-unit'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.onchange = () => {
            readSyncConfigFromForm();
            saveConfig();
            syncSyncServerSettingsUI();
            syncSyncAutoSetting();
        };
    });

    const enabledToggle = document.getElementById('setting-sync-enabled');
    if (enabledToggle) enabledToggle.onchange = (event) => toggleSyncEnabled(event.target.checked);

const passwordInput = document.getElementById('setting-sync-password');
    if (passwordInput) {
        passwordInput.onkeydown = (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            loginSyncAccount();
        };
    }

    const loginBtn = document.getElementById('btn-sync-login');
    if (loginBtn) loginBtn.onclick = loginSyncAccount;

    const testBtn = document.getElementById('btn-sync-test');
    if (testBtn) testBtn.onclick = testSyncConnection;

    const nowBtn = document.getElementById('btn-sync-now');
    if (nowBtn) nowBtn.onclick = runSyncNow;

    const importBtn = document.getElementById('btn-sync-import');
    if (importBtn) importBtn.onclick = importFromServer;

    const diagnoseBtn = document.getElementById('btn-sync-diagnose');
    if (diagnoseBtn) diagnoseBtn.onclick = runSyncDiagnose;

    const repoBtn = document.getElementById('btn-sync-repo');
    if (repoBtn) repoBtn.onclick = openSyncServerRepo;

    const deviceIdCopyBtn = document.getElementById('btn-sync-device-id-copy');
    if (deviceIdCopyBtn) deviceIdCopyBtn.onclick = copySyncDeviceId;

ipcRenderer.on('sync:applied', (event, payload) => {
        if (!payload) return;
        flushPendingSave();
        flushActiveAiChatSave();
        adoptDataDir(DATA_DIR, { message: payload.summary || `已从服务器同步 ${payload.count} 处改动` });
        refreshSyncStatus();
        refillRecycledIds().catch(() => {});

        if (typeof refreshTeamNotesSoon === 'function') refreshTeamNotesSoon();
    });

ipcRenderer.on('sync:pushed', () => {
        refillRecycledIds().catch(() => {});
    });

ipcRenderer.on('sync:complete', () => {
        if (typeof refreshTeamNotesSoon === 'function') refreshTeamNotesSoon();
    });

    syncSyncServerSettingsUI();
}
