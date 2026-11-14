function newNoteDefaults() {
    const folder = State.filterFolder
        || (State.currentFilter.startsWith('folder:') ? State.currentFilter.replace('folder:', '') : '');
    const tag = State.filterTag
        || (State.currentFilter.startsWith('tag:') ? State.currentFilter.replace('tag:', '') : '');
    return {
        folder: folder || '默认',
        tags: tag ? [tag] : []
    };
}

function createNewNote() {
    const defaults = newNoteDefaults();
    const newNote = {
        id: generateUniqueItemId('note'),
        title: '',
        content: '',
        folder: defaults.folder,
        tags: defaults.tags,
        isPinned: false,
        isTrashed: false,

        isHidden: false,
        locked: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

saveNote(newNote);

    markItemKind(newNote, 'note');
    State.notes.unshift(newNote);

    if (State.currentFilter === 'todos') State.currentFilter = 'all';
    openTab(newNote.id);
    renderApp();

    setTimeout(() => {
        const titleInput = document.getElementById('input-note-title');
        if (titleInput) titleInput.focus();
    }, 50);

    showToast('已创建新笔记');
}

function createItemForCurrentFilter() {
    if (State.currentFilter === 'todos') {
        createNewTodo();
        return;
    }
    createNewNote();
}

const IMPORT_FILE_MAX = 100;
const IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;

function importTitleFromPath(filePath) {
    return path.basename(filePath).replace(/\.[^.]+$/, '').trim();
}

function buildImportedNote(filePath) {
    const parsed = parseNoteFile(fs.readFileSync(filePath, 'utf8'));
    const meta = parsed.meta || null;
    const content = parsed.content;
    const defaults = newNoteDefaults();
    const now = Date.now();

const metaFolder = meta ? readNoteMetaString(meta.folder) : '';
    const metaTags = meta ? readNoteMetaTags(meta.tags) : [];

    return {
        id: generateUniqueItemId('note'),

        title: (meta ? readNoteMetaString(meta.title) : '') || importTitleFromPath(filePath) || deriveNoteTitle(content),
        content,
        folder: metaFolder && State.folders.includes(metaFolder) ? metaFolder : defaults.folder,
        tags: metaTags.length ? metaTags : defaults.tags,

        isPinned: false,
        isTrashed: false,

        isHidden: meta ? readNoteMetaBoolean(meta.isHidden, false) : false,
        locked: meta ? (readNoteMetaBoolean(meta.isLocked, false) && isSecretEnvelope(content)) : false,
        unlocked: false,
        createdAt: meta ? readNoteMetaNumber(meta.createdAt, now) : now,
        updatedAt: now
    };
}

async function importNoteFiles() {
    let picked = null;
    try {
        picked = await ipcRenderer.invoke('notes:pick-import');
    } catch (err) {
        console.error('打开导入文件选择框失败:', err);
        showToast('打开文件选择框失败');
        return;
    }
    if (!picked || picked.canceled || !Array.isArray(picked.paths) || !picked.paths.length) return;

    const queued = picked.paths.slice(0, IMPORT_FILE_MAX);
    const overflow = picked.paths.length - queued.length;
    const notes = [];
    let failed = 0;
    queued.forEach((filePath) => {
        try {

            if (fs.statSync(filePath).size > IMPORT_FILE_MAX_BYTES) throw new Error('文件过大');
            const note = buildImportedNote(filePath);
            saveNote(note);
            markItemKind(note, 'note');
            notes.push(note);
        } catch (err) {
            console.error(`导入文件失败: ${filePath}`, err);
            failed++;
        }
    });

    if (!notes.length) {
        showToast('导入失败：所选文件无法读取');
        return;
    }

State.notes.unshift(...notes);

    if (State.currentFilter === 'todos') State.currentFilter = 'all';
    if (notes.length === 1) openTab(notes[0].id);
    renderApp();

    let summary = notes.length === 1
        ? `已导入笔记《${itemDisplayTitle(notes[0])}》`
        : `已导入 ${notes.length} 个文件为笔记`;
    if (failed) summary += `，另有 ${failed} 个失败`;
    if (overflow) summary += `，${overflow} 个超出单次上限未导入`;
    showToast(summary);
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

playTabCloseFlyAway(noteId);
    State.openNoteIds = State.openNoteIds.filter(id => id !== noteId);
    if (State.activeNoteId === noteId) {
        State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    }
}

function switchTabByStep(step) {
    const ids = State.openNoteIds;
    if (ids.length < 2) return;

    const current = ids.indexOf(State.activeNoteId);
    const next = current === -1
        ? (step > 0 ? 0 : ids.length - 1)
        : (current + step + ids.length) % ids.length;
    if (ids[next] === State.activeNoteId) return;

flushPendingSave();
    State.activeNoteId = ids[next];
    renderApp();
}

function getActiveNote() {
    if (!State.activeNoteId) return null;
    return State.notes.find(n => n.id === State.activeNoteId) || null;
}

function getActiveTodo() {
    if (!State.activeNoteId) return null;
    return State.todos.find(t => t.id === State.activeNoteId) || null;
}

function getActiveItem() {
    return getActiveTodo() || getActiveNote();
}

function getItemById(itemId) {
    return State.todos.find(t => t.id === itemId) || State.notes.find(n => n.id === itemId) || null;
}

function isTodoItem(item) {
    if (!item || typeof item !== 'object') return false;
    const kind = item[ITEM_KIND_KEY];
    if (kind === 'todo') return true;
    if (kind === 'note') return false;

const isTodo = State.todos.indexOf(item) !== -1;
    markItemKind(item, isTodo ? 'todo' : 'note');
    return isTodo;
}

const ITEM_KIND_KEY = '__esprinKind';

function markItemKind(item, kind) {
    if (!item || typeof item !== 'object') return item;
    try {
        Object.defineProperty(item, ITEM_KIND_KEY, {
            value: kind,
            writable: true,
            enumerable: false,
            configurable: true
        });
    } catch (err) {

    }
    return item;
}

function markItemKinds(notes, todos) {
    if (Array.isArray(notes)) notes.forEach(item => markItemKind(item, 'note'));
    if (Array.isArray(todos)) todos.forEach(item => markItemKind(item, 'todo'));
}

function itemKindLabel(item) {
    return isTodoItem(item) ? '待办' : '笔记';
}

function isSharedItem(item) {
    return !!(item && item.shared && item.shared.owner && item.shared.noteId);
}

function sharedItemOwner(item) {
    return isSharedItem(item) ? String(item.shared.owner) : '';
}

function itemDisplayTitle(item) {
    return item.title || `未命名${itemKindLabel(item)}`;
}

function isReadOnlyItem(item) {
    return !!(item && (item.isTrashed || isSecretLocked(item)));
}

let pendingSave = null;

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

function commitPendingSave() {
    const pending = pendingSave;
    pendingSave = null;
    if (!pending) return false;

    const item = getItemById(pending.itemId);
    if (!item) return false;

    item.title = pending.title;
    item.content = pending.content;
    item.updatedAt = Date.now();

saveItem(item);
    return true;
}

function flushPendingSave() {
    if (State.autoSaveTimer) {
        clearTimeout(State.autoSaveTimer);
        State.autoSaveTimer = null;
    }
    if (commitPendingSave()) {
        document.getElementById('save-status').textContent = '已保存';
    }
}

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

    if (isSharedItem(item)) {
        showToast('共享笔记不能移入废纸篓：可在右键菜单里「退出共享」');
        return;
    }
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

async function exportItemMarkdown(itemId) {

    if (State.activeNoteId === itemId) flushPendingSave();

    const item = getItemById(itemId);
    if (!item) return;

if (isSecretLocked(item) && !(await ensureItemRevealed(itemId))) return;

    const blob = new Blob([item.content || ''], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.title || `无标题${itemKindLabel(item)}`}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出 Markdown');
}

async function purgeItem(itemId) {
    const item = getItemById(itemId);
    if (!item) return;

    if (isSharedItem(item)) {
        showToast('共享笔记不能彻底删除：可在右键菜单里「退出共享」');
        return;
    }
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

    deleteItemFile(itemId);
    State.notes = State.notes.filter(n => n.id !== itemId);
    State.todos = State.todos.filter(t => t.id !== itemId);
    closeTab(itemId);
    renderApp();
    showToast('已彻底删除');
}

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

    State.notes.filter(n => n.isTrashed && !isSharedItem(n)).forEach(n => deleteNoteFile(n.id));
    State.notes = State.notes.filter(n => !n.isTrashed || isSharedItem(n));
    State.todos.filter(t => t.isTrashed).forEach(t => deleteTodoFile(t.id));
    State.todos = State.todos.filter(t => !t.isTrashed);
    renderApp();
    showToast('已清空废纸篓');
}

