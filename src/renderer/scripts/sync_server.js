/* 自建同步（设置 → 数据与存储）：服务器地址、设备名、访问令牌与自动同步节奏。

   同步本身在主进程完成（见 src/main/sync_server.js），采用操作日志模型：
   本地每次保存/删除都变成一条操作推给服务端，服务端给每条操作分配序号并写进 append-only 日志；
   客户端只记住「已应用到第几号」，同步时拉取后面的操作并重放。
   删除因此就是删除：任何一方重放都得到相同结果，不会出现删除后又被补写回来的情况。
   令牌只在提交时交给主进程（存进系统密钥链），界面只回显「有没有保存」。 */

// 输入过程中攒一下再落盘，避免每敲一个字符就写一次 config.json
const SYNC_CONFIG_SAVE_DELAY = 400;
let syncConfigSaveTimer = null;
// 同步进行中：按钮统一置灰
let syncBusy = false;
// 最近一次从主进程取回的同步状态（状态行与描述都要用）
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

/* 配置落盘。这里必须无条件写一次：saveConfig 自己会在内容没变时跳过，
   但拨动开关、选自动同步间隔这些操作并不会产生「待保存的输入」，
   依赖防抖定时器就会出现「界面已打开、主进程却还以为没启用」的情形 */
function flushSyncConfigSave() {
    clearTimeout(syncConfigSaveTimer);
    syncConfigSaveTimer = null;
    saveConfig();
    // 地址 / 间隔可能刚被改过：让主进程按最新配置重建自动同步的定时器
    syncSyncAutoSetting();
}

/* ---------------- 自动同步 ---------------- */

// 秒数 → 人读的间隔（60 的整数倍按分钟写）
function formatSyncInterval(seconds) {
    const num = normalizeAutoSyncSeconds(seconds);
    if (num >= 60 && num % 60 === 0) return `${num / 60} 分钟`;
    return `${num} 秒`;
}

function describeSyncAutoSetting() {
    const config = syncConfig();
    if (config.autoSync === 'custom') return `每 ${formatSyncInterval(config.autoSyncSeconds)}`;
    const seconds = SYNC_AUTO_SYNC_PRESETS[config.autoSync];
    // 「不自动同步」只是不定时跑：每次启动应用仍会同步一次，本地保存与删除也即时推送
    return seconds > 0 ? `每 ${formatSyncInterval(seconds)}` : '不定时（每次启动仍同步一次）';
}

function readSyncAutoSelection() {
    const select = document.getElementById('setting-sync-autosync');
    const value = select ? select.value : 'off';
    return SYNC_AUTO_SYNC_VALUES.includes(value) ? value : 'off';
}

// 「自定义」间隔：把填的数字按所选单位换算成秒
function readSyncAutoSecondsFromForm() {
    const input = document.getElementById('setting-sync-autosync-value');
    const unit = document.getElementById('setting-sync-autosync-unit');
    const value = Number(input ? input.value : '');
    if (!Number.isFinite(value) || value <= 0) return normalizeAutoSyncSeconds(syncConfig().autoSyncSeconds);
    const seconds = unit && unit.value === 'minute' ? value * 60 : value;
    return normalizeAutoSyncSeconds(seconds);
}

// 自定义间隔的输入框：秒数能被 60 整除时用「分钟」显示；非自定义时整块隐藏
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

/* ---------------- 状态 ---------------- */

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
        return '尚未配置：填写服务器地址与访问令牌后即可同步。';
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

