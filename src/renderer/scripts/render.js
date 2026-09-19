/* 界面渲染：侧边栏、标签页、笔记列表与工作区 */

// UI Rendering
function renderApp() {
    renderCounts();
    renderFolders();
    renderTags();
    renderTabs();
    renderNotesList();
    renderWorkspace();
}

function renderCounts() {
    const activeNotes = State.notes.filter(n => !n.isTrashed);
    document.getElementById('count-all').textContent = activeNotes.length;
    document.getElementById('count-pinned').textContent = activeNotes.filter(n => n.isPinned).length;
    document.getElementById('count-trash').textContent = State.notes.filter(n => n.isTrashed).length;
    document.getElementById('sidebar-stat').textContent = `共 ${activeNotes.length} 篇笔记`;

    document.querySelectorAll('.sidebar .nav-item').forEach(el => {
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
    const container = document.getElementById('sidebar-folder-list');
    container.innerHTML = '';

    State.folders.forEach(folder => {
        const isSelected = State.currentFilter === `folder:${folder}`;
        const item = document.createElement('div');
        item.className = `nav-item folder-item ${isSelected ? 'active' : ''}`;
        item.innerHTML = `
            <div class="nav-item-left">
                <span class="ms-icon sm">folder</span>
                <span>${escapeHTML(folder)}</span>
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
    const container = document.getElementById('sidebar-tag-list');
    container.innerHTML = '';

    const tagSet = new Set();
    State.notes.filter(n => !n.isTrashed).forEach(n => {
        if (n.tags) n.tags.forEach(t => tagSet.add(t));
    });

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
    tabsContainer.innerHTML = '';

    State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || State.notes.some(n => n.id === id));

    tabsContainer.onwheel = (e) => {
        if (tabsContainer.scrollWidth > tabsContainer.clientWidth) {
            e.preventDefault();
            tabsContainer.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
        }
    };

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

function renderNotesList() {
    const container = document.getElementById('notes-list-box');
    container.innerHTML = '';
    const list = getFilteredNotes();

    if (list.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 32px 10px; color: var(--text-muted); font-size: 12px;">
                无匹配笔记
            </div>
        `;
        return;
    }

    list.forEach(note => {
        const card = document.createElement('div');
        const isActive = note.id === State.activeNoteId;
        card.className = `note-card ${isActive ? 'active' : ''}`;
        card.innerHTML = `
            <div class="note-card-title">
                <span>${escapeHTML(note.title || '未命名笔记')}</span>
                ${note.isPinned ? '<span class="ms-icon xs fill" style="color: var(--accent);">push_pin</span>' : ''}
            </div>
            <div class="note-card-preview">${escapeHTML(note.content || '暂无内容')}</div>
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

        container.appendChild(card);
    });
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
        return;
    }

    if (sidebar) sidebar.classList.remove('hidden');
    if (notesPanel) notesPanel.classList.remove('hidden');
    if (workspace) workspace.classList.remove('hidden');
    if (settingsView) settingsView.classList.add('hidden');

    const note = getActiveNote();

    if (!note) {
        emptyState.classList.remove('hidden');
        topbar.classList.add('hidden');
        toolbar.classList.add('hidden');
        titleArea.classList.add('hidden');
        contentArea.classList.add('hidden');
        footer.classList.add('hidden');
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
    folderSelect.innerHTML = '';
    State.folders.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        if (f === note.folder) opt.selected = true;
        folderSelect.appendChild(opt);
    });

    const tagsContainer = document.getElementById('editor-tags-container');
    const readOnly = isReadOnlyNote(note);
    tagsContainer.innerHTML = '';
    if (note.tags) {
        note.tags.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'editor-tag-chip';
            chip.innerHTML = `<span>#${escapeHTML(tag)}</span>`;
            // 只读时不提供“移除标签”入口
            if (!readOnly) {
                const removeBtn = document.createElement('button');
                removeBtn.title = '移除标签';
                removeBtn.innerHTML = '<span class="ms-icon xs">close</span>';
                removeBtn.onclick = () => {
                    note.tags = note.tags.filter(t => t !== tag);
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
    flushRenderMarkdown();
    updateStats();
    updateViewModeUI();
}
