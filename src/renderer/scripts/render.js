/* 界面渲染：侧边栏、标签页、笔记列表与工作区 */

// 各区域的渲染签名：与上一次一致时跳过 DOM 重建，避免无意义的整树重排
const renderSignatures = { folders: null, tags: null, tabs: null, notes: null };

// 侧边栏顶部的筛选条目（静态节点，只需查询一次）
const sidebarNavItems = document.querySelectorAll('.sidebar .nav-item');

// UI Rendering
function renderApp() {
    renderCounts();
    renderFolders();
    renderTags();
    renderTabs();
    renderNotesList();
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

function renderCounts() {
    // 一次遍历同时统计全部 / 已置顶 / 废纸篓，避免对笔记数组反复过滤
    let activeCount = 0;
    let pinnedCount = 0;
    let trashedCount = 0;
    State.notes.forEach(note => {
        if (note.isTrashed) {
            trashedCount++;
        } else {
            activeCount++;
            if (note.isPinned) pinnedCount++;
        }
    });

    document.getElementById('count-all').textContent = activeCount;
    document.getElementById('count-pinned').textContent = pinnedCount;
    document.getElementById('count-trash').textContent = trashedCount;
    document.getElementById('sidebar-stat').textContent = `共 ${activeCount} 篇笔记`;

    sidebarNavItems.forEach(el => {
        const f = el.getAttribute('data-filter');
        if (f === State.currentFilter) el.classList.add('active');
        else el.classList.remove('active');
    });

    const clearBtn = document.getElementById('btn-empty-trash');
    if (State.currentFilter === 'trash') {
        clearBtn.classList.remove('hidden');
        document.getElementById('panel-category-title').textContent = '废纸篓';
    } else {
        clearBtn.classList.add('hidden');
        if (State.currentFilter === 'all') document.getElementById('panel-category-title').textContent = '全部笔记';
        else if (State.currentFilter === 'pinned') document.getElementById('panel-category-title').textContent = '已置顶';
        else if (State.currentFilter.startsWith('folder:')) document.getElementById('panel-category-title').textContent = State.currentFilter.replace('folder:', '');
        else if (State.currentFilter.startsWith('tag:')) document.getElementById('panel-category-title').textContent = '#' + State.currentFilter.replace('tag:', '');
    }
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
                    detail: '该文件夹中的笔记将移入“默认”文件夹，笔记本身不会被删除。',
                    type: 'warning',
                    icon: 'delete',
                    confirmLabel: '删除',
                    danger: true
                });
                if (!confirmed) return;
                State.folders = State.folders.filter(f => f !== folder);
                State.notes.forEach(n => {
                    if (n.folder === folder) n.folder = '默认';
                });
                if (State.currentFilter === `folder:${folder}`) State.currentFilter = 'all';
                saveData();
                renderApp();
            });
        }

        container.appendChild(item);
    });
}

