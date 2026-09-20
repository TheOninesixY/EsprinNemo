/* 界面渲染：侧边栏、标签页、中栏列表（笔记与待办混排）与工作区 */

// 各区域的渲染签名：与上一次一致时跳过 DOM 重建，避免无意义的整树重排
const renderSignatures = { folders: null, tags: null, tabs: null, list: null };

// 侧边栏顶部的筛选条目（静态节点，只需查询一次）
const sidebarNavItems = document.querySelectorAll('.sidebar .nav-item');

// UI Rendering
function renderApp() {
    renderCounts();
    renderFolders();
    renderTags();
    renderTabs();
    renderListPanel();
    renderWorkspace();
}

// 侧边栏宽度过渡时长（与 CSS 中 .sidebar 的 width 过渡保持一致）
const SIDEBAR_WIDTH_TRANSITION_MS = 180;

let sidebarFadeTimer = null;
let sidebarFadeInBound = false;

// 淡入结束：移除临时类并清掉兜底定时器
function finishSidebarTextFadeIn() {
    if (sidebarFadeTimer) {
        clearTimeout(sidebarFadeTimer);
        sidebarFadeTimer = null;
    }
    const sidebar = document.getElementById('app-sidebar');
    if (sidebar) sidebar.classList.remove('text-fading');
}

// 侧边栏收起/展开：收起后只剩一条窄条，筛选入口仅保留图标
function applySidebarCollapsed() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;

    // 宽度过渡结束（或超时兜底）后再让文字淡入
    if (!sidebarFadeInBound) {
        sidebar.addEventListener('transitionend', (e) => {
            if (e.target === sidebar && e.propertyName === 'width') finishSidebarTextFadeIn();
        });
        sidebarFadeInBound = true;
    }

    const collapsed = !!State.sidebarCollapsed;
    // 收起状态类挂在 <html> 上：boot.js 在首屏渲染前已写入同一个类，
    // 因此启动时这里改的是相同状态，不会产生任何过渡或动效
    const rootClass = document.documentElement.classList;
    // 仅真正的"收起 → 展开"才需要延迟淡入，启动时的初始渲染直接显示
    const expanding = !collapsed && rootClass.contains(SIDEBAR_COLLAPSED_CLASS);

    if (collapsed) {
        // 收起：文字直接隐藏，避免收缩过程中出现被挤压的文字
        finishSidebarTextFadeIn();
        rootClass.add(SIDEBAR_COLLAPSED_CLASS);
    } else {
        rootClass.remove(SIDEBAR_COLLAPSED_CLASS);
        if (expanding) {
            sidebar.classList.add('text-fading');
            if (sidebarFadeTimer) clearTimeout(sidebarFadeTimer);
            // 兜底：侧边栏处于隐藏状态时不会触发过渡，靠定时器保证文字最终可见
            sidebarFadeTimer = setTimeout(finishSidebarTextFadeIn, SIDEBAR_WIDTH_TRANSITION_MS + 60);
        } else {
            finishSidebarTextFadeIn();
        }
    }

    const btn = document.getElementById('btn-toggle-sidebar');
    if (btn) btn.title = collapsed ? '展开侧边栏' : '收起侧边栏';

    const icon = document.getElementById('sidebar-toggle-icon');
    if (icon) icon.textContent = collapsed ? 'keyboard_double_arrow_right' : 'keyboard_double_arrow_left';
}

// 切换收起状态并写入配置，下次启动沿用同一状态
function toggleSidebarCollapsed() {
    State.sidebarCollapsed = !State.sidebarCollapsed;
    applySidebarCollapsed();
    saveConfig();
}

// 中栏标题：与当前筛选一一对应
function panelCategoryTitle(filter) {
    if (filter === 'all') return '全部笔记';
    if (filter === 'todos') return '全部待办';
    if (filter === 'pinned') return '已置顶';
    if (filter === 'trash') return '废纸篓';
    if (filter.startsWith('folder:')) return filter.replace('folder:', '');
    if (filter.startsWith('tag:')) return '#' + filter.replace('tag:', '');
    return '全部笔记';
}

