/* 待办操作：新建、完成状态与待办卡片。
   待办与笔记共用同一套文件格式（内嵌元数据注释 + Markdown 正文，仅多一行 isDone）与
   同一套标签页、编辑器、中栏列表和废纸篓，因此这个文件只补待办独有的部分。 */

// 新建待办的默认归属：与笔记一致，沿用当前的文件夹筛选，标签视图下直接带上该标签
function newTodoDefaults() {
    return {
        folder: State.currentFilter.startsWith('folder:') ? State.currentFilter.replace('folder:', '') : '默认',
        tags: State.currentFilter.startsWith('tag:') ? [State.currentFilter.replace('tag:', '')] : []
    };
}

// Todo Operations
function createNewTodo() {
    const defaults = newTodoDefaults();
    const newTodo = {
        id: generateUniqueItemId('todo'),
        title: '',
        content: '',
        folder: defaults.folder,
        tags: defaults.tags,
        isPinned: false,
        isTrashed: false,
        isDone: false,
        // 秘密本：新建的待办既不隐藏也不加密
        isHidden: false,
        locked: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    // 创建对应 data/todos/{id}.md 文件（元数据注释与正文一并写入）
    saveTodo(newTodo);
    markItemKind(newTodo, 'todo');
    State.todos.unshift(newTodo);

    // 在「笔记」视图下新建待办时切到「待办」视图，否则新建的待办不会出现在列表里
    if (State.currentFilter === 'all') State.currentFilter = 'todos';
    openTab(newTodo.id);
    renderApp();

    setTimeout(() => {
        const titleInput = document.getElementById('input-note-title');
        if (titleInput) titleInput.focus();
    }, 50);

    showToast('已创建新待办');
}

// 完成 / 取消完成：与置顶一样只改元数据，不刷新 updatedAt，
// 因此废纸篓自动清理的计时始终按最后一次实际编辑算起。
function toggleTodoDone(todoId) {
    const todo = State.todos.find(t => t.id === todoId);
    // 废纸篓中与还没解锁的加密待办都是只读的，完成状态也无从切换
    if (!todo || isReadOnlyItem(todo)) return;
    todo.isDone = !todo.isDone;
    saveTodo(todo);
    renderApp();
    showToast(todo.isDone ? '已完成' : '已标记为未完成');
}

// 单张待办卡片：左侧勾选框 + 右侧标题/摘要/时间（视觉沿用笔记卡片）
function createTodoCard(todo, { isTrashView = false } = {}) {
    const card = document.createElement('div');
    const isActive = todo.id === State.activeNoteId;
    card.className = `note-card todo-card${todo.isDone ? ' done' : ''}${isActive ? ' active' : ''}`;

    // 废纸篓中的待办只读，不提供勾选项
    const checkIcon = todo.isDone ? 'check_box' : 'check_box_outline_blank';
    card.innerHTML = `
        ${isTrashView ? '' : `
            <button class="todo-check" title="${todo.isDone ? '标记为未完成' : '标记为已完成'}">
                <span class="ms-icon sm">${checkIcon}</span>
            </button>
        `}
        <div class="todo-card-body">
            <div class="note-card-title">
                <span>${escapeHTML(itemDisplayTitle(todo))}</span>
                ${todo.isPinned ? '<span class="ms-icon xs fill" style="color: var(--accent);">push_pin</span>' : ''}
            </div>
            <div class="note-card-preview">${escapeHTML(notePreviewText(todo))}</div>
            <div class="note-card-footer">
                <span>${formatDate(todo.updatedAt)}</span>
                <span class="note-card-folder">${escapeHTML(todo.folder)}</span>
            </div>
        </div>
    `;

    card.addEventListener('click', (e) => {
        if (e.target.closest('.todo-check')) return;
        openTab(todo.id);
        renderApp();
    });

    const checkBtn = card.querySelector('.todo-check');
    if (checkBtn) {
        checkBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleTodoDone(todo.id);
        });
    }

    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, todo.id);
    });

    return card;
}
