/* 笔记操作：新建与标签页，置顶/废纸篓/彻底删除，废纸篓自动清理，以及列表过滤 */

// 新建笔记的默认归属：沿用当前筛选（在文件夹/标签视图下新建时直接落在该分类）
function newNoteDefaults() {
    return {
        folder: State.currentFilter.startsWith('folder:') ? State.currentFilter.replace('folder:', '') : '默认',
        tags: State.currentFilter.startsWith('tag:') ? [State.currentFilter.replace('tag:', '')] : []
    };
}

// 生成10位大小写英文+数字随机ID，查重保证唯一性（内存与磁盘上的笔记文件都要避开）
function generateUniqueNoteId() {
    let id = generateNoteId();
    while (State.notes.some(n => n.id === id) || fs.existsSync(path.join(NOTES_DIR, `${id}.md`))) {
        id = generateNoteId();
    }
    return id;
}

// Note Operations
function createNewNote() {
    const defaults = newNoteDefaults();
    const newNote = {
        id: generateUniqueNoteId(),
        title: '',
        content: '',
        folder: defaults.folder,
        tags: defaults.tags,
        isPinned: false,
        isTrashed: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    // 创建对应 data/notes/{id}.md 文件（元数据注释与正文一并写入）
    saveNote(newNote);

    State.notes.unshift(newNote);
    openTab(newNote.id);
    renderApp();

    setTimeout(() => {
        const titleInput = document.getElementById('input-note-title');
        if (titleInput) titleInput.focus();
    }, 50);

    showToast('已创建新笔记');
}

function openTab(noteId) {
    if (!noteId) return;
    if (!State.openNoteIds.includes(noteId)) {
        State.openNoteIds.push(noteId);
    }
    State.activeNoteId = noteId;
}

function openSettingsTab() {
    if (!State.openNoteIds.includes('settings')) {
        State.openNoteIds.push('settings');
    }
    State.activeNoteId = 'settings';
    renderApp();
}

function closeTab(noteId) {
    State.openNoteIds = State.openNoteIds.filter(id => id !== noteId);
    if (State.activeNoteId === noteId) {
        State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    }
}

function getActiveNote() {
    if (!State.activeNoteId) return null;
    return State.notes.find(n => n.id === State.activeNoteId) || null;
}

// 废纸篓中的笔记为只读：可查看与导出，但不能修改内容与元数据
function isReadOnlyNote(note) {
    return !!(note && note.isTrashed);
}

// 待保存的编辑内容：记录目标笔记，避免切换标签页后把草稿写进别的笔记
let pendingSave = null;

function autoSaveNote() {
    const note = getActiveNote();
    if (!note || isReadOnlyNote(note)) return;

    pendingSave = {
        noteId: note.id,
        title: document.getElementById('input-note-title').value,
        content: document.getElementById('textarea-note-content').value
    };

    document.getElementById('save-status').textContent = '保存中...';
    clearTimeout(State.autoSaveTimer);

    State.autoSaveTimer = setTimeout(() => {
        State.autoSaveTimer = null;
        commitPendingSave();

        renderTabs();
        renderNotesList();
        updateStats();
        document.getElementById('save-status').textContent = '已保存';
    }, 300);
}

// 把待保存内容写入磁盘，返回是否确实写入了内容
function commitPendingSave() {
    const pending = pendingSave;
    pendingSave = null;
    if (!pending) return false;

    const note = State.notes.find(n => n.id === pending.noteId);
    if (!note) return false;

    note.title = pending.title;
    note.content = pending.content;
    note.updatedAt = Date.now();

    // 标题、时间戳等元数据与正文同处一份 .md 文件，一次写入即可
    saveNote(note);
    return true;
}

// 立即落盘未保存的编辑（切换数据存放位置等场景必须调用）
function flushPendingSave() {
    if (State.autoSaveTimer) {
        clearTimeout(State.autoSaveTimer);
        State.autoSaveTimer = null;
    }
    if (commitPendingSave()) {
        document.getElementById('save-status').textContent = '已保存';
    }
}

function togglePin(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note || note.isTrashed) return;
    note.isPinned = !note.isPinned;
    saveNote(note);
    renderApp();
    showToast(note.isPinned ? '已置顶' : '已取消置顶');
}

function moveToTrash(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note || note.isTrashed) return;
    note.isTrashed = true;
    closeTab(noteId);
    saveNote(note);
    renderApp();
    showToast('已移入废纸篓');
}

function restoreFromTrash(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note || !note.isTrashed) return;
    note.isTrashed = false;
    saveNote(note);
    renderApp();
    showToast('已恢复');
}

