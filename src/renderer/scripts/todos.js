function newTodoDefaults() {
    const folder = State.filterFolder
        || (State.currentFilter.startsWith('folder:') ? State.currentFilter.replace('folder:', '') : '');
    const tag = State.filterTag
        || (State.currentFilter.startsWith('tag:') ? State.currentFilter.replace('tag:', '') : '');
    return {
        folder: folder || '默认',
        tags: tag ? [tag] : []
    };
}

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

        isHidden: false,
        locked: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

saveTodo(newTodo);
    markItemKind(newTodo, 'todo');
    State.todos.unshift(newTodo);

if (State.currentFilter === 'all') State.currentFilter = 'todos';
    openTab(newTodo.id);
    renderApp();

    setTimeout(() => {
        const titleInput = document.getElementById('input-note-title');
        if (titleInput) titleInput.focus();
    }, 50);

    showToast('已创建新待办');
}

function toggleTodoDone(todoId) {
    const todo = State.todos.find(t => t.id === todoId);

    if (!todo || isReadOnlyItem(todo)) return;
    todo.isDone = !todo.isDone;

    saveItem(todo);
    renderApp();
    showToast(todo.isDone ? '已完成' : '已标记为未完成');
}

function createTodoCard(todo, { isTrashView = false } = {}) {
    const card = document.createElement('div');
    const isActive = todo.id === State.activeNoteId;
    card.className = `note-card todo-card${todo.isDone ? ' done' : ''}${isActive ? ' active' : ''}`;

const checkIcon = todo.isDone ? 'check_box' : 'check_box_outline_blank';
    card.innerHTML = `
        ${isTrashView ? '' : `
            <button class="todo-check" title="${todo.isDone ? '标记为未完成' : '标记为已完成'}">
                <span class="ms-icon sm">${checkIcon}</span>
            </button>
        `}
        <div class="todo-card-body">
            <div class="note-card-title">
                <span class="note-card-title-text">${escapeHTML(itemDisplayTitle(todo))}</span>
                <div class="note-card-title-meta">
                    ${todo.isPinned ? '<span class="ms-icon xs fill" style="color: var(--accent);">push_pin</span>' : ''}
                    <div class="note-card-folder-slot"></div>
                </div>
            </div>
            <div class="note-card-preview">${escapeHTML(notePreviewText(todo))}</div>
            <div class="note-card-footer">
                <span class="note-card-date">${formatDate(todo.updatedAt)}</span>
            </div>
        </div>
    `;

    const editable = isActive && !isReadOnlyItem(todo);
    const folderSlot = card.querySelector('.note-card-folder-slot');
    renderCardFolder(folderSlot, todo, { editable });
    folderSlot.addEventListener('click', (event) => event.stopPropagation());
    const footer = card.querySelector('.note-card-footer');
    footer.classList.toggle('is-editable', editable);
    footer.appendChild(buildCardTags(todo, { editable }));

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
