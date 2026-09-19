/* 数据存放位置：展示当前目录，并支持更改 / 恢复默认 / 在文件管理器中打开 */

// 数据位置信息（由主进程提供：当前目录、默认目录、是否为自定义位置、是否开发运行）
let dataDirInfo = { dataDir: DATA_DIR, defaultDir: '', isCustom: false, isDevRun: false };

// 开发运行（bun start）下数据固定在项目内 data/，整行置灰不可更改
const DATA_DIR_LOCKED_HINT = '当前为开发运行（bun start），数据固定存放在项目内的 data/ 目录，无法更改数据存放位置。';

// 锁定时整行淡化并禁用全部按钮；解锁时交由 updateDataDirUI 按实际状态恢复
function applyDataDirLock(locked) {
    const row = document.getElementById('setting-data-row');
    if (row) row.classList.toggle('is-locked', locked);
    if (!locked) return;
    ['btn-data-change', 'btn-data-reset', 'btn-data-open'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = true;
            btn.title = DATA_DIR_LOCKED_HINT;
        }
    });
}

function updateDataDirUI() {
    const text = document.getElementById('setting-data-dir-text');
    const tag = document.getElementById('setting-data-dir-tag');
    const resetBtn = document.getElementById('btn-data-reset');
    const status = document.getElementById('data-dir-status');
    const locked = !!dataDirInfo.isDevRun;

    if (text) text.textContent = dataDirInfo.dataDir || DATA_DIR;
    if (tag) {
        const custom = !locked && !!dataDirInfo.isCustom;
        tag.textContent = locked ? '开发运行（固定）' : (custom ? '自定义位置' : '默认位置');
        tag.style.color = custom ? 'var(--accent)' : '';
    }
    if (resetBtn) resetBtn.disabled = locked || !dataDirInfo.isCustom;
    if (status) {
        if (locked) {
            status.textContent = `${DATA_DIR_LOCKED_HINT}该目录随项目一同管理，仅安装版可改变数据存放位置。`;
        } else if (dataDirInfo.isCustom && dataDirInfo.defaultDir) {
            status.textContent = `默认位置：${dataDirInfo.defaultDir}（可用“恢复默认”切回）`;
        } else {
            status.textContent = '更改位置后会询问是否把现有数据一并迁移；切换即时生效，无需重启应用。';
        }
    }
    applyDataDirLock(locked);
}

function setDataDirButtonsDisabled(disabled) {
    ['btn-data-change', 'btn-data-open'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = disabled;
    });
    if (disabled) {
        const resetBtn = document.getElementById('btn-data-reset');
        if (resetBtn) resetBtn.disabled = true;
    } else {
        updateDataDirUI();
    }
}

async function refreshDataDirInfo() {
    try {
        const info = await ipcRenderer.invoke('data:get-dir');
        if (info && typeof info.dataDir === 'string') {
            dataDirInfo = {
                dataDir: info.dataDir,
                defaultDir: typeof info.defaultDir === 'string' ? info.defaultDir : '',
                isCustom: !!info.isCustom,
                isDevRun: !!info.isDevRun
            };
            // 兜底：渲染进程使用的目录始终与主进程保持一致
            if (path.resolve(info.dataDir) !== path.resolve(DATA_DIR)) {
                setDataPaths(info.dataDir);
            }
        }
    } catch (err) {
        console.error('读取数据存放位置失败:', err);
        dataDirInfo = { ...dataDirInfo, dataDir: DATA_DIR };
    }
    updateDataDirUI();
}