// 彻底删除需要二次确认（不可撤销）
async function purgeNote(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note) return;
    const confirmed = await showConfirm(`彻底删除“${note.title || '未命名笔记'}”？`, {
        title: '彻底删除笔记',
        detail: '该笔记将从磁盘上永久移除，此操作无法撤销。',
        type: 'warning',
        icon: 'delete_forever',
        confirmLabel: '彻底删除',
        danger: true
    });
    if (!confirmed) return;
    permanentlyDelete(noteId);
}

function permanentlyDelete(noteId) {
    // 元数据与正文同在一份文件，删掉文件即彻底移除
    deleteNoteFile(noteId);
    State.notes = State.notes.filter(n => n.id !== noteId);
    closeTab(noteId);
    renderApp();
    showToast('已彻底删除');
}

async function clearTrash() {
    const confirmed = await showConfirm('确认清空废纸篓吗？', {
        title: '清空废纸篓',
        detail: '废纸篓中的所有笔记将被永久删除，此操作无法撤销。',
        type: 'warning',
        icon: 'delete_forever',
        confirmLabel: '清空',
        danger: true
    });
    if (!confirmed) return;
    State.notes.filter(n => n.isTrashed).forEach(n => deleteNoteFile(n.id));
    State.notes = State.notes.filter(n => !n.isTrashed);
    renderApp();
    showToast('已清空废纸篓');
}

/* ---------------- 废纸篓自动清理 ---------------- */

// 依据「笔记最后一次编辑时间」判断是否过期：超过保留天数的废纸篓笔记会被永久删除。
// 移入废纸篓本身不会刷新 updatedAt，因此计时从最后一次实际编辑算起。
// 仅执行清理，不触发界面刷新，返回被清理的笔记数量。
function purgeExpiredTrashNotes() {
    const days = normalizeTrashRetentionDays(State.trashRetentionDays);
    if (!days) return 0;

    const cutoff = Date.now() - days * TRASH_RETENTION_DAY_MS;
    const expired = State.notes.filter(note => note.isTrashed && (note.updatedAt || 0) < cutoff);
    if (!expired.length) return 0;

    expired.forEach(note => deleteNoteFile(note.id));
    const expiredIds = new Set(expired.map(note => note.id));
    State.notes = State.notes.filter(note => !expiredIds.has(note.id));

    // 同步清掉指向已删除笔记的标签页，避免留下打不开的幽灵标签
    State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || !expiredIds.has(id));
    if (expiredIds.has(State.activeNoteId)) {
        State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    }

    return expired.length;
}

// 执行一次清理，有实际删除时刷新界面并提示用户
function runTrashAutoPurge() {
    const removed = purgeExpiredTrashNotes();
    if (removed > 0) {
        renderApp();
        showToast(`已自动清理 ${removed} 篇超过 ${State.trashRetentionDays} 天的废纸篓笔记`);
    }
    return removed;
}

// 把下拉框同步为当前生效的保留期限
function syncTrashRetentionSelect() {
    const select = document.getElementById('setting-trash-retention');
    if (select) select.value = String(normalizeTrashRetentionDays(State.trashRetentionDays));
}

// Filtering
function getFilteredNotes() {
    // 过滤条件在遍历前解析一次，避免对每篇笔记重复做字符串判断与切片
    const filter = State.currentFilter;
    const isTrashView = filter === 'trash';
    const isPinnedView = filter === 'pinned';
    const folderFilter = filter.startsWith('folder:') ? filter.slice(7) : null;
    const tagFilter = filter.startsWith('tag:') ? filter.slice(4) : null;
    const query = State.searchQuery.trim().toLowerCase();
    const sortBy = State.sortBy;

    const list = [];
    State.notes.forEach(note => {
        if (note.isTrashed) {
            if (!isTrashView) return;
        } else {
            if (isTrashView) return;
            if (isPinnedView && !note.isPinned) return;
            if (folderFilter !== null && note.folder !== folderFilter) return;
            if (tagFilter !== null && (!note.tags || !note.tags.includes(tagFilter))) return;
        }

        if (query) {
            const inTitle = (note.title || '').toLowerCase().includes(query);
            if (!inTitle && !(note.content || '').toLowerCase().includes(query)) return;
        }

        list.push(note);
    });

    return list.sort((a, b) => {
        if (!isTrashView) {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
        }
        if (sortBy === 'updated-desc') return b.updatedAt - a.updatedAt;
        if (sortBy === 'created-desc') return b.createdAt - a.createdAt;
        if (sortBy === 'title-asc') return (a.title || '未命名').localeCompare(b.title || '未命名', 'zh-CN');
        return 0;
    });
}