async function renameFolder(folder) {
    const name = await showPrompt('请输入新的文件夹名称', {
        title: '重命名文件夹',
        detail: '文件夹中的笔记与待办会一并跟随新名称，内容本身不变。',
        icon: 'edit',
        placeholder: '文件夹名称...',
        value: folder,
        confirmLabel: '重命名'
    });
    if (name === null) return;
    if (!name) {
        showToast('重命名失败：文件夹名称不能为空');
        return;
    }
    if (name === folder) return;
    if (State.folders.includes(name)) {
        showToast('重命名失败：同名文件夹已存在');
        return;
    }

    State.folders = State.folders.map(f => (f === folder ? name : f));
    [...State.notes, ...State.todos].forEach(entry => {
        if (entry.folder !== folder) return;
        entry.folder = name;
        saveItem(entry);
    });

    if (State.currentFilter === `folder:${folder}`) State.currentFilter = `folder:${name}`;
    saveConfig();
    renderApp();
    showToast(`已重命名为「${name}」`);
}

async function deleteFolder(folder) {
    const confirmed = await showConfirm(`删除文件夹“${folder}”？`, {
        title: '删除文件夹',
        detail: '该文件夹中的笔记与待办将移入“默认”文件夹，内容本身不会被删除。',
        type: 'warning',
        icon: 'delete',
        confirmLabel: '删除',
        danger: true
    });
    if (!confirmed) return;

    State.folders = State.folders.filter(f => f !== folder);

    [...State.notes, ...State.todos].forEach(entry => {
        if (entry.folder !== folder) return;
        entry.folder = '默认';
        saveItem(entry);
    });
    if (State.currentFilter === `folder:${folder}`) State.currentFilter = 'all';
    saveConfig();
    renderApp();
}