// 应用中已有的标签（仅统计未删除的笔记），排序后供弹窗里的候选项列表使用
function getAllTags() {
    const tags = new Set();
    State.notes.filter(n => !n.isTrashed).forEach(n => {
        if (Array.isArray(n.tags)) n.tags.forEach(t => { if (t) tags.add(t); });
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function renderTags() {
    const tagSet = new Set();
    State.notes.forEach(n => {
        if (n.isTrashed) return;
        if (Array.isArray(n.tags)) n.tags.forEach(t => { if (t) tagSet.add(t); });
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

    // 丢弃指向已不存在笔记的标签，避免留下打不开的幽灵标签
    State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || State.notes.some(n => n.id === id));

    const signature = `${State.activeNoteId}\u0001${State.openNoteIds.map(id => {
        const note = id === 'settings' ? null : State.notes.find(n => n.id === id);
        return `${id}\u0002${note ? (note.title || '') : ''}`;
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
            const note = State.notes.find(n => n.id === id);
            if (!note) return;
            tab.innerHTML = `
                <span class="ms-icon xs" style="opacity: 0.7;">description</span>
                <span class="tab-title">${escapeHTML(note.title || '未命名笔记')}</span>
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

function notePreviewText(note) {
    const content = String(note.content || '').trim();
    if (!content) return '暂无内容';
    const firstLine = content.split('\n', 1)[0];
    return firstLine.length > PREVIEW_MAX_LENGTH ? firstLine.slice(0, PREVIEW_MAX_LENGTH) : firstLine;
}

function renderNotesList() {
    const container = document.getElementById('notes-list-box');
    const list = getFilteredNotes();

    // 签名里用列表实际展示的时间（分钟精度）：顺序变化会体现为条目顺序变化，
    // 而“编辑内容但展示时间未变”这类提交不会触发整列表重建
    const signature = `${State.currentFilter}\u0001${State.searchQuery}\u0002${State.sortBy}\u0003${State.activeNoteId}\u0004`
        + list.map(note => `${note.id}\u0005${note.title || ''}\u0005${formatDate(note.updatedAt)}\u0005${note.folder}\u0005${note.isPinned ? 1 : 0}\u0005${notePreviewText(note)}`).join('\u0006');
    if (renderSignatures.notes === signature) return;
    renderSignatures.notes = signature;

    container.innerHTML = '';

    if (list.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 32px 10px; color: var(--text-muted); font-size: 12px;">
                无匹配笔记
            </div>
        `;
        return;
    }

    // 先插入到文档碎片，一次性挂载，避免逐个卡片触发样式计算与重排
    const fragment = document.createDocumentFragment();

    list.forEach(note => {
        const card = document.createElement('div');
        const isActive = note.id === State.activeNoteId;
        card.className = `note-card ${isActive ? 'active' : ''}`;
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

        fragment.appendChild(card);
    });

    container.appendChild(fragment);
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

    const note = getActiveNote();

    if (!note) {
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

    const titleInput = document.getElementById('input-note-title');
    const contentAreaInput = document.getElementById('textarea-note-content');

    if (document.activeElement !== titleInput) {
        titleInput.value = note.title || '';
    }
    if (document.activeElement !== contentAreaInput) {
        contentAreaInput.value = note.content || '';
    }

    const folderSelect = document.getElementById('editor-folder-select');
    const foldersSignature = `${note.folder}\u0001${State.folders.join('\u0001')}`;
    if (folderSelect.dataset.signature !== foldersSignature) {
        folderSelect.dataset.signature = foldersSignature;
        folderSelect.innerHTML = '';
        State.folders.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            if (f === note.folder) opt.selected = true;
            folderSelect.appendChild(opt);
        });
    }

    const tagsContainer = document.getElementById('editor-tags-container');
    const readOnly = isReadOnlyNote(note);
    const tags = Array.isArray(note.tags) ? note.tags : [];
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
                // 每次点击都重新取回当前笔记，避免闭包引用已被替换的旧对象
                removeBtn.onclick = () => {
                    const active = getActiveNote();
                    if (!active || !Array.isArray(active.tags)) return;
                    active.tags = active.tags.filter(t => t !== tag);
                    saveIndex();
                    renderApp();
                };
                chip.appendChild(removeBtn);
            }
            tagsContainer.appendChild(chip);
        });
    }

    const pinBtn = document.getElementById('btn-note-pin');
    if (note.isPinned) {
        pinBtn.querySelector('.ms-icon').classList.add('fill');
        pinBtn.style.color = 'var(--accent)';
    } else {
        pinBtn.querySelector('.ms-icon').classList.remove('fill');
        pinBtn.style.color = 'var(--text-secondary)';
    }

    applyEditorReadOnly(note);
    renderMarkdown();
    updateStats();
    updateViewModeUI();
    // 切换笔记后，AI 面板的“附带笔记”提示要跟着变
    updateAiContextHint();
}
