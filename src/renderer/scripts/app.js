/* 应用启动：载入数据、清理索引与过期废纸篓笔记，初始化各模块并首次渲染 */

// App Boot
window.onload = () => {
    const saved = loadData();
    State.notes = Array.isArray(saved.notes) ? saved.notes : [];
    State.folders = Array.isArray(saved.folders) && saved.folders.length ? saved.folders : ['默认'];
    State.theme = saved.theme || 'system';
    State.accentColor = normalizeAccentColor(saved.accentColor);
    State.spellcheck = typeof saved.spellcheck === 'boolean' ? saved.spellcheck : false;
    State.trashRetentionDays = normalizeTrashRetentionDays(saved.trashRetentionDays);
    State.fonts = normalizeFonts(saved.fonts);

    // 启动时自动清理无效索引：仅在确实检测到变更时才写回 index.json，避免每次启动都产生磁盘写入
    const cleanup = saved.indexCleanup;
    if (cleanup && (cleanup.removedNotes > 0 || cleanup.repairedNotes > 0 || cleanup.foldersChanged || cleanup.indexCorrupted)) {
        saveIndex();
        if (cleanup.removedNotes > 0) {
            console.warn(`索引清理：已移除 ${cleanup.removedNotes} 条无效笔记记录`);
        }
        if (cleanup.repairedNotes > 0) {
            console.warn(`索引清理：已修正 ${cleanup.repairedNotes} 条笔记记录的字段`);
        }
        if (cleanup.foldersChanged) {
            console.warn('索引清理：已规范化文件夹列表');
        }
        if (cleanup.indexCorrupted) {
            console.warn('索引清理：index.json 解析失败，已按清理结果重建');
        }
    }

    // 按保留策略清理过期的废纸篓笔记：放在首次渲染之前，避免闪现即将被删除的笔记
    const purgedTrashNotes = purgeExpiredTrashNotes();

    initTheme();
    initAccentColor();
    applySpellcheck();
    initFonts();
    initSettingsNav();
    setupEvents();
    syncTrashRetentionSelect();
    refreshDataDirInfo();

    // 启动时不自动打开任何标签页：停留在空状态，由用户自行选择或新建笔记
    State.openNoteIds = [];
    State.activeNoteId = null;

    renderApp();

    if (purgedTrashNotes > 0) {
        showToast(`已自动清理 ${purgedTrashNotes} 篇超过 ${State.trashRetentionDays} 天的废纸篓笔记`);
    }
    if (cleanup && cleanup.removedNotes > 0) {
        showToast(`已清理 ${cleanup.removedNotes} 条无效笔记记录`);
    }

    // 应用长时间驻留时也按策略复查；没有过期笔记时不会产生任何刷新或磁盘写入
    setInterval(runTrashAutoPurge, TRASH_PURGE_INTERVAL_MS);
};