function purgeExpiredTrashItems() {
    const days = normalizeTrashRetentionDays(State.trashRetentionDays);
    if (!days) return 0;

    const cutoff = Date.now() - days * TRASH_RETENTION_DAY_MS;

    const isExpired = (item) => item.isTrashed && !isSharedItem(item) && (item.updatedAt || 0) < cutoff;
    const expiredNotes = State.notes.filter(isExpired);
    const expiredTodos = State.todos.filter(isExpired);
    if (!expiredNotes.length && !expiredTodos.length) return 0;

    expiredNotes.forEach(item => deleteNoteFile(item.id));
    expiredTodos.forEach(item => deleteTodoFile(item.id));

    const expiredIds = new Set([...expiredNotes, ...expiredTodos].map(item => item.id));
    State.notes = State.notes.filter(item => !expiredIds.has(item.id));
    State.todos = State.todos.filter(item => !expiredIds.has(item.id));

State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || !expiredIds.has(id));
    if (expiredIds.has(State.activeNoteId)) {
        State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    }

    return expiredIds.size;
}

function runTrashAutoPurge() {
    const removed = purgeExpiredTrashItems();
    if (removed > 0) {
        renderApp();
        showToast(`已自动清理 ${removed} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
    }
    return removed;
}

function syncTrashRetentionSelect() {
    const select = document.getElementById('setting-trash-retention');
    if (select) select.value = String(normalizeTrashRetentionDays(State.trashRetentionDays));
}

function normalizeImportedItems(rawList, kind, usedIds = new Set()) {
    if (!Array.isArray(rawList)) return [];
    const now = Date.now();
    const items = [];

    rawList.forEach((raw) => {
        if (!raw || typeof raw !== 'object') return;

        let id = typeof raw.id === 'string' ? raw.id.trim() : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || usedIds.has(id)) {
            id = generateUniqueItemId();

            while (usedIds.has(id)) id = generateUniqueItemId();
        }
        usedIds.add(id);

        const createdAt = Number(raw.createdAt);
        const updatedAt = Number(raw.updatedAt);
        const safeCreatedAt = Number.isFinite(createdAt) ? Math.round(createdAt) : now;

        const item = {
            id,
            title: typeof raw.title === 'string' ? raw.title : '',
            content: typeof raw.content === 'string' ? raw.content : '',
            folder: typeof raw.folder === 'string' && raw.folder.trim() ? raw.folder.trim() : '默认',
            tags: Array.isArray(raw.tags) ? raw.tags.filter(tag => typeof tag === 'string' && tag.trim()) : [],
            isPinned: !!raw.isPinned,
            isTrashed: !!raw.isTrashed,
            isHidden: !!raw.isHidden,
            createdAt: safeCreatedAt,
            updatedAt: Number.isFinite(updatedAt) ? Math.round(updatedAt) : safeCreatedAt
        };

item.locked = !!raw.locked && isSecretEnvelope(item.content);
        item.unlocked = false;
        if (kind === 'todo') item.isDone = !!raw.isDone;
        items.push(item);
    });

    return items;
}

const SEARCH_TEXT_CACHE = new WeakMap();

function itemSearchText(item) {
    const title = typeof item.title === 'string' ? item.title : '';

    const content = isSecretLocked(item) ? '' : (typeof item.content === 'string' ? item.content : '');
    const cached = SEARCH_TEXT_CACHE.get(item);
    if (cached && cached.title === title && cached.content === content) return cached.text;

const text = `${title}\n${content}`.toLowerCase();
    SEARCH_TEXT_CACHE.set(item, { title, content, text });
    return text;
}

function getFilteredItems() {

    const filter = State.currentFilter;
    const isTrashView = filter === 'trash';
    const isPinnedView = filter === 'pinned';
    const onlyNotes = filter === 'all';
    const onlyTodos = filter === 'todos';
    const folderFilter = filter.startsWith('folder:') ? filter.slice(7) : null;
    const tagFilter = filter.startsWith('tag:') ? filter.slice(4) : null;
    const refineFolder = State.filterFolder || '';
    const refineTag = State.filterTag || '';
    const query = State.searchQuery.trim().toLowerCase();
    const sortBy = State.sortBy;

    const list = [];

const consider = (item, isTodo) => {
        if (onlyNotes && isTodo) return;
        if (onlyTodos && !isTodo) return;

        if (isSecretHidden(item)) return;

        if (item.isTrashed) {
            if (!isTrashView) return;
        } else {
            if (isTrashView) return;
            if (isPinnedView && !item.isPinned) return;
            if (folderFilter !== null && item.folder !== folderFilter) return;
            if (tagFilter !== null && (!item.tags || !item.tags.includes(tagFilter))) return;
        }

        if (refineFolder && item.folder !== refineFolder) return;
        if (refineTag && (!Array.isArray(item.tags) || !item.tags.includes(refineTag))) return;

        if (query && !itemSearchText(item).includes(query)) return;

        list.push(item);
    };
    State.notes.forEach(item => consider(item, false));
    State.todos.forEach(item => consider(item, true));

    return list.sort((a, b) => {
        if (!isTrashView) {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
        }
        if (sortBy === 'updated-desc') return b.updatedAt - a.updatedAt;
        if (sortBy === 'created-desc') return b.createdAt - a.createdAt;

        if (sortBy === 'title-asc') return itemDisplayTitle(a).localeCompare(itemDisplayTitle(b), 'zh-CN');
        return 0;
    });
}