// 主进程上报的状态：出错时优先显示原因
function applySyncStatus(status) {
    if (!status) return;
    syncServerStatus = status;
    State.syncTokenSaved = !!status.hasToken;
    applySyncDeviceId(status);

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

// 配置改完后让主进程按新间隔重建定时器，并把最新状态回填
async function syncSyncAutoSetting() {
    try {
        applySyncStatus(await ipcRenderer.invoke('sync:apply-auto-sync'));
    } catch (err) {
        console.error('应用同步设置失败:', err);
    }
}

/* ---------------- 设备 ID ---------------- */

/* 设备 ID 由主进程生成一次并固定下来（保存在配置目录的 sync_state.json），
   每条操作的 opId 里都带着它；在服务端创建令牌时填进「绑定设备」即可把该令牌的写入记在这台设备名下。
   这里只做展示与复制：它本身不含任何凭据，也不参与鉴权。 */
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

/* ---------------- 可复用 ID ---------------- */

/* 条目被删除后，它的 ID 会回到服务端的回收池；新建条目时优先取用，
   于是「删掉的那一条腾出来的 ID」会重新落到新建的条目上（见 storage.js 的 generateUniqueItemId）。
   生成 ID 是同步调用，不能每次都去等网络，所以这里先领一两个存着，
   服务端会把领走的占住一小会儿，两台设备同时新建也不会撞到同一个 ID。 */
const RECYCLE_CLAIM_COUNT = 2;
// 服务端领回来的可复用 ID
let recycledIdPool = [];
// 本机刚彻底删掉的条目腾出来的 ID：最优先（服务端那边随后也会把它收进回收池）
let locallyFreedIds = [];
let recycledRefillPending = false;

async function refillRecycledIds(kind = '', retry = true) {
    if (!isSyncEnabled() || recycledRefillPending) return;
    recycledRefillPending = true;
    try {
        // 服务端认的是 notes / todos（空表示两种都收），这里把条目类型换算过去
        const wanted = kind === 'todo' ? 'todos' : (kind === 'note' ? 'notes' : '');
        const claim = () => ipcRenderer.invoke('sync:claim-ids', { count: RECYCLE_CLAIM_COUNT, kind: wanted });

        let result = await claim();
        // 池子里有 ID，但本机还没重放过对应的删除：先同步一次（把删除拉下来），再领一遍就有了
        if (result && result.ok && !result.ids.length && result.pending && retry) {
            const synced = await ipcRenderer.invoke('sync:now');
            if (synced && synced.ok) result = await claim();
        }
        if (!result || !result.ok) return;

        const ids = (Array.isArray(result.ids) ? result.ids : [])
            // 服务端可能给出本机还在用着的 ID（本地那一条还没被删掉）：丢掉，别拿它去建新条目
            .filter((item) => item && item.id && !itemIdTaken(String(item.id)))
            .map((item) => ({ id: String(item.id), kind: String(item.kind || '') }));
        // 领到新的就换上；服务端这次没有可发的，手里那几个先留着（它们在服务端仍然被占着）
        if (ids.length) recycledIdPool = ids;
    } catch (err) {
        console.error('领取可复用 ID 失败:', err);
    } finally {
        recycledRefillPending = false;
    }
}

// 本地彻底删掉一个条目：它腾出来的 ID 立刻就能再用（服务端那边随后会把它收进回收池）。
// 直接记在本地这份清单里——下一次新建就用它，不必等一次同步往返（生成 ID 是同步调用，等不了网络）。
function releaseRecycledItemId(relative) {
    const match = /^(notes|todos)\/([A-Za-z0-9_-]{1,64})\.md$/.exec(String(relative || ''));
    if (!match) return;
    const entry = { id: match[2], kind: match[1] };
    locallyFreedIds = [entry].concat(locallyFreedIds.filter((item) => item.id !== entry.id));
}

// 从一份清单里取一个 ID：优先同类型，没有同类型就取队首；取走即从清单里移除
function takePoolId(list, prefix) {
    if (!list.length) return '';
    const sameKind = list.findIndex((item) => item.kind === prefix);
    const entry = list.splice(sameKind === -1 ? 0 : sameKind, 1)[0];
    return entry ? String(entry.id) : '';
}

// 取一个回收来的 ID：优先同类型（笔记的给笔记、待办的给待办），没有就退而求其次
function takeRecycledItemId(kind) {
    const prefix = kind === 'todo' ? 'todos' : 'notes';
    // 本机刚彻底删掉的那几个最优先：本地确信那一条已经删干净了
    const local = takePoolId(locallyFreedIds, prefix);
    if (local) return local;

    if (!recycledIdPool.length) {
        // 手里没存货：先补一批（这一次新建先按老办法随机生成，不在这里顺带做一次同步）
        refillRecycledIds(kind, false).catch(() => {});
        return '';
    }
    const id = takePoolId(recycledIdPool, prefix);
    // 池子见底就顺手补一批，下一次新建仍然能拿到回收的 ID
    if (!recycledIdPool.length) refillRecycledIds(kind).catch(() => {});
    return id;
}

/* ---------------- 访问令牌：只经主进程进出 ---------------- */

function applySyncTokenStatus(status) {
    State.syncTokenSaved = !!(status && status.hasToken);
    State.syncTokenStrong = !!(status && status.strong);

    const input = document.getElementById('setting-sync-token');
    if (input) {
        // 输入框里永远不放明文：已保存时留空，填写即表示「换成新的」
        input.placeholder = State.syncTokenSaved ? '已保存；输入新的令牌即可替换' : '令牌';
    }
    const clearBtn = document.getElementById('btn-sync-token-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !State.syncTokenSaved);

    const hint = document.getElementById('sync-token-hint');
    if (hint) {
        if (!State.syncTokenSaved) {
            hint.textContent = '尚未保存令牌：服务端一律要求凭据，先在服务端管理页创建访问令牌再填入（服务器地址 + /admin）。';
        } else if (State.syncTokenStrong) {
            hint.textContent = '已保存到系统密钥链（内存与磁盘上均为密文）。';
        } else {
            hint.textContent = '已保存：当前系统未提供密钥链，仅按本机可读的文件权限保存。';
        }
    }
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
        // 服务端要求令牌时，令牌补上之后同步才能跑起来
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

/* ---------------- 配置与界面 ---------------- */

function readSyncConfigFromForm() {
    const field = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    };

    State.syncServer = normalizeSyncServerConfig({
        // 保留上次同步的时刻与结果（表单里没有这两项）
        ...State.syncServer,
        url: field('setting-sync-url'),
        device: field('setting-sync-device'),
        autoSync: readSyncAutoSelection(),
        autoSyncSeconds: readSyncAutoSecondsFromForm()
    });
}

// 把配置落回界面（data_location.js 与 render.js 在切数据目录、打开设置页时也调用它）
function syncSyncServerSettingsUI() {
    const urlInput = document.getElementById('setting-sync-url');
    if (!urlInput) return;

    const config = normalizeSyncServerConfig(State.syncServer);
    State.syncServer = config;

    urlInput.value = config.url;
    document.getElementById('setting-sync-device').value = config.device;
    document.getElementById('setting-sync-enabled').checked = config.enabled === true;

    const autoSelect = document.getElementById('setting-sync-autosync');
    if (autoSelect) autoSelect.value = config.autoSync;
    syncSyncAutoCustomInputs(config);

    // 关掉设置页再回来时输入框恢复为空 + 掩码显示（里面从不保留明文）
    const tokenInput = document.getElementById('setting-sync-token');
    if (tokenInput) {
        tokenInput.value = '';
        tokenInput.type = 'password';
    }
    const tokenToggle = document.getElementById('btn-sync-token-toggle');
    if (tokenToggle) tokenToggle.innerHTML = '<span class="ms-icon xs">visibility</span>';

    applySyncTokenStatus({ hasToken: State.syncTokenSaved, strong: State.syncTokenStrong });
    applySyncEnabledState();
    refreshSyncTokenStatus();
    refreshSyncStatus();
    // 先把可复用的 ID 领一批，之后新建条目就能用上被删掉的那一条腾出来的 ID
    refillRecycledIds().catch(() => {});
}

// 总开关状态落到界面上：配置区一起显隐
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
    // 必须直接落盘：主进程是按 config.json 判断要不要推送/拉取的
    saveConfig();
    applySyncEnabledState();
    // 关掉之后不该再有定时同步
    syncSyncAutoSetting();
    showToast(enabled ? '已启用自建同步' : '已关闭自建同步');
}

/* 点「立即同步 / 首次接入」时如果还没打开开关，就顺手打开：
   用户的意图已经很清楚，而不落盘的话主进程只会回一句「尚未启用」 */
function ensureSyncEnabled() {
    if (isSyncEnabled()) return false;
    State.syncServer = normalizeSyncServerConfig({ ...State.syncServer, enabled: true });
    saveConfig();
    applySyncEnabledState();
    return true;
}

function setSyncBusy(busy) {
    syncBusy = busy;
    ['btn-sync-test', 'btn-sync-now', 'btn-sync-import', 'btn-sync-diagnose'].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = busy;
    });
}