// 切换到主进程确认后的新位置：更新路径 → 重新载入数据 → 刷新界面（无需重启）
function adoptDataDir(dir, options = {}) {
    const prefs = {
        theme: State.theme,
        accentColor: State.accentColor,
        spellcheck: State.spellcheck,
        sidebarCollapsed: State.sidebarCollapsed,
        trashRetentionDays: State.trashRetentionDays,
        fonts: { ...State.fonts }
    };

    setDataPaths(dir);
    ensureStorageDirs();

    // 新位置自带配置（尤其是迁移过来的数据）时采用其中的偏好，否则沿用当前偏好并写入
    const hasConfig = fs.existsSync(CONFIG_FILE);
    const saved = loadData();

    if (hasConfig) {
        State.theme = saved.theme;
        State.accentColor = saved.accentColor;
        State.spellcheck = saved.spellcheck;
        State.sidebarCollapsed = saved.sidebarCollapsed;
        State.trashRetentionDays = saved.trashRetentionDays;
        State.fonts = saved.fonts;
        // AI 接口配置随数据目录走：新位置自带的配置（尤其是迁移过来的）优先
        State.ai = saved.ai;
        State.aiScope = State.ai.scope;
    } else {
        State.theme = prefs.theme;
        State.accentColor = prefs.accentColor;
        State.spellcheck = prefs.spellcheck;
        State.sidebarCollapsed = prefs.sidebarCollapsed;
        State.trashRetentionDays = prefs.trashRetentionDays;
        State.fonts = prefs.fonts;
        saveConfig();
    }

    // 对话记录与笔记一样属于新位置的内容：新位置没有记录就开一份空白对话，
    // 不把上一个位置的对话带过去（避免迁移选择为“不迁移”时内容被悄悄带过去）。
    adoptAiChats(saved.aiChats);

    State.notes = saved.notes;
    State.todos = Array.isArray(saved.todos) ? saved.todos : [];
    State.folders = saved.folders;

    // 新位置同样执行一次数据清理（与启动流程一致）：
    // 笔记、待办与对话文件的格式修正已在 loadData 内完成，文件夹列表有变化时写回配置
    const cleanup = saved.dataCleanup;
    if (cleanup && cleanup.foldersChanged) saveConfig();

    // 丢弃在新位置不存在的标签页，避免指向幽灵条目
    State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || !!getItemById(id));
    if (!State.openNoteIds.includes(State.activeNoteId)) {
        State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    }

    // 过滤条件在新位置可能已失效，回退到“全部笔记”
    if (State.currentFilter.startsWith('folder:')) {
        const folder = State.currentFilter.replace('folder:', '');
        if (!State.folders.includes(folder)) State.currentFilter = 'all';
    } else if (State.currentFilter.startsWith('tag:')) {
        const tag = State.currentFilter.replace('tag:', '');
        const hasTag = (item) => Array.isArray(item.tags) && item.tags.includes(tag);
        if (!State.notes.some(hasTag) && !State.todos.some(hasTag)) State.currentFilter = 'all';
    }

    applyTheme();
    applySpellcheck();
    applyFonts();
    applySidebarCollapsed();
    syncFontSelects();
    syncAccentControls();
    syncTrashRetentionSelect();
    syncAiSettingsUI();
    renderAiMessages();
    renderAiChatList();

    dataDirInfo = { ...dataDirInfo, dataDir: DATA_DIR };
    updateDataDirUI();

    // 新位置可能自带过期的废纸篓条目，按当前保留策略清理一次
    const purged = purgeExpiredTrashItems();

    renderApp();
    showToast(options.message || '数据存放位置已切换');
    if (purged > 0) {
        showToast(`已自动清理 ${purged} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
    }
}

async function handleDataDirResult(result, successMessage) {
    if (!result || result.canceled) return;
    if (result.error) {
        showToast(result.error);
        return;
    }
    if (result.unchanged) {
        showToast('当前已在使用该位置');
        return;
    }
    adoptDataDir(result.dataDir, {
        message: result.migrated ? `${successMessage}（已迁移现有数据）` : `${successMessage}（未迁移数据）`
    });
}

// 通过目录选择框更改数据存放位置（可选迁移现有数据）
async function changeDataDir() {
    if (dataDirInfo.isDevRun) {
        showToast(DATA_DIR_LOCKED_HINT);
        return;
    }
    setDataDirButtonsDisabled(true);
    try {
        flushPendingSave(); // 先落盘，保证迁移/切换的是最新内容
        flushActiveAiChatSave(); // 当前对话的切换也要先写进旧位置的 config.json
        const result = await ipcRenderer.invoke('data:choose-dir');
        await handleDataDirResult(result, '数据存放位置已切换');
        await refreshDataDirInfo();
    } catch (err) {
        console.error('切换数据存放位置失败:', err);
        showToast('切换数据存放位置失败');
    } finally {
        setDataDirButtonsDisabled(false);
    }
}

// 恢复为默认数据存放位置
async function resetDataDir() {
    if (dataDirInfo.isDevRun) {
        showToast(DATA_DIR_LOCKED_HINT);
        return;
    }
    setDataDirButtonsDisabled(true);
    try {
        flushPendingSave();
        flushActiveAiChatSave();
        const result = await ipcRenderer.invoke('data:reset-dir');
        await handleDataDirResult(result, '已恢复默认数据存放位置');
        await refreshDataDirInfo();
    } catch (err) {
        console.error('恢复默认数据存放位置失败:', err);
        showToast('恢复默认数据存放位置失败');
    } finally {
        setDataDirButtonsDisabled(false);
    }
}

// 在系统文件管理器中打开当前数据目录
async function openDataDir() {
    try {
        const error = await ipcRenderer.invoke('data:open-dir');
        if (error) showToast(`打开数据文件夹失败：${error}`);
    } catch (err) {
        console.error('打开数据文件夹失败:', err);
        showToast('打开数据文件夹失败');
    }
}
