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

    markItemKind(newNote, 'note');
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
    if (!item || typeof item !== 'object') return false;
    const kind = item[ITEM_KIND_KEY];
    if (kind === 'todo') return true;
    if (kind === 'note') return false;
    // 尚未标记的条目（例如由 AI 工具刚建出来的）在这里补上一次线性查找，
    // 之后就走上面的常数时间分支，不会再对每一项扫描整张列表
    const isTodo = State.todos.indexOf(item) !== -1;
    markItemKind(item, isTodo ? 'todo' : 'note');
    return isTodo;
}

/* 条目类型标记：写在对象上的不可枚举属性（不会进入 JSON 序列化，也不影响备份导出）。
   列表渲染、渲染签名计算与每次保存都要判断条目类型，条目一多，
   “逐项扫描 State.todos” 会退化成 O(n²)，因此在数据进入 State 时就一次性定下来。 */
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
        // 极端情况下（例如对象被冻结）标记失败：isTodoItem 会退回线性查找，功能不受影响
    }
    return item;
}

// 批量标记：笔记与待办载入 / 导入到 State 之后调用一次
function markItemKinds(notes, todos) {
    if (Array.isArray(notes)) notes.forEach(item => markItemKind(item, 'note'));
    if (Array.isArray(todos)) todos.forEach(item => markItemKind(item, 'todo'));
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

/* ---------------- 备份导入 ---------------- */

// 把备份里的条目重新规范化：字段类型、id 唯一性与时间戳都在这里落定。
// 手写或旧版本的备份可能带重复 id、非法时间戳与非字符串字段，
// 直接塞进 State 会让两篇内容写进同一个文件、列表排序出现 NaN。
// usedIds 由调用方提供时，笔记与待办共用同一份 id 记录，避免跨类型的重复 id。
function normalizeImportedItems(rawList, kind, usedIds = new Set()) {
    if (!Array.isArray(rawList)) return [];
    const now = Date.now();
    const items = [];

    rawList.forEach((raw) => {
        if (!raw || typeof raw !== 'object') return;

        let id = typeof raw.id === 'string' ? raw.id.trim() : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || usedIds.has(id)) {
            id = generateUniqueItemId();
            // generateUniqueItemId 只保证不与当前 State 冲突，这里再避开同一批里的重复
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
            createdAt: safeCreatedAt,
            updatedAt: Number.isFinite(updatedAt) ? Math.round(updatedAt) : safeCreatedAt
        };
        if (kind === 'todo') item.isDone = !!raw.isDone;
        items.push(item);
    });

    return items;
}

/* ---------------- 中栏列表过滤 ---------------- */

/* 检索用的正文：搜索框每敲一个字都要把全部条目拿出来做一次 includes，
   而小写化会重建整篇正文——几千字的笔记上，这一步比匹配本身贵得多。
   这里按条目缓存上一次的小写结果，标题与正文都没变时直接复用；
   缓存挂在条目对象上（WeakMap），条目被删除后随之回收。

   代价是每条被搜过的条目会多留一份与正文等长的小写副本
   （条目正文本来就在内存里，因此相当于正文部分的内存翻倍）；
   换来的是连续输入时不再重复扫描全部正文，列表规模大时手感差别明显。 */
const SEARCH_TEXT_CACHE = new WeakMap();

function itemSearchText(item) {
    const title = typeof item.title === 'string' ? item.title : '';
    const content = typeof item.content === 'string' ? item.content : '';
    const cached = SEARCH_TEXT_CACHE.get(item);
    if (cached && cached.title === title && cached.content === content) return cached.text;

    // 标题与正文合成一段再匹配，省掉两次独立的判断；
    // 中间用换行分隔，而搜索框里敲不出换行，因此不会出现跨标题与正文的误命中
    const text = `${title}\n${content}`.toLowerCase();
    SEARCH_TEXT_CACHE.set(item, { title, content, text });
    return text;
}

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
    // 分两趟遍历笔记与待办，省掉一次数组拼接（列表在每次界面刷新时都要重建）；
    // 条目类型由 isTodoItem 常数时间判定，不再对每一项扫描整张待办列表
    const consider = (item, isTodo) => {
        if (onlyNotes && isTodo) return;
        if (onlyTodos && !isTodo) return;

        if (item.isTrashed) {
            if (!isTrashView) return;
        } else {
            if (isTrashView) return;
            if (isPinnedView && !item.isPinned) return;
            if (folderFilter !== null && item.folder !== folderFilter) return;
            if (tagFilter !== null && (!item.tags || !item.tags.includes(tagFilter))) return;
        }

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
        // 标题排序用列表上显示的兜底名（未命名笔记 / 未命名待办），与所见一致
        if (sortBy === 'title-asc') return itemDisplayTitle(a).localeCompare(itemDisplayTitle(b), 'zh-CN');
        return 0;
    });
}
