/* 笔记操作：新建与标签页，置顶/废纸篓/彻底删除，废纸篓自动清理，以及列表过滤 */

// Note Operations
function createNewNote() {
    let defaultFolder = '默认';
    if (State.currentFilter.startsWith('folder:')) {
        defaultFolder = State.currentFilter.replace('folder:', '');
    }

    // 生成10位大小写英文+数字随机ID，查重保证唯一性
    let id = generateNoteId();
    while (State.notes.some(n => n.id === id)) {
        id = generateNoteId();
    }

    const newNote = {
        id: id,
        title: '',
        content: '',
        folder: defaultFolder,
        tags: State.currentFilter.startsWith('tag:') ? [State.currentFilter.replace('tag:', '')] : [],
        isPinned: false,
        isTrashed: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    // 创建对应 data/notes/{id}.md 文件
    saveNoteContent(newNote);

    State.notes.unshift(newNote);
    openTab(newNote.id);
    saveIndex();
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

    // 保存正文到 .md 文件，元数据到 index.json
    saveNoteContent(note);
    saveIndex();
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
    saveIndex();
    renderApp();
    showToast(note.isPinned ? '已置顶' : '已取消置顶');
}

function moveToTrash(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note || note.isTrashed) return;
    note.isTrashed = true;
    closeTab(noteId);
    saveIndex();
    renderApp();
    showToast('已移入废纸篓');
}

function restoreFromTrash(noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note || !note.isTrashed) return;
    note.isTrashed = false;
    saveIndex();
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

function deleteNoteFile(noteId) {
    try {
        const notePath = path.join(NOTES_DIR, `${noteId}.md`);
        if (fs.existsSync(notePath)) {
            fs.unlinkSync(notePath);
        }
    } catch (err) {
        console.error(`删除笔记文件 ${noteId}.md 失败:`, err);
    }
}

function permanentlyDelete(noteId) {
    deleteNoteFile(noteId);
    State.notes = State.notes.filter(n => n.id !== noteId);
    closeTab(noteId);
    saveIndex();
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
    saveIndex();
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

    saveIndex();
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
    return State.notes.filter(note => {
        if (State.currentFilter === 'trash') {
            if (!note.isTrashed) return false;
        } else {
            if (note.isTrashed) return false;
            if (State.currentFilter === 'pinned' && !note.isPinned) return false;
            if (State.currentFilter.startsWith('folder:')) {
                const folder = State.currentFilter.replace('folder:', '');
                if (note.folder !== folder) return false;
            }
            if (State.currentFilter.startsWith('tag:')) {
                const tag = State.currentFilter.replace('tag:', '');
                if (!note.tags || !note.tags.includes(tag)) return false;
            }
        }

        if (State.searchQuery.trim()) {
            const q = State.searchQuery.toLowerCase();
            return (note.title || '').toLowerCase().includes(q) || (note.content || '').toLowerCase().includes(q);
        }
        return true;
    }).sort((a, b) => {
        if (State.currentFilter !== 'trash') {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
        }
        if (State.sortBy === 'updated-desc') return b.updatedAt - a.updatedAt;
        if (State.sortBy === 'created-desc') return b.createdAt - a.createdAt;
        if (State.sortBy === 'title-asc') return (a.title || '未命名').localeCompare(b.title || '未命名', 'zh-CN');
        return 0;
    });
}
