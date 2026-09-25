/* 数据存放位置：展示当前目录，并支持更改 / 恢复默认 / 在文件管理器中打开 */

// 数据位置信息（由主进程提供：当前目录、默认目录、是否自定义位置、是否开发运行、
// 是否便携版运行、位置记录文件的实际路径）
let dataDirInfo = {
    dataDir: DATA_DIR,
    defaultDir: '',
    isCustom: false,
    isDevRun: false,
    isPortableRun: false,
    locationFile: ''
};

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
    // 便携版：数据默认在便携版所在目录下的 data/，位置记录也写在该目录下。
    // 与安装版一样可以更换位置，所以这里不置灰，只在下方说明当前数据与记录的落点
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
        themeStyle: State.themeStyle,
        accentColor: State.accentColor,
        cornerRadius: State.cornerRadius,
        // 界面尺寸（缩放）也属于外观偏好：新位置没有配置时沿用当前的缩放比例
        uiScale: State.uiScale,
        spellcheck: State.spellcheck,
        // 界面布局同样属于偏好：新位置没有配置时沿用当前位置的布局
        uiMode: State.uiMode,
        // 「禁用标签页」也是现代布局下的偏好，同样跟着走
        tabsDisabled: State.tabsDisabled,
        sidebarCollapsed: State.sidebarCollapsed,
        trashRetentionDays: State.trashRetentionDays,
        autoUpdate: State.autoUpdate,
        // gh-proxy 加速开关也属于偏好：新位置没有配置时沿用当前位置的选择
        ghProxyEnabled: State.ghProxyEnabled === true,
        autoLaunch: State.autoLaunch === true,
        trayEnabled: State.trayEnabled !== false,
        // 应用名文字颜色（brand / mono / accent）同样属于偏好
        brandColor: State.brandColor,
        fonts: { ...State.fonts },
        // 随口记的入口、识别语言与联网兜底同属偏好（不是数据目录的内容）
        voice: { ...State.voice }
    };

    setDataPaths(dir);
    ensureStorageDirs();

    // 新位置自带配置（尤其是迁移过来的数据）时采用其中的偏好，否则沿用当前偏好并写入
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
        State.sidebarCollapsed = saved.sidebarCollapsed;
        State.trashRetentionDays = saved.trashRetentionDays;
        State.autoUpdate = saved.autoUpdate !== false;
        State.ghProxyEnabled = saved.ghProxyEnabled === true;
        State.autoLaunch = saved.autoLaunch === true;
        State.trayEnabled = saved.trayEnabled !== false;
        State.fonts = saved.fonts;
        // AI 接口配置随数据目录走：新位置自带的配置（尤其是迁移过来的）优先
        State.ai = saved.ai;
        State.aiScope = State.ai.scope;
        // 随口记：识别语言与联网兜底同样以新位置的配置为准
        State.voice = saved.voice;
        /* 自建同步的服务器地址这类连接信息更像「这台机器连哪个同步服务」的偏好，而不是数据目录的内容：
           新位置的配置里带了地址就采用（迁移过来的数据），没带就沿用当前这份。令牌本就在系统密钥链里、
           与数据目录无关，地址跟着保持一致，才不会出现「切一次目录就少了一半配置」。
           上次同步的时刻与结果为同一份数据服务，因此跟着新位置走 */
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
        State.sidebarCollapsed = prefs.sidebarCollapsed;
        State.trashRetentionDays = prefs.trashRetentionDays;
        State.autoUpdate = prefs.autoUpdate !== false;
        State.ghProxyEnabled = prefs.ghProxyEnabled === true;
        State.autoLaunch = prefs.autoLaunch;
        State.trayEnabled = prefs.trayEnabled;
        State.fonts = prefs.fonts;
        State.voice = normalizeVoiceConfig(prefs.voice);
        saveConfig();
    }

    // 对话记录与笔记一样属于新位置的内容：新位置没有记录就开一份空白对话，
    // 不把上一个位置的对话带过去（避免迁移选择为“不迁移”时内容被悄悄带过去）。
    adoptAiChats(saved.aiChats);

    // 换目录后条目对象全是新的，会话里的解密密钥随之作废（新位置的文件还没有解开过）
    if (typeof clearSecretSession === 'function') clearSecretSession();

    State.notes = saved.notes;
    State.todos = Array.isArray(saved.todos) ? saved.todos : [];
    // 换目录后条目对象全是新的，重新标一遍类型
    markItemKinds(State.notes, State.todos);
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
    applyThemeStyle();
    applyBrandColor();
    applyCornerRadius();
    applyUiScale();
    applySpellcheck();
    applyFonts();
    applySidebarCollapsed();
    // 界面布局也随新位置的配置走：新位置若选的是现代布局，标题栏要跟着收起（标签页改到工作区顶部）
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
    // 自动更新开关随配置走：新位置若关掉了自动更新，主进程的定时检查也要跟着停
    syncUpdateSettingsUI();
    ipcRenderer.invoke('update:set-auto', { enabled: State.autoUpdate !== false }).catch((err) => {
        console.error('同步自动更新开关失败:', err);
    });
    // 托盘开关同样随配置走：新位置若关掉了托盘图标，图标要跟着消失
    syncTraySetting();
    // 开机自启也随配置走：登记在系统里的启动项要与新位置的设置保持一致
    syncAutoLaunchSetting();
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
        showToast('切换数据存放位置失败：与主进程通信异常，请重试');
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
        // 默认位置不可用而改选了其他位置时主进程返回的是自定义位置（isCustom 不为 false），
        // 这种情况不能说成「已恢复默认」
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

// 在系统文件管理器中打开当前数据目录
async function openDataDir() {
    try {
        const error = await ipcRenderer.invoke('data:open-dir');
        if (error) showToast(`打开数据文件夹失败：${error}`);
    } catch (err) {
        console.error('打开数据文件夹失败:', err);
        showToast('打开数据文件夹失败：与主进程通信异常，请重试');
    }
}
