/* 条目通用操作（标签页、当前条目、自动保存：笔记与待办共用同一套标签页与编辑器）
   与笔记专属操作（新建、置顶、废纸篓、废纸篓自动清理、列表过滤） */

// 新建笔记的默认归属：沿用当前筛选（在文件夹/标签视图下新建时直接落在该分类）
function newNoteDefaults() {
    return {
        folder: State.currentFilter.startsWith('folder:') ? State.currentFilter.replace('folder:', '') : '默认',
        tags: State.currentFilter.startsWith('tag:') ? [State.currentFilter.replace('tag:', '')] : []
    };
}

// Note Operations
function createNewNote() {
    const defaults = newNoteDefaults();
    const newNote = {
        id: generateUniqueItemId(),
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
    // 在「待办」视图下新建笔记时切回「笔记」视图，否则新建的笔记不会出现在列表里
    if (State.currentFilter === 'todos') State.currentFilter = 'all';
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

/* 笔记与待办共用同一套标签页与编辑器，因此“当前条目”由下面这组取值函数统一提供 */

function getActiveNote() {
    if (!State.activeNoteId) return null;
    return State.notes.find(n => n.id === State.activeNoteId) || null;
}

function getActiveTodo() {
    if (!State.activeNoteId) return null;
    return State.todos.find(t => t.id === State.activeNoteId) || null;
}

// 当前激活的条目：待办优先（两类的 id 不会重复，先命中哪个就是哪个）
function getActiveItem() {
    return getActiveTodo() || getActiveNote();
}

// 按 id 取条目（笔记或待办）
function getItemById(itemId) {
    return State.todos.find(t => t.id === itemId) || State.notes.find(n => n.id === itemId) || null;
}

// 是否为待办条目：保存与删除据此选目标文件
function isTodoItem(item) {
    return !!item && State.todos.some(todo => todo === item);
}

// 条目类型的中文名，用于提示文案
function itemKindLabel(item) {
    return isTodoItem(item) ? '待办' : '笔记';
}

// 没有标题时的兜底名称
function itemDisplayTitle(item) {
    return item.title || `未命名${itemKindLabel(item)}`;
}

// 废纸篓中的条目为只读：可查看与导出，但不能修改内容与元数据
function isReadOnlyItem(item) {
    return !!(item && item.isTrashed);
}

// 待保存的编辑内容：记录目标条目，避免切换标签页后把草稿写进别的条目
let pendingSave = null;

// 自动保存当前条目（笔记或待办，写入哪一份文件由条目归属决定）
function autoSaveActiveItem() {
    const item = getActiveItem();
    if (!item || isReadOnlyItem(item)) return;

    pendingSave = {
        itemId: item.id,
        title: document.getElementById('input-note-title').value,
        content: document.getElementById('textarea-note-content').value
    };

    document.getElementById('save-status').textContent = '保存中...';
    clearTimeout(State.autoSaveTimer);

    State.autoSaveTimer = setTimeout(() => {
        State.autoSaveTimer = null;
        commitPendingSave();

        renderTabs();
        renderListPanel();
        updateStats();
        document.getElementById('save-status').textContent = '已保存';
    }, 300);
}

// 把待保存内容写入磁盘，返回是否确实写入了内容
function commitPendingSave() {
    const pending = pendingSave;
    pendingSave = null;
    if (!pending) return false;

    const item = getItemById(pending.itemId);
    if (!item) return false;

    item.title = pending.title;
    item.content = pending.content;
    item.updatedAt = Date.now();

    // 标题、时间戳等元数据与正文同处一份 .md 文件，一次写入即可
    saveItem(item);
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

/* 置顶 / 废纸篓 / 彻底删除：笔记与待办共用同一套入口，按条目归属写入各自文件 */

function togglePin(itemId) {
    const item = getItemById(itemId);
    if (!item || item.isTrashed) return;
    item.isPinned = !item.isPinned;
    saveItem(item);
    renderApp();
    showToast(item.isPinned ? '已置顶' : '已取消置顶');
}

function moveToTrash(itemId) {
    const item = getItemById(itemId);
    if (!item || item.isTrashed) return;
    item.isTrashed = true;
    closeTab(itemId);
    saveItem(item);
    renderApp();
    showToast('已移入废纸篓');
}

function restoreFromTrash(itemId) {
    const item = getItemById(itemId);
    if (!item || !item.isTrashed) return;
    item.isTrashed = false;
    saveItem(item);
    renderApp();
    showToast('已恢复');
}

// 彻底删除需要二次确认（不可撤销）
async function purgeItem(itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    const label = itemKindLabel(item);
    const confirmed = await showConfirm(`彻底删除“${itemDisplayTitle(item)}”？`, {
        title: `彻底删除${label}`,
        detail: `该${label}将从磁盘上永久移除，此操作无法撤销。`,
        type: 'warning',
        icon: 'delete_forever',
        confirmLabel: '彻底删除',
        danger: true
    });
    if (!confirmed) return;
    permanentlyDeleteItem(itemId);
}

function permanentlyDeleteItem(itemId) {
    // 元数据与正文同在一份文件，删掉文件即彻底移除
    deleteItemFile(itemId);
    State.notes = State.notes.filter(n => n.id !== itemId);
    State.todos = State.todos.filter(t => t.id !== itemId);
    closeTab(itemId);
    renderApp();
    showToast('已彻底删除');
}

// 清空废纸篓：笔记与待办共用一个废纸篓，一次全部清空
async function clearTrash() {
    const confirmed = await showConfirm('确认清空废纸篓吗？', {
        title: '清空废纸篓',
        detail: '废纸篓中的所有笔记与待办将被永久删除，此操作无法撤销。',
        type: 'warning',
        icon: 'delete_forever',
        confirmLabel: '清空',
        danger: true
    });
    if (!confirmed) return;
    State.notes.filter(n => n.isTrashed).forEach(n => deleteNoteFile(n.id));
    State.notes = State.notes.filter(n => !n.isTrashed);
    State.todos.filter(t => t.isTrashed).forEach(t => deleteTodoFile(t.id));
    State.todos = State.todos.filter(t => !t.isTrashed);
    renderApp();
    showToast('已清空废纸篓');
}

/* ---------------- 废纸篓自动清理 ---------------- */

// 依据「最后一次编辑时间」判断是否过期：超过保留天数的废纸篓笔记与待办会被永久删除。
// 移入废纸篓本身不会刷新 updatedAt，因此计时从最后一次实际编辑算起。
// 仅执行清理，不触发界面刷新，返回被清理的条目数量。
function purgeExpiredTrashItems() {
    const days = normalizeTrashRetentionDays(State.trashRetentionDays);
    if (!days) return 0;

    const cutoff = Date.now() - days * TRASH_RETENTION_DAY_MS;
    const isExpired = (item) => item.isTrashed && (item.updatedAt || 0) < cutoff;
    const expiredNotes = State.notes.filter(isExpired);
    const expiredTodos = State.todos.filter(isExpired);
    if (!expiredNotes.length && !expiredTodos.length) return 0;

    expiredNotes.forEach(item => deleteNoteFile(item.id));
    expiredTodos.forEach(item => deleteTodoFile(item.id));

    const expiredIds = new Set([...expiredNotes, ...expiredTodos].map(item => item.id));
    State.notes = State.notes.filter(item => !expiredIds.has(item.id));
    State.todos = State.todos.filter(item => !expiredIds.has(item.id));

    // 同步清掉指向已删除条目的标签页，避免留下打不开的幽灵标签
    State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || !expiredIds.has(id));
    if (expiredIds.has(State.activeNoteId)) {
        State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    }

    return expiredIds.size;
}

// 执行一次清理，有实际删除时刷新界面并提示用户
function runTrashAutoPurge() {
    const removed = purgeExpiredTrashItems();
    if (removed > 0) {
        renderApp();
        showToast(`已自动清理 ${removed} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
    }
    return removed;
}

// 把下拉框同步为当前生效的保留期限
function syncTrashRetentionSelect() {
    const select = document.getElementById('setting-trash-retention');
    if (select) select.value = String(normalizeTrashRetentionDays(State.trashRetentionDays));
}

/* ---------------- 中栏列表过滤 ---------------- */

// 当前筛选下的条目：「笔记」与「待办」两个入口各只列一类，
// 已置顶、废纸篓与文件夹、标签视图里两类混排（同为置顶优先，再按所选方式排序）
function getFilteredItems() {
    // 过滤条件在遍历前解析一次，避免对每一项重复做字符串判断与切片
    const filter = State.currentFilter;
    const isTrashView = filter === 'trash';
    const isPinnedView = filter === 'pinned';
    const onlyNotes = filter === 'all';
    const onlyTodos = filter === 'todos';
    const folderFilter = filter.startsWith('folder:') ? filter.slice(7) : null;
    const tagFilter = filter.startsWith('tag:') ? filter.slice(4) : null;
    const query = State.searchQuery.trim().toLowerCase();
    const sortBy = State.sortBy;

    const list = [];
    [...State.notes, ...State.todos].forEach(item => {
        if (onlyNotes && isTodoItem(item)) return;
        if (onlyTodos && !isTodoItem(item)) return;

        if (item.isTrashed) {
            if (!isTrashView) return;
        } else {
            if (isTrashView) return;
            if (isPinnedView && !item.isPinned) return;
            if (folderFilter !== null && item.folder !== folderFilter) return;
            if (tagFilter !== null && (!item.tags || !item.tags.includes(tagFilter))) return;
        }

        if (query) {
            const inTitle = (item.title || '').toLowerCase().includes(query);
            if (!inTitle && !(item.content || '').toLowerCase().includes(query)) return;
        }

        list.push(item);
    });

    return list.sort((a, b) => {
        if (!isTrashView) {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
        }
        if (sortBy === 'updated-desc') return b.updatedAt - a.updatedAt;
        if (sortBy === 'created-desc') return b.createdAt - a.createdAt;
        // 标题排序用列表上显示的兜底名（未命名笔记 / 未命名待办），与所见一致
        if (sortBy === 'title-asc') return itemDisplayTitle(a).localeCompare(itemDisplayTitle(b), 'zh-CN');
        return 0;
    });
}