function renderCounts() {
    // 笔记与待办各统计一个「全部」；已置顶与废纸篓里两类混排，因此一并计入
    let activeNoteCount = 0;
    let activeTodoCount = 0;
    let pinnedCount = 0;
    let trashedCount = 0;
    State.notes.forEach(note => {
        if (note.isTrashed) {
            trashedCount++;
        } else {
            activeNoteCount++;
            if (note.isPinned) pinnedCount++;
        }
    });

    State.todos.forEach(todo => {
        if (todo.isTrashed) {
            trashedCount++;
        } else {
            activeTodoCount++;
            if (todo.isPinned) pinnedCount++;
        }
    });

    document.getElementById('count-all').textContent = activeNoteCount;
    document.getElementById('count-todos').textContent = activeTodoCount;
    document.getElementById('count-pinned').textContent = pinnedCount;
    document.getElementById('count-trash').textContent = trashedCount;
    document.getElementById('sidebar-stat').textContent = `共 ${activeNoteCount} 篇笔记 · ${activeTodoCount} 项待办`;

    sidebarNavItems.forEach(el => {
        const f = el.getAttribute('data-filter');
        if (f === State.currentFilter) el.classList.add('active');
        else el.classList.remove('active');
    });

    // 「清空」按钮只在废纸篓视图出现，一次清空笔记与待办
    const clearBtn = document.getElementById('btn-empty-trash');
    clearBtn.classList.toggle('hidden', State.currentFilter !== 'trash');
    document.getElementById('panel-category-title').textContent = panelCategoryTitle(State.currentFilter);
}

function renderFolders() {
    const signature = `${State.currentFilter}\u0001${State.folders.join('\u0001')}`;
    if (renderSignatures.folders === signature) return;
    renderSignatures.folders = signature;

    const container = document.getElementById('sidebar-folder-list');
    container.innerHTML = '';

    State.folders.forEach(folder => {
        const isSelected = State.currentFilter === `folder:${folder}`;
        const item = document.createElement('div');
        item.className = `nav-item folder-item ${isSelected ? 'active' : ''}`;
        item.innerHTML = `
            <div class="nav-item-left">
                <span class="ms-icon sm">folder</span>
                <span class="nav-text">${escapeHTML(folder)}</span>
            </div>
            ${folder !== '默认' ? `
                <button class="btn-del-folder" title="删除文件夹">
                    <span class="ms-icon xs">close</span>
                </button>
            ` : ''}
        `;

        item.addEventListener('click', (e) => {
            if (e.target.closest('.btn-del-folder')) return;
            State.currentFilter = `folder:${folder}`;
            renderApp();
        });

        const delBtn = item.querySelector('.btn-del-folder');
        if (delBtn) {
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
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
                // 文件夹下的笔记与待办移回“默认”，需要连同元数据一起写回各自文件
                [...State.notes, ...State.todos].forEach(entry => {
                    if (entry.folder !== folder) return;
                    entry.folder = '默认';
                    saveItem(entry);
                });
                if (State.currentFilter === `folder:${folder}`) State.currentFilter = 'all';
                saveConfig();
                renderApp();
            });
        }

        container.appendChild(item);
    });
}

