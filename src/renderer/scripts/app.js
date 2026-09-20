/* 应用启动：载入数据、迁移旧版单文件记录（index.json / ai_chats.json）与清理过期废纸篓条目，
   初始化各模块并首次渲染 */

// 废纸篓定期复查的定时器句柄：留一个引用，便于窗口卸载或调试时清理
let trashPurgeTimer = null;

// App Boot
window.onload = () => {
    const saved = loadData();
    State.notes = Array.isArray(saved.notes) ? saved.notes : [];
    State.todos = Array.isArray(saved.todos) ? saved.todos : [];
    // 一次性标好条目类型：后续所有类型判断都是常数时间
    markItemKinds(State.notes, State.todos);
    State.folders = Array.isArray(saved.folders) && saved.folders.length ? saved.folders : ['默认'];
    State.theme = saved.theme || 'system';
    State.themeStyle = normalizeThemeStyle(saved.themeStyle);
    State.accentColor = normalizeAccentColor(saved.accentColor);
    State.brandColor = normalizeBrandColor(saved.brandColor);
    State.cornerRadius = normalizeCornerRadius(saved.cornerRadius);
    State.spellcheck = typeof saved.spellcheck === 'boolean' ? saved.spellcheck : false;
    // 使用模式（标准 / 极简）：极简模式只保留笔记与待办
    State.uiMode = normalizeUiMode(saved.uiMode);
    State.sidebarCollapsed = !!saved.sidebarCollapsed;
    State.trashRetentionDays = normalizeTrashRetentionDays(saved.trashRetentionDays);
    State.autoUpdate = saved.autoUpdate !== false;
    State.autoLaunch = saved.autoLaunch === true;
    State.trayEnabled = saved.trayEnabled !== false;
    State.fonts = normalizeFonts(saved.fonts);
    State.ai = normalizeAiConfig(saved.ai);
    // API Key 只保留「是否已保存 + 保管方式」，明文始终留在主进程与系统密钥链里
    State.aiHasApiKey = !!(saved.aiKeyStatus && saved.aiKeyStatus.hasKey);
    State.aiKeyStorage = aiKeyStorageKind(saved.aiKeyStatus);
    State.aiScope = State.ai.scope;
    // 多对话记录（ai_chats/ 下的一份份文件）：载入后保证至少有一份可用对话
    adoptAiChats(saved.aiChats);

    // 笔记、待办与对话文件的格式修正已在 loadData 内就地完成，这里只需把文件夹列表的变化写回配置
    const cleanup = saved.dataCleanup;
    if (cleanup) {
        if (cleanup.foldersChanged) saveConfig();
        if (cleanup.legacyIndex && cleanup.legacyIndex.found) {
            console.warn(`索引迁移：已把 index.json 中的元数据并入 ${cleanup.legacyIndex.merged} 篇笔记文件`
                + (cleanup.legacyIndex.archived ? '，原文件保留为 index.json.bak' : '，原文件归档失败'));
        }
        if (cleanup.legacyAiChats && cleanup.legacyAiChats.found) {
            console.warn(`对话迁移：已把 ai_chats.json 中的 ${cleanup.legacyAiChats.merged} 份对话拆分为 ai_chats/{id}.json`
                + (cleanup.legacyAiChats.archived ? '，原文件保留为 ai_chats.json.bak' : '，原文件归档失败'));
        }
        if (cleanup.repairedNotes > 0) {
            console.warn(`笔记格式：已为 ${cleanup.repairedNotes} 篇笔记写回内嵌元数据`);
        }
        if (cleanup.repairedTodos > 0) {
            console.warn(`待办格式：已为 ${cleanup.repairedTodos} 项待办写回内嵌元数据`);
        }
        if (cleanup.skippedFiles > 0) {
            console.warn(`笔记目录：已忽略 ${cleanup.skippedFiles} 个非笔记文件`);
        }
        if (cleanup.skippedTodoFiles > 0) {
            console.warn(`待办目录：已忽略 ${cleanup.skippedTodoFiles} 个非待办文件`);
        }
    }

    // 按保留策略清理过期的废纸篓条目：放在首次渲染之前，避免闪现即将被删除的内容
    const purgedTrashItems = purgeExpiredTrashItems();

    // 原生下拉菜单统一换成自绘（select 与 datalist）：放在其余初始化之前，后续对 select.value 的赋值都能同步显示
    initCustomDropdowns();
    initTheme();
    initThemeStyle();
    initAccentColor();
    initBrandColor();
    initCornerRadius();
    applySpellcheck();
    initFonts();
    applySidebarCollapsed();
    initSettingsNav();
    initUiMode();
    initAiSettings();
    initAiChats();
    initAiAgent();
    initAiFiles();
    initAiPanel();
    setupEvents();
    syncTrashRetentionSelect();
    refreshDataDirInfo();
    initUpdateSettings();
    initTraySettings();
    initAutoLaunchSettings();

    // 启动时不自动打开任何标签页：停留在空状态，由用户自行选择、新建笔记或待办
    State.openNoteIds = [];
    State.activeNoteId = null;

    renderApp();

    if (purgedTrashItems > 0) {
        showToast(`已自动清理 ${purgedTrashItems} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
    }
    if (cleanup && cleanup.legacyIndex && cleanup.legacyIndex.found) {
        showToast(cleanup.legacyIndex.archived
            ? '笔记元数据已并入各笔记文件（原 index.json 保留为 index.json.bak）'
            : '笔记元数据已并入各笔记文件');
    }
    if (cleanup && cleanup.legacyAiChats && cleanup.legacyAiChats.found) {
        showToast(cleanup.legacyAiChats.archived
            ? 'AI 对话已拆分为 ai_chats 下的一份份文件（原 ai_chats.json 保留为 ai_chats.json.bak）'
            : 'AI 对话已拆分为 ai_chats 下的一份份文件');
    }
    // 本次启动刚把 config.json 里的明文 API Key 收进系统密钥链：提示一次，避免用户以为密钥丢了
    if (saved.aiKeyStatus && saved.aiKeyStatus.migrated) {
        showToast('API Key 已改存到本机安全存储（不再明文写入 config.json）');
    }

    // 应用长时间驻留时也按策略复查；没有过期内容时不会产生任何刷新或磁盘写入。
    // 窗口在后台时先跳过，回到前台立即补一次，避免后台空转做无用的目录扫描。
    trashPurgeTimer = setInterval(() => {
        if (document.hidden) return;
        runTrashAutoPurge();
    }, TRASH_PURGE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) runTrashAutoPurge();
    });
};
