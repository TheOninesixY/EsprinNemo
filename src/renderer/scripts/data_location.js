let dataDirInfo = {
    dataDir: DATA_DIR,
    defaultDir: '',
    isCustom: false,
    isDevRun: false,
    isPortableRun: false,
    locationFile: ''
};

const DATA_DIR_LOCKED_HINT = '当前为开发运行（bun start），数据固定存放在项目内的 data/ 目录，无法更改数据存放位置。';

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

const portable = !locked && !!dataDirInfo.isPortableRun;

    if (text) text.textContent = dataDirInfo.dataDir || DATA_DIR;
    if (tag) {
        const custom = !locked && !!dataDirInfo.isCustom;
        tag.textContent = locked
            ? '开发运行（固定）'
            : (custom ? '自定义位置' : (portable ? '便携版目录' : '默认位置'));
        tag.style.color = custom ? 'var(--accent)' : '';
    }
    if (resetBtn) resetBtn.disabled = locked || !dataDirInfo.isCustom;
    if (status) {
        const record = dataDirInfo.locationFile ? `位置记录位于 ${dataDirInfo.locationFile}；` : '';
        if (locked) {
            status.textContent = `${DATA_DIR_LOCKED_HINT}该目录随项目一同管理，仅安装版与便携版可改变数据存放位置。`;
        } else if (portable) {
            status.textContent = dataDirInfo.isCustom && dataDirInfo.defaultDir
                ? `便携版：默认位置为程序所在目录下的 data/（${dataDirInfo.defaultDir}），可用「恢复默认」切回；${record}切换即时生效。`
                : `便携版：数据默认存放在程序所在目录下的 data/，${record}更改位置时会询问是否迁移现有数据，切换即时生效。`;
        } else if (dataDirInfo.isCustom && dataDirInfo.defaultDir) {
            status.textContent = `默认位置：${dataDirInfo.defaultDir}（可用「恢复默认」切回）`;
        } else {
            status.textContent = '更改位置时会询问是否迁移现有数据；切换即时生效，无需重启应用。';
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
                isDevRun: !!info.isDevRun,
                isPortableRun: !!info.isPortableRun,
                locationFile: typeof info.locationFile === 'string' ? info.locationFile : ''
            };

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

function adoptDataDir(dir, options = {}) {
    const prefs = {
        theme: State.theme,
        themeStyle: State.themeStyle,
        accentColor: State.accentColor,
        cornerRadius: State.cornerRadius,

        uiScale: State.uiScale,
        spellcheck: State.spellcheck,

        uiMode: State.uiMode,

        tabsDisabled: State.tabsDisabled,
        sidebarCollapsed: State.sidebarCollapsed,
        trashRetentionDays: State.trashRetentionDays,
        autoUpdate: State.autoUpdate,

        ghProxyEnabled: State.ghProxyEnabled === true,
        autoLaunch: State.autoLaunch === true,
        trayEnabled: State.trayEnabled !== false,

        brandColor: State.brandColor,
        fonts: { ...State.fonts },

        voice: { ...State.voice }
    };

    setDataPaths(dir);
    ensureStorageDirs();

const hasConfig = fs.existsSync(CONFIG_FILE);
    const saved = loadData();

    if (hasConfig) {
        State.theme = saved.theme;
        State.themeStyle = saved.themeStyle;
        State.accentColor = saved.accentColor;
        State.brandColor = normalizeBrandColor(saved.brandColor);
        State.cornerRadius = saved.cornerRadius;
        State.uiScale = saved.uiScale;
        State.spellcheck = saved.spellcheck;
        State.uiMode = saved.uiMode;
        State.tabsDisabled = saved.tabsDisabled === true;
        State.sidebarCollapsed = true;
        State.trashRetentionDays = saved.trashRetentionDays;
        State.autoUpdate = saved.autoUpdate !== false;
        State.ghProxyEnabled = saved.ghProxyEnabled === true;
        State.autoLaunch = saved.autoLaunch === true;
        State.trayEnabled = saved.trayEnabled !== false;
        State.fonts = saved.fonts;

        State.ai = saved.ai;
        State.aiScope = State.ai.scope;

        State.voice = saved.voice;

        const loadedSync = normalizeSyncServerConfig(saved.syncServer);
        State.syncServer = loadedSync.url
            ? loadedSync
            : { ...State.syncServer, lastSyncAt: loadedSync.lastSyncAt, lastSyncSummary: loadedSync.lastSyncSummary };
        State.syncServerLoaded = true;
    } else {
        State.themeStyle = prefs.themeStyle;
        State.theme = prefs.theme;
        State.accentColor = prefs.accentColor;
        State.brandColor = prefs.brandColor;
        State.cornerRadius = prefs.cornerRadius;
        State.uiScale = prefs.uiScale;
        State.spellcheck = prefs.spellcheck;
        State.uiMode = prefs.uiMode;
        State.tabsDisabled = prefs.tabsDisabled === true;
        State.sidebarCollapsed = true;
        State.trashRetentionDays = prefs.trashRetentionDays;
        State.autoUpdate = prefs.autoUpdate !== false;
        State.ghProxyEnabled = prefs.ghProxyEnabled === true;
        State.autoLaunch = prefs.autoLaunch;
        State.trayEnabled = prefs.trayEnabled;
        State.fonts = prefs.fonts;
        State.voice = normalizeVoiceConfig(prefs.voice);
        saveConfig();
    }

adoptAiChats(saved.aiChats);

if (typeof clearSecretSession === 'function') clearSecretSession();

    State.notes = saved.notes;
    State.todos = Array.isArray(saved.todos) ? saved.todos : [];

    markItemKinds(State.notes, State.todos);
    State.folders = saved.folders;

const cleanup = saved.dataCleanup;
    if (cleanup && cleanup.foldersChanged) saveConfig();

State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || !!getItemById(id));
    if (!State.openNoteIds.includes(State.activeNoteId)) {
        State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    }

if (State.currentFilter.startsWith('folder:')) {
        const folder = State.currentFilter.replace('folder:', '');
        if (!State.folders.includes(folder)) State.currentFilter = 'all';
    } else if (State.currentFilter.startsWith('tag:')) {
        const tag = State.currentFilter.replace('tag:', '');
        const hasTag = (item) => Array.isArray(item.tags) && item.tags.includes(tag);
        if (!State.notes.some(hasTag) && !State.todos.some(hasTag)) State.currentFilter = 'all';
    }

    applyTheme();
    applyThemeStyle();
    applyBrandColor();
    applyCornerRadius();
    applyUiScale();
    applySpellcheck();
    applyFonts();
    applySidebarCollapsed();

    applyUiMode();
    syncFontSelects();
    syncAccentControls();
    syncBrandColorSelect();
    syncThemeStyleSelect();
    syncCornerRadiusControl();
    syncUiScaleControl();
    syncTrashRetentionSelect();
    syncAiSettingsUI();
    syncSyncServerSettingsUI();
    syncUiModeUI();

    syncUpdateSettingsUI();
    ipcRenderer.invoke('update:set-auto', { enabled: State.autoUpdate !== false }).catch((err) => {
        console.error('同步自动更新开关失败:', err);
    });

    syncTraySetting();

    syncAutoLaunchSetting();
    renderAiMessages();
    renderAiChatList();

    dataDirInfo = { ...dataDirInfo, dataDir: DATA_DIR };
    updateDataDirUI();

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

async function changeDataDir() {
    if (dataDirInfo.isDevRun) {
        showToast(DATA_DIR_LOCKED_HINT);
        return;
    }
    setDataDirButtonsDisabled(true);
    try {
        flushPendingSave();
        flushActiveAiChatSave();
        const result = await ipcRenderer.invoke('data:choose-dir');
        await handleDataDirResult(result, '数据存放位置已切换');
        await refreshDataDirInfo();
    } catch (err) {
        console.error('切换数据存放位置失败:', err);
        showToast('切换数据存放位置失败：与主进程通信异常，请重试');
    } finally {
        setDataDirButtonsDisabled(false);
    }
}

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

const message = result && result.isCustom === false ? '已恢复默认数据存放位置' : '数据存放位置已切换';
        await handleDataDirResult(result, message);
        await refreshDataDirInfo();
    } catch (err) {
        console.error('恢复默认数据存放位置失败:', err);
        showToast('恢复默认数据存放位置失败：与主进程通信异常，请重试');
    } finally {
        setDataDirButtonsDisabled(false);
    }
}

async function openDataDir() {
    try {
        const error = await ipcRenderer.invoke('data:open-dir');
        if (error) showToast(`打开数据文件夹失败：${error}`);
    } catch (err) {
        console.error('打开数据文件夹失败:', err);
        showToast('打开数据文件夹失败：与主进程通信异常，请重试');
    }
}