/* ---------------- 同步动作 ---------------- */

async function testSyncConnection() {
    if (syncBusy) return;
    readSyncConfigFromForm();
    if (!syncConfig().url) {
        setSyncStatus('请先填写服务器地址', 'error');
        return;
    }
    ensureSyncEnabled();
    flushSyncConfigSave();
    // 刚粘贴进来的令牌可能还没失焦提交，先落定再测试
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

        // 本地文件被远端操作改过（或删过）时重新载入一次，界面与磁盘保持一致
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

/* 首次接入：服务端可能已经有数据，所以先把日志完整重放到本地（以服务端为准，包含删除），
   再把「服务端从未见过」的本地文件推上去。服务端见过但已删除的文件不会被重新导入——
   它出现在服务端的删除记录里。 */
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

// 服务端项目主页：地址固定在主进程（见 main.js 的 EXTERNAL_LINKS），这里只发起调用
function openSyncServerRepo() {
    ipcRenderer.invoke('app:open-external', 'serverRepo').catch((err) => {
        console.error('打开服务端项目主页失败:', err);
    });
}

/* ---------------- 初始化 ---------------- */

function initSyncServerSettings() {
    const urlInput = document.getElementById('setting-sync-url');
    if (!urlInput) return;

    // 文本类字段：输入时只更新内存并稍后落盘，失焦/回车时立即落盘
    ['setting-sync-url', 'setting-sync-device'].forEach((id) => {
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

    // 令牌：失焦或回车即提交给主进程保存（成功后输入框立即清空）
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

    /* 主进程重放完远端操作、改动了本地文件：重新载入一次，界面才会看到别的设备改过的内容。
       先落盘再重载——被覆盖的可能是编辑器里正在改的那一篇 */
    ipcRenderer.on('sync:applied', (event, payload) => {
        if (!payload) return;
        flushPendingSave();
        flushActiveAiChatSave();
        adoptDataDir(DATA_DIR, { message: payload.summary || `已从服务器同步 ${payload.count} 处改动` });
        refreshSyncStatus();
        refillRecycledIds().catch(() => {});
    });

    /* 本地改动推上去之后：这一批里可能有删除（它的 ID 进了服务端的回收池），顺手补一批 */
    ipcRenderer.on('sync:pushed', () => {
        refillRecycledIds().catch(() => {});
    });

    syncSyncServerSettingsUI();
}