// 应用中已有的标签（仅统计未删除的笔记与待办），排序后供弹窗里的候选项列表使用
function getAllTags() {
    const tags = new Set();
    [...State.notes, ...State.todos].filter(item => !item.isTrashed).forEach(item => {
        if (Array.isArray(item.tags)) item.tags.forEach(t => { if (t) tags.add(t); });
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function renderTags() {
    // 标签面板统计未删除的笔记与待办：两者共用同一个列表，标签过滤因此对两类都生效
    const tagSet = new Set();
    [...State.notes, ...State.todos].forEach(item => {
        if (item.isTrashed) return;
        if (Array.isArray(item.tags)) item.tags.forEach(t => { if (t) tagSet.add(t); });
    });

    const signature = `${State.currentFilter}\u0001${Array.from(tagSet).join('\u0001')}`;
    if (renderSignatures.tags === signature) return;
    renderSignatures.tags = signature;

    const container = document.getElementById('sidebar-tag-list');
    container.innerHTML = '';

    if (tagSet.size === 0) {
        container.innerHTML = `<span style="font-size: 11px; color: var(--text-muted); padding: 4px;">无标签</span>`;
        return;
    }

    tagSet.forEach(tag => {
        const isSelected = State.currentFilter === `tag:${tag}`;
        const pill = document.createElement('span');
        pill.className = `tag-pill ${isSelected ? 'active' : ''}`;
        pill.textContent = `#${tag}`;
        pill.addEventListener('click', () => {
            State.currentFilter = isSelected ? 'all' : `tag:${tag}`;
            renderApp();
        });
        container.appendChild(pill);
    });
}

// Titlebar Tabs (Extends up to the new note button, mouse wheel over container scrolls horizontally)
function renderTabs() {
    const tabsContainer = document.getElementById('titlebar-tabs');

    // 滚轮横向滚动：只需绑定一次，不必每次渲染都重建闭包
    if (!tabsContainer.onwheel) {
        tabsContainer.onwheel = (e) => {
            if (tabsContainer.scrollWidth > tabsContainer.clientWidth) {
                e.preventDefault();
                tabsContainer.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
            }
        };
    }

    // 丢弃指向已不存在条目的标签，避免留下打不开的幽灵标签
    State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || !!getItemById(id));

    const signature = `${State.activeNoteId}\u0001${State.openNoteIds.map(id => {
        const item = id === 'settings' ? null : getItemById(id);
        return `${id}\u0002${item ? (item.title || '') : ''}`;
    }).join('\u0001')}`;
    if (renderSignatures.tabs === signature) return;
    renderSignatures.tabs = signature;

    tabsContainer.innerHTML = '';

    State.openNoteIds.forEach(id => {
        const isActive = id === State.activeNoteId;
        const tab = document.createElement('div');
        tab.className = `tab-item ${isActive ? 'active' : ''}`;

        if (id === 'settings') {
            tab.innerHTML = `
                <span class="ms-icon xs" style="opacity: 0.7;">settings</span>
                <span class="tab-title">设置</span>
                <button class="tab-close-btn" title="关闭设置">
                    <span class="ms-icon xs">close</span>
                </button>
            `;
        } else {
            const item = getItemById(id);
            if (!item) return;
            // 笔记与待办共用标签栏，用图标区分类型
            const icon = isTodoItem(item) ? 'check_box' : 'description';
            tab.innerHTML = `
                <span class="ms-icon xs" style="opacity: 0.7;">${icon}</span>
                <span class="tab-title">${escapeHTML(itemDisplayTitle(item))}</span>
                <button class="tab-close-btn" title="关闭标签">
                    <span class="ms-icon xs">close</span>
                </button>
            `;
        }

        tab.addEventListener('click', (e) => {
            if (e.target.closest('.tab-close-btn')) return;
            State.activeNoteId = id;
            renderApp();
        });

        // 中键关闭标签：拦截 mousedown 以阻止 Chromium 的自动滚动，再在 auxclick 中关闭
        tab.addEventListener('mousedown', (e) => {
            if (e.button === 1) e.preventDefault();
        });
        tab.addEventListener('auxclick', (e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            closeTab(id);
            renderApp();
        });

        tab.querySelector('.tab-close-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(id);
            renderApp();
        });

        tabsContainer.appendChild(tab);
    });
}

// 列表卡片只展示首行摘要，先截断再转义，避免长文档每次都做整篇转义
const PREVIEW_MAX_LENGTH = 120;

// 判定首行边界的空白字符：与 String.prototype.trim 的口径保持一致（含全角空格等）
function isPreviewWhitespace(code) {
    return code <= 32
        || code === 0xa0
        || code === 0x1680
        || (code >= 0x2000 && code <= 0x200a)
        || code === 0x2028
        || code === 0x2029
        || code === 0x202f
        || code === 0x205f
        || code === 0x3000
        || code === 0xfeff;
}

// 列表卡片摘要：取正文首个非空行（笔记与待办的卡片共用同一个函数）。
// 这里只扫到第一行为止，不对整篇正文做 trim / split —— 几百 KB 的笔记下差别很明显。
function notePreviewText(item) {
    const raw = typeof item.content === 'string' ? item.content : '';
    const length = raw.length;

    // 跳过开头的空白与空行
    let start = 0;
    while (start < length && isPreviewWhitespace(raw.charCodeAt(start))) start++;
    if (start >= length) return '暂无内容';

    // 首行到第一个换行符为止，行尾空白一并去掉
    const lineBreak = raw.indexOf('\n', start);
    let end = lineBreak === -1 ? length : lineBreak;
    while (end > start && isPreviewWhitespace(raw.charCodeAt(end - 1))) end--;

    const firstLine = raw.slice(start, end);
    return firstLine.length > PREVIEW_MAX_LENGTH ? firstLine.slice(0, PREVIEW_MAX_LENGTH) : firstLine;
}

// 搜索框提示随当前视图变化：笔记 / 待办两个入口各说各的，其余视图为两类混合
function searchPlaceholderText(filter) {
    if (filter === 'all') return '搜索笔记... (Ctrl+Shift+F)';
    if (filter === 'todos') return '搜索待办... (Ctrl+Shift+F)';
    return '搜索笔记与待办... (Ctrl+Shift+F)';
}

// 中栏列表：笔记与待办混排在同一个列表里，待办卡片多一个完成勾选框
function renderListPanel() {
    const container = document.getElementById('notes-list-box');
    const list = getFilteredItems();
    const isTrashView = State.currentFilter === 'trash';

    const searchInput = document.getElementById('input-search');
    const placeholder = searchPlaceholderText(State.currentFilter);
    if (searchInput.placeholder !== placeholder) searchInput.placeholder = placeholder;

    // 签名里用列表实际展示的时间（分钟精度）与完成状态：顺序或完成状态变化会重建整列列表，
    // 而“编辑正文但展示时间未变”这类提交不会触发整树重建
    const signature = `${State.currentFilter}\u0001${State.searchQuery}\u0002${State.sortBy}\u0003${State.activeNoteId}\u0004`
        + list.map(item => `${item.id}\u0005${isTodoItem(item) ? 1 : 0}\u0005${item.title || ''}\u0005${formatDate(item.updatedAt)}\u0005${item.folder}\u0005${item.isPinned ? 1 : 0}\u0005${item.isDone ? 1 : 0}\u0005${notePreviewText(item)}`).join('\u0006');
    if (renderSignatures.list === signature) return;
    renderSignatures.list = signature;

    container.innerHTML = '';

    if (list.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 32px 10px; color: var(--text-muted); font-size: 12px;">
                无匹配内容
            </div>
        `;
        return;
    }

    // 先插入到文档碎片，一次性挂载，避免逐个卡片触发样式计算与重排
    const fragment = document.createDocumentFragment();
    list.forEach(item => {
        fragment.appendChild(isTodoItem(item) ? createTodoCard(item, { isTrashView }) : createNoteCard(item));
    });
    container.appendChild(fragment);
}

// 单张笔记卡片
function createNoteCard(note) {
    const card = document.createElement('div');
    card.className = `note-card ${note.id === State.activeNoteId ? 'active' : ''}`;
    card.innerHTML = `
        <div class="note-card-title">
            <span>${escapeHTML(note.title || '未命名笔记')}</span>
            ${note.isPinned ? '<span class="ms-icon xs fill" style="color: var(--accent);">push_pin</span>' : ''}
        </div>
        <div class="note-card-preview">${escapeHTML(notePreviewText(note))}</div>
        <div class="note-card-footer">
            <span>${formatDate(note.updatedAt)}</span>
            <span class="note-card-folder">${escapeHTML(note.folder)}</span>
        </div>
    `;

    card.addEventListener('click', () => {
        openTab(note.id);
        renderApp();
    });

    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, note.id);
    });

    return card;
}

function renderWorkspace() {
    const settingsView = document.getElementById('settings-view');
    const sidebar = document.querySelector('.sidebar');
    const notesPanel = document.querySelector('.notes-panel');
    const workspace = document.getElementById('workspace-box');
    const emptyState = document.getElementById('empty-state');
    const topbar = document.getElementById('editor-topbar');
    const toolbar = document.getElementById('editor-toolbar');
    const titleArea = document.querySelector('.editor-title-area');
    const contentArea = document.querySelector('.editor-content-area');
    const footer = document.querySelector('.editor-footer');

    // 1. 如果当前选中的是设置标签
    if (State.activeNoteId === 'settings') {
        if (sidebar) sidebar.classList.add('hidden');
        if (notesPanel) notesPanel.classList.add('hidden');
        if (workspace) workspace.classList.add('hidden');
        if (settingsView) settingsView.classList.remove('hidden');
        emptyState.classList.add('hidden');
        topbar.classList.add('hidden');
        toolbar.classList.add('hidden');
        titleArea.classList.add('hidden');
        contentArea.classList.add('hidden');
        footer.classList.add('hidden');

        const spellcheckToggle = document.getElementById('setting-spellcheck');
        if (spellcheckToggle) {
            spellcheckToggle.checked = !!State.spellcheck;
        }
        syncTrashRetentionSelect();
        updateDataDirUI();
        syncFontSelects();
        syncAccentControls();
        syncAiSettingsUI();
        applyAiPanelVisibility();
        return;
    }

    if (sidebar) sidebar.classList.remove('hidden');
    if (notesPanel) notesPanel.classList.remove('hidden');
    if (workspace) workspace.classList.remove('hidden');
    if (settingsView) settingsView.classList.add('hidden');
    applyAiPanelVisibility();

    const item = getActiveItem();

    if (!item) {
        emptyState.classList.remove('hidden');
        topbar.classList.add('hidden');
        toolbar.classList.add('hidden');
        titleArea.classList.add('hidden');
        contentArea.classList.add('hidden');
        footer.classList.add('hidden');
        updateAiContextHint();
        return;
    }

    emptyState.classList.add('hidden');
    topbar.classList.remove('hidden');
    toolbar.classList.remove('hidden');
    titleArea.classList.remove('hidden');
    contentArea.classList.remove('hidden');
    footer.classList.remove('hidden');

    const todoItem = isTodoItem(item);
    const titleInput = document.getElementById('input-note-title');
    const contentAreaInput = document.getElementById('textarea-note-content');

    titleInput.placeholder = todoItem ? '无标题待办...' : '无标题笔记...';
    if (document.activeElement !== titleInput) {
        titleInput.value = item.title || '';
    }
    if (document.activeElement !== contentAreaInput) {
        contentAreaInput.value = item.content || '';
    }

    const folderSelect = document.getElementById('editor-folder-select');
    const foldersSignature = `${item.folder}\u0001${State.folders.join('\u0001')}`;
    if (folderSelect.dataset.signature !== foldersSignature) {
        folderSelect.dataset.signature = foldersSignature;
        folderSelect.innerHTML = '';
        State.folders.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            if (f === item.folder) opt.selected = true;
            folderSelect.appendChild(opt);
        });
    }

    const tagsContainer = document.getElementById('editor-tags-container');
    const readOnly = isReadOnlyItem(item);
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const tagsSignature = `${readOnly ? 1 : 0}\u0001${tags.join('\u0001')}`;
    if (tagsContainer.dataset.signature !== tagsSignature) {
        tagsContainer.dataset.signature = tagsSignature;
        tagsContainer.innerHTML = '';
        tags.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'editor-tag-chip';
            chip.innerHTML = `<span>#${escapeHTML(tag)}</span>`;
            // 只读时不提供“移除标签”入口
            if (!readOnly) {
                const removeBtn = document.createElement('button');
                removeBtn.title = '移除标签';
                removeBtn.innerHTML = '<span class="ms-icon xs">close</span>';
                // 每次点击都重新取回当前条目，避免闭包引用已被替换的旧对象
                removeBtn.onclick = () => {
                    const active = getActiveItem();
                    if (!active || !Array.isArray(active.tags)) return;
                    active.tags = active.tags.filter(t => t !== tag);
                    saveItem(active);
                    renderApp();
                };
                chip.appendChild(removeBtn);
            }
            tagsContainer.appendChild(chip);
        });
    }

    const pinBtn = document.getElementById('btn-note-pin');
    if (item.isPinned) {
        pinBtn.querySelector('.ms-icon').classList.add('fill');
        pinBtn.style.color = 'var(--accent)';
    } else {
        pinBtn.querySelector('.ms-icon').classList.remove('fill');
        pinBtn.style.color = 'var(--text-secondary)';
    }

    // 待办多一个完成状态开关，非待办条目下隐藏该按钮
    const doneBtn = document.getElementById('btn-todo-done');
    doneBtn.classList.toggle('hidden', !todoItem);
    if (todoItem) {
        doneBtn.querySelector('.ms-icon').textContent = item.isDone ? 'check_circle' : 'radio_button_unchecked';
        doneBtn.style.color = item.isDone ? 'var(--accent)' : 'var(--text-secondary)';
        doneBtn.title = item.isDone ? '标记为未完成' : '标记为已完成';
        doneBtn.disabled = readOnly;
    }

    applyEditorReadOnly(item);
    renderMarkdown();
    updateStats();
    updateViewModeUI();
    // 切换条目后，AI 面板的“附带笔记”提示要跟着变
    updateAiContextHint();
}
