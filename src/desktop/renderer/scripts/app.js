let trashPurgeTimer = null;

const UI_FAILURES = [];

function reportUiFailure(label, error) {
    const detail = error && error.message ? error.message : String(error);
    UI_FAILURES.push(`${label}：${detail}`);
    try {
        console.error(`[ERROR] [Boot] step=${label} msg=${detail}`);
    } catch (e) {}
}

function runBootStep(label, run) {
    try {
        return run();
    } catch (error) {
        reportUiFailure(label, error);
        return undefined;
    }
}

window.addEventListener('error', (event) => {
    reportUiFailure('未捕获异常', (event && (event.error || event.message)) || '未知错误');
});
window.addEventListener('unhandledrejection', (event) => {
    reportUiFailure('未处理的异步错误', (event && event.reason) || '未知原因');
});

function showUiFailures() {
    if (!UI_FAILURES.length) return;
    try {
        console.error(`[ERROR] [Boot] failures=${UI_FAILURES.length}\n` + UI_FAILURES.join('\n'));
    } catch (e) {}
    if (typeof showToast !== 'function') return;
    const more = UI_FAILURES.length > 1 ? `（共 ${UI_FAILURES.length} 处，详情见开发者工具）` : '';
    showToast(`界面有一处出错：${UI_FAILURES[0]}${more}`);
}

window.onload = () => {

let saved = {};
    try {
        saved = loadData() || {};
    } catch (error) {
        reportUiFailure('载入数据', error);
    }
    State.notes = Array.isArray(saved.notes) ? saved.notes : [];
    State.todos = Array.isArray(saved.todos) ? saved.todos : [];

    markItemKinds(State.notes, State.todos);
    State.folders = Array.isArray(saved.folders) && saved.folders.length ? saved.folders : ['默认'];
    State.theme = saved.theme || 'system';
    State.accentColor = normalizeAccentColor(saved.accentColor);
    State.cornerRadius = normalizeCornerRadius(saved.cornerRadius);

    State.uiScale = normalizeUiScale(saved.uiScale);
    State.spellcheck = typeof saved.spellcheck === 'boolean' ? saved.spellcheck : false;
    State.sidebarCollapsed = true;
    State.trashRetentionDays = normalizeTrashRetentionDays(saved.trashRetentionDays);
    State.autoUpdate = saved.autoUpdate !== false;

    State.ghProxyEnabled = saved.ghProxyEnabled === true;
    State.autoLaunch = saved.autoLaunch === true;
    State.trayEnabled = saved.trayEnabled !== false;
    State.stickyNotes = normalizeStickyConfig(saved.stickyNotes);
    State.fonts = normalizeFonts(saved.fonts);
    State.ai = normalizeAiConfig(saved.ai);

    State.aiHasApiKey = !!(saved.aiKeyStatus && saved.aiKeyStatus.hasKey);
    State.aiKeyStorage = aiKeyStorageKind(saved.aiKeyStatus);
    State.aiScope = State.ai.scope;

State.syncServer = normalizeSyncServerConfig(saved.syncServer);
    State.syncServerLoaded = true;

    adoptAiChats(saved.aiChats);

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
            console.warn(`条目目录：已忽略 ${cleanup.skippedFiles} 个非笔记文件`);
        }
        if (cleanup.skippedTodoFiles > 0) {
            console.warn(`待办目录：已忽略 ${cleanup.skippedTodoFiles} 个非待办文件`);
        }
    }

const purgedTrashItems = runBootStep('清理废纸篓', purgeExpiredTrashItems) || 0;

runBootStep('自绘下拉菜单', initCustomDropdowns);
    runBootStep('主题', initTheme);
    runBootStep('明暗模式', initThemeMode);
    runBootStep('主题色', initAccentColor);
    runBootStep('圆角尺度', initCornerRadius);
    runBootStep('界面缩放', initUiScale);
    runBootStep('拼写检查', applySpellcheck);
    runBootStep('字体', initFonts);
    runBootStep('侧边栏收起状态', applySidebarCollapsed);
    runBootStep('设置分类', initSettingsNav);
    runBootStep('界面布局', initUiMode);
    runBootStep('AI 接口设置', initAiSettings);
    runBootStep('AI 对话记录', initAiChats);
    runBootStep('AI Agent', initAiAgent);
    runBootStep('AI 附件', initAiFiles);
    runBootStep('AI 面板', initAiPanel);

    runBootStep('事件绑定', setupEvents);
    runBootStep('废纸篓保留期限', syncTrashRetentionSelect);
    runBootStep('数据存放位置', refreshDataDirInfo);
    runBootStep('自建同步设置', initSyncServerSettings);
    runBootStep('日记文件设置', initJournalFileSettings);

    runBootStep('团队笔记设置', initTeamNotesSettings);

    runBootStep('秘密本设置', initSecretSettings);
    runBootStep('更新设置', initUpdateSettings);
    runBootStep('托盘设置', initTraySettings);
    runBootStep('开机自启设置', initAutoLaunchSettings);

    runBootStep('桌面便利贴设置', initStickyNoteSettings);

State.openNoteIds = [];
    State.activeNoteId = null;

    runBootStep('首次渲染', renderApp);

    showUiFailures();

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

    if (saved.aiKeyStatus && saved.aiKeyStatus.migrated) {
        showToast('API Key 已改存到本机安全存储（不再明文写入 config.json）');
    }

trashPurgeTimer = setInterval(() => {
        if (document.hidden) return;
        runTrashAutoPurge();
    }, TRASH_PURGE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) runTrashAutoPurge();
    });

updateNarrowLayout();
};

function updateNarrowLayout() {
    const narrow = window.innerWidth < NARROW_WINDOW_THRESHOLD;
    const html = document.documentElement;

    html.classList.add(SIDEBAR_COLLAPSED_CLASS);
    html.classList.toggle('narrow-hide-editor', narrow && State.activeNoteId == null);
}

window.addEventListener('resize', updateNarrowLayout);
