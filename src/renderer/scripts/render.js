const renderSignatures = { tabs: null, list: null };

const LIST_RENDER_CHUNK = 80;

let listRenderToken = 0;

const LIST_ENTER_CLASS = 'list-enter';

const LIST_ENTER_MS = 340;
let listEnterKey = null;
let listEnterTimer = null;

function playListEnter(container) {
    container.classList.add(LIST_ENTER_CLASS);
    if (listEnterTimer) clearTimeout(listEnterTimer);
    listEnterTimer = setTimeout(() => {
        listEnterTimer = null;
        container.classList.remove(LIST_ENTER_CLASS);
    }, LIST_ENTER_MS);
}

const sidebarNavItems = document.querySelectorAll('.sidebar .nav-item');

function renderApp() {
    renderCounts();
    renderTabs();
    renderListPanel();
    renderWorkspace();
    if (typeof refreshFilterPopoverIfOpen === 'function') refreshFilterPopoverIfOpen();
    if (typeof syncMobileNav === 'function') syncMobileNav();
}

function applySidebarCollapsed() {
    const root = document.documentElement;
    root.classList.add(SIDEBAR_COLLAPSED_CLASS);
    const sidebar = document.getElementById('app-sidebar');
    if (sidebar) sidebar.classList.remove('text-fading', 'icons-fading');
}

function panelCategoryTitle(filter) {
    if (filter === 'all') return '全部笔记';
    if (filter === 'todos') return '全部待办';
    if (filter === 'trash') return '废纸篓';
    if (filter.startsWith('folder:')) return filter.replace('folder:', '');
    if (filter.startsWith('tag:')) return '#' + filter.replace('tag:', '');
    return '全部笔记';
}

function renderCounts() {

let activeNoteCount = 0;
    let activeTodoCount = 0;
    let trashedCount = 0;
    State.notes.forEach(note => {
        if (isSecretHidden(note)) return;
        if (note.isTrashed) {
            trashedCount++;
        } else {
            activeNoteCount++;
        }
    });

    State.todos.forEach(todo => {
        if (isSecretHidden(todo)) return;
        if (todo.isTrashed) {
            trashedCount++;
        } else {
            activeTodoCount++;
        }
    });

    document.getElementById('count-all').textContent = activeNoteCount;
    document.getElementById('count-todos').textContent = activeTodoCount;
    document.getElementById('count-trash').textContent = trashedCount;
    document.getElementById('sidebar-stat').textContent = `${activeNoteCount} 篇笔记 · ${activeTodoCount} 项待办`;

    sidebarNavItems.forEach(el => {
        const f = el.getAttribute('data-filter');
        if (f === State.currentFilter) el.classList.add('active');
        else el.classList.remove('active');
    });

const clearBtn = document.getElementById('btn-empty-trash');
    clearBtn.classList.toggle('hidden', State.currentFilter !== 'trash');

    const newBtn = document.getElementById('btn-new-item');
    if (newBtn) newBtn.classList.toggle('hidden', State.currentFilter === 'trash');

    if (typeof syncFilterTriggerState === 'function') syncFilterTriggerState();

    if (typeof syncNewButtonTitles === 'function') syncNewButtonTitles();

    document.getElementById('panel-category-title').textContent = panelCategoryTitle(State.currentFilter);
}

function getAllTags() {
    const tags = new Set();
    [...State.notes, ...State.todos].filter(item => !item.isTrashed && !isSecretHidden(item)).forEach(item => {
        if (Array.isArray(item.tags)) item.tags.forEach(t => { if (t) tags.add(t); });
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

const TAGS_FADE_RIGHT_CLASS = 'tags-fade-right';
const TAGS_FADE_LEFT_CLASS = 'tags-fade-left';

let tagsScrollBound = false;

function updateTagsFade(container) {
    if (!container) return;

    container.classList.toggle(TAGS_FADE_LEFT_CLASS, container.scrollLeft > 1);
    const moreOnRight = container.scrollWidth - container.clientWidth - container.scrollLeft > 1;
    container.classList.toggle(TAGS_FADE_RIGHT_CLASS, moreOnRight);
}

function bindTagsScroll(container) {
    if (!container || tagsScrollBound) return;
    tagsScrollBound = true;

container.addEventListener('wheel', (e) => {
        if (container.scrollWidth <= container.clientWidth) return;
        e.preventDefault();
        container.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
    }, { passive: false });

    container.addEventListener('scroll', () => updateTagsFade(container), { passive: true });

    new ResizeObserver(() => updateTagsFade(container)).observe(container);
}

const TAB_CONTAINER_IDS = ['titlebar-tabs', 'workspace-tabs'];

function tabsContainerId() {
    return 'workspace-tabs';
}

function renderedTabIds() {
    const ids = new Set();
    TAB_CONTAINER_IDS.forEach(containerId => {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll('.tab-item').forEach(el => {
            if (el.dataset.tabId) ids.add(el.dataset.tabId);
        });
    });
    return ids;
}

const TABS_FADE_RIGHT_CLASS = 'tabs-fade-right';
const TABS_FADE_LEFT_CLASS = 'tabs-fade-left';

const TAB_SLIDE_IN_CLASS = 'is-sliding-in';

const tabsFadeObserved = new WeakSet();

function updateTabsFade(container) {
    if (!container) return;

    container.classList.toggle(TABS_FADE_LEFT_CLASS, container.scrollLeft > 1);
    const moreOnRight = container.scrollWidth - container.clientWidth - container.scrollLeft > 1;
    container.classList.toggle(TABS_FADE_RIGHT_CLASS, moreOnRight);
}

function bindTabsFade(container) {
    if (!container || tabsFadeObserved.has(container)) return;
    tabsFadeObserved.add(container);

    container.addEventListener('scroll', () => updateTabsFade(container));

new ResizeObserver(() => updateTabsFade(container)).observe(container);
}

function renderTabs() {
    const tabsContainer = document.getElementById(tabsContainerId());

if (!tabsContainer.onwheel) {
        tabsContainer.onwheel = (e) => {
            if (tabsContainer.scrollWidth > tabsContainer.clientWidth) {
                e.preventDefault();
                tabsContainer.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
            }
        };
    }

bindTabsFade(tabsContainer);

State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || !!getItemById(id));

const signature = `${State.activeNoteId}\u0001${State.openNoteIds.map(id => {
        const item = id === 'settings' ? null : getItemById(id);
        // 加密状态（含本轮是否已解锁）跟着进签名：上锁 / 解锁后标题没变，图标也要换
        const secret = item && item.locked === true ? (item.unlocked === true ? 2 : 1) : 0;
        return `${id}\u0002${item ? (item.title || '') : ''}\u0002${secret}`;
    }).join('\u0001')}`;
    if (renderSignatures.tabs === signature) return;
    renderSignatures.tabs = signature;

if (tabsDrag) stopTabsDrag();

const knownTabIds = renderedTabIds();

    let openedTab = false;

    tabsContainer.innerHTML = '';

    State.openNoteIds.forEach(id => {
        const isActive = id === State.activeNoteId;
        const tab = document.createElement('div');
        tab.className = `tab-item ${isActive ? 'active' : ''}`;

        tab.dataset.tabId = id;

if (!knownTabIds.has(id)) {
            tab.classList.add(TAB_SLIDE_IN_CLASS);
            openedTab = true;
        }

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

            const icon = isTodoItem(item) ? 'check_box' : 'description';
            const secretIcon = item.locked === true
                ? `<span class="ms-icon xs" style="opacity: 0.7;">${item.unlocked === true ? 'lock_open' : 'lock'}</span>`
                : '';
            tab.innerHTML = `
                <span class="ms-icon xs" style="opacity: 0.7;">${icon}</span>
                ${secretIcon}
                <span class="tab-title">${escapeHTML(itemDisplayTitle(item))}</span>
                <button class="tab-close-btn" title="关闭标签">
                    <span class="ms-icon xs">close</span>
                </button>
            `;
        }

        tab.addEventListener('click', (e) => {
            if (e.target.closest('.tab-close-btn')) return;

if (tabsDragSwallowClick) {
                tabsDragSwallowClick = false;
                return;
            }
            State.activeNoteId = id;
            renderApp();
        });

tab.addEventListener('pointerdown', (event) => {

            if (event.button !== 0) return;
            if (event.target.closest('.tab-close-btn')) return;
            startTabsDrag(event, tab);
        });

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

    applyTabCloseShift(openedTab);

    updateTabsFade(tabsContainer);
}

const TAB_FLY_DURATION_MS = 260;
const TAB_SHIFT_DURATION_MS = 180;

const TAB_ANIM_SLACK_MS = 140;

const TAB_FLY_OVERSHOOT = 12;

const TAB_FLY_UP_CLASS = 'is-flying-up';
const TAB_FLY_LEFT_CLASS = 'is-flying-left';

let tabCloseShift = null;

function playTabCloseFlyAway(tabId) {
    const tabsContainer = document.getElementById(tabsContainerId());
    if (!tabsContainer) return;

    const tabs = Array.from(tabsContainer.children);
    const tab = tabs.find(el => el.dataset.tabId === tabId);
    if (!tab) return;

    const isOnlyTab = tabs.length === 1;

const rect = tab.getBoundingClientRect();
    const lefts = new Map(tabs.filter(el => el.dataset.tabId)
        .map(el => [el.dataset.tabId, el.getBoundingClientRect().left]));

    const ghost = tab.cloneNode(true);

ghost.classList.remove(TAB_SLIDE_IN_CLASS);

tab.remove();

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    if (!rect.width || !rect.height) return;

tabCloseShift = { at: performance.now(), lefts };

    ghost.classList.add(isOnlyTab ? TAB_FLY_LEFT_CLASS : TAB_FLY_UP_CLASS);

    const barRect = isOnlyTab ? tabsContainer.getBoundingClientRect() : { left: 0, top: 0 };
    const clip = isOnlyTab ? buildTabFlyClip(barRect) : null;
    const originLeft = rect.left - barRect.left;
    const originTop = rect.top - barRect.top;
    ghost.style.left = `${originLeft}px`;
    ghost.style.top = `${originTop}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    if (isOnlyTab) {

        ghost.style.setProperty('--tab-slide-distance', `${rect.width}px`);
    } else {

ghost.style.setProperty('--tab-fly-distance', `${rect.top + rect.height + TAB_FLY_OVERSHOOT}px`);
    }
    (clip || document.body).appendChild(ghost);

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;

        (clip || ghost).remove();
    };
    ghost.addEventListener('animationend', dismiss, { once: true });
    setTimeout(dismiss, TAB_FLY_DURATION_MS + TAB_ANIM_SLACK_MS);
}

function buildTabFlyClip(barRect) {
    const clip = document.createElement('div');
    clip.className = 'tab-fly-clip';
    clip.style.left = `${barRect.left}px`;
    clip.style.top = `${barRect.top}px`;
    clip.style.width = `${barRect.width}px`;
    clip.style.height = `${barRect.height}px`;
    document.body.appendChild(clip);
    return clip;
}

function applyTabCloseShift(hasNewTab) {
    const shift = tabCloseShift;
    tabCloseShift = null;
    if (!shift) return;

if (hasNewTab) return;

if (performance.now() - shift.at > 250) return;

    const tabsContainer = document.getElementById(tabsContainerId());
    if (!tabsContainer) return;

const easing = tabShiftEasing();
    const shifts = [];
    tabsContainer.querySelectorAll('.tab-item').forEach(el => {
        const from = shift.lefts.get(el.dataset.tabId);
        if (from === undefined) return;
        const distance = from - el.getBoundingClientRect().left;

if (distance < 1) return;
        shifts.push(el.animate(
            [{ transform: `translateX(${distance}px)` }, { transform: 'translateX(0)' }],
            {
                duration: TAB_SHIFT_DURATION_MS,

delay: TAB_FLY_DURATION_MS,
                easing,
                fill: 'both'
            }
        ));
    });
    if (!shifts.length) return;

let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        shifts.forEach(shiftAnim => {
            shiftAnim.onfinish = null;
            shiftAnim.cancel();
        });

        if (tabsContainer.isConnected) updateTabsFade(tabsContainer);
    };
    shifts.forEach(shiftAnim => { shiftAnim.onfinish = settle; });

    setTimeout(settle, TAB_FLY_DURATION_MS + TAB_SHIFT_DURATION_MS + TAB_ANIM_SLACK_MS);
}

function tabShiftEasing() {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim();
    return /^cubic-bezier\(/.test(value) ? value : 'cubic-bezier(0.22, 0.61, 0.36, 1)';
}

const TAB_DRAG_THRESHOLD = 4;

const TAB_DRAG_EDGE = 28;

const TAB_DRAG_SCROLL_STEP = 8;

let tabsDrag = null;

let tabsDragFrame = 0;

let tabsDragSwallowClick = false;

function startTabsDrag(event, tab) {
    if (tabsDrag) return;
    const container = tab.parentElement;
    if (!container) return;
    tabsDragSwallowClick = false;

    const rect = tab.getBoundingClientRect();
    tabsDrag = {
        tab,
        container,

        grabOffset: event.clientX - rect.left,
        startX: event.clientX,
        startY: event.clientY,
        pointerX: event.clientX,
        moved: false,

        edgeDir: 0
    };

    window.addEventListener('pointermove', onTabsDragMove);
    window.addEventListener('pointerup', onTabsDragEnd);
    window.addEventListener('pointercancel', onTabsDragCancel);

    window.addEventListener('blur', onTabsDragCancel);
}

function onTabsDragMove(event) {
    if (!tabsDrag) return;

    if (!tabsDrag.moved) {
        const dx = event.clientX - tabsDrag.startX;
        const dy = event.clientY - tabsDrag.startY;
        if (Math.abs(dx) < TAB_DRAG_THRESHOLD && Math.abs(dy) < TAB_DRAG_THRESHOLD) return;
        tabsDrag.moved = true;
        tabsDrag.tab.classList.add('is-dragging');

        tabsDrag.container.classList.add('is-dragging');
    }
    event.preventDefault();
    tabsDrag.pointerX = event.clientX;

    updateTabsAutoScroll();
    moveDraggedTab();
    placeDraggedTab();
}

function updateTabsAutoScroll() {
    const { container, pointerX } = tabsDrag;
    const rect = container.getBoundingClientRect();
    const maxScroll = container.scrollWidth - container.clientWidth;

    let dir = 0;
    if (pointerX < rect.left + TAB_DRAG_EDGE && container.scrollLeft > 0) dir = -1;
    else if (pointerX > rect.right - TAB_DRAG_EDGE && container.scrollLeft < maxScroll - 1) dir = 1;
    if (dir === tabsDrag.edgeDir) return;
    tabsDrag.edgeDir = dir;
    if (dir) scheduleTabsAutoScroll();
}

function scheduleTabsAutoScroll() {
    if (tabsDragFrame) return;
    tabsDragFrame = requestAnimationFrame(() => {
        tabsDragFrame = 0;
        if (!tabsDrag || !tabsDrag.edgeDir) return;
        tabsDrag.container.scrollLeft += tabsDrag.edgeDir * TAB_DRAG_SCROLL_STEP;
        moveDraggedTab();
        placeDraggedTab();

        updateTabsAutoScroll();
        if (tabsDrag && tabsDrag.edgeDir) scheduleTabsAutoScroll();
    });
}

function moveDraggedTab() {
    const { container, tab, pointerX } = tabsDrag;
    const others = Array.from(container.querySelectorAll('.tab-item')).filter(el => el !== tab);
    const next = others.find(el => {
        const rect = el.getBoundingClientRect();
        return pointerX < rect.left + rect.width / 2;
    });

    if (next) {
        if (next.previousElementSibling !== tab) container.insertBefore(tab, next);
        return;
    }
    if (container.lastElementChild !== tab) container.appendChild(tab);
}

function placeDraggedTab() {
    const { tab, pointerX, grabOffset } = tabsDrag;
    tab.style.transform = '';
    const layoutLeft = tab.getBoundingClientRect().left;
    tab.style.transform = `translateX(${pointerX - grabOffset - layoutLeft}px)`;
}

function onTabsDragEnd() {
    if (!tabsDrag) return;
    const { container, moved } = tabsDrag;
    if (!moved) {

        stopTabsDrag();
        return;
    }

State.openNoteIds = Array.from(container.querySelectorAll('.tab-item'))
        .map(el => el.dataset.tabId)
        .filter(id => id);
    tabsDragSwallowClick = true;
    stopTabsDrag();

    forceRenderTabs();
}

function onTabsDragCancel() {
    if (!tabsDrag) return;
    stopTabsDrag();
    forceRenderTabs();
}

function stopTabsDrag() {
    if (!tabsDrag) return;
    window.removeEventListener('pointermove', onTabsDragMove);
    window.removeEventListener('pointerup', onTabsDragEnd);
    window.removeEventListener('pointercancel', onTabsDragCancel);
    window.removeEventListener('blur', onTabsDragCancel);
    if (tabsDragFrame) {
        cancelAnimationFrame(tabsDragFrame);
        tabsDragFrame = 0;
    }
    tabsDrag.tab.classList.remove('is-dragging');
    tabsDrag.tab.style.transform = '';
    tabsDrag.container.classList.remove('is-dragging');
    tabsDrag = null;
}

function forceRenderTabs() {
    renderSignatures.tabs = null;
    renderTabs();
}

const PREVIEW_MAX_LENGTH = 120;

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

function buildNotePreviewText(raw) {
    const length = raw.length;

let start = 0;
    while (start < length && isPreviewWhitespace(raw.charCodeAt(start))) start++;
    if (start >= length) return '暂无内容';

const lineBreak = raw.indexOf('\n', start);
    let end = lineBreak === -1 ? length : lineBreak;
    while (end > start && isPreviewWhitespace(raw.charCodeAt(end - 1))) end--;

    const firstLine = raw.slice(start, end);
    return firstLine.length > PREVIEW_MAX_LENGTH ? firstLine.slice(0, PREVIEW_MAX_LENGTH) : firstLine;
}

const PREVIEW_TEXT_CACHE = new WeakMap();

function notePreviewText(item) {

    if (isSecretLocked(item)) return '已加密的正文';

    const raw = typeof item.content === 'string' ? item.content : '';
    const cached = PREVIEW_TEXT_CACHE.get(item);
    if (cached && cached.source === raw) return cached.text;

    const text = buildNotePreviewText(raw);
    PREVIEW_TEXT_CACHE.set(item, { source: raw, text });
    return text;
}

function searchPlaceholderText(filter) {
    if (filter === 'all') return '搜索笔记... (Ctrl+K)';
    if (filter === 'todos') return '搜索待办... (Ctrl+K)';
    return '搜索笔记与待办... (Ctrl+K)';
}

function renderListPanel() {
    const container = document.getElementById('notes-list-box');
    const list = getFilteredItems();
    const isTrashView = State.currentFilter === 'trash';

    const searchInput = document.getElementById('input-search');
    const placeholder = searchPlaceholderText(State.currentFilter);
    if (searchInput.placeholder !== placeholder) searchInput.placeholder = placeholder;

const signature = `${State.currentFilter}\u0001${State.searchQuery}\u0002${State.sortBy}\u0003${State.activeNoteId}\u0004`
        + list.map(item => `${item.id}\u0005${isTodoItem(item) ? 1 : 0}\u0005${isSharedItem(item) ? 1 : 0}\u0005${item.title || ''}\u0005${formatDate(item.updatedAt)}\u0005${item.folder}\u0005${item.isPinned ? 1 : 0}\u0005${item.isDone ? 1 : 0}\u0005${notePreviewText(item)}`).join('\u0006');
    if (renderSignatures.list === signature) return;
    renderSignatures.list = signature;

const enterKey = `${State.currentFilter}\u0001${State.searchQuery}\u0002${State.sortBy}`;
    if (enterKey !== listEnterKey) {
        listEnterKey = enterKey;
        playListEnter(container);
    }

const token = ++listRenderToken;
    container.innerHTML = '';

    if (list.length === 0) {

        const keyword = State.searchQuery.trim();
        const hint = keyword
            ? `当前视图内没有包含「${escapeHTML(keyword)}」的笔记或待办`
            : '无匹配内容';
        container.innerHTML = `
            <div style="text-align: center; padding: 32px 10px; color: var(--text-muted); font-size: 12px;">
                ${hint}
            </div>
        `;
        return;
    }

let next = 0;
    const appendChunk = () => {

if (token !== listRenderToken) return;

        const end = Math.min(next + LIST_RENDER_CHUNK, list.length);

        const fragment = document.createDocumentFragment();
        for (; next < end; next++) {
            const item = list[next];
            fragment.appendChild(isTodoItem(item) ? createTodoCard(item, { isTrashView }) : createNoteCard(item));
        }
        container.appendChild(fragment);

        if (next >= list.length) return;

        if (document.hidden) setTimeout(appendChunk, 0);
        else requestAnimationFrame(appendChunk);
    };
    appendChunk();
}

function createNoteCard(note) {
    const card = document.createElement('div');
    card.className = `note-card ${note.id === State.activeNoteId ? 'active' : ''}`;
    card.innerHTML = `
        <div class="note-card-title">
            <span>${escapeHTML(note.title || '未命名笔记')}</span>
            ${isSharedItem(note) ? `<span class="ms-icon xs" title="来自账户 ${escapeHTML(note.shared.owner)} 的共享笔记">group</span>` : ''}
            ${note.locked === true ? `<span class="ms-icon xs fill" style="color: var(--accent);">${note.unlocked === true ? 'lock_open' : 'lock'}</span>` : ''}
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
    const editorBody = document.querySelector('.editor-body');

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
        syncSyncServerSettingsUI();

if (typeof refreshTeamNotesSoon === 'function') refreshTeamNotesSoon();
        syncUiModeUI();
        syncUpdateSettingsUI();
        applyAiPanelVisibility();
        applyFileManagerVisibility();

syncVoiceEntry(null);
        syncVoiceSettingsUI();

        syncSecretSettingsUI();

        if (typeof updateNarrowLayout === 'function') updateNarrowLayout();
        return;
    }

    if (sidebar) sidebar.classList.remove('hidden');
    if (notesPanel) notesPanel.classList.remove('hidden');
    if (workspace) workspace.classList.remove('hidden');
    if (settingsView) settingsView.classList.add('hidden');
    if (editorBody) editorBody.classList.remove('hidden');
    applyAiPanelVisibility();
    applyFileManagerVisibility();

    const item = getActiveItem();

    if (!item) {
        emptyState.classList.remove('hidden');
        topbar.classList.add('hidden');
        toolbar.classList.add('hidden');
        titleArea.classList.add('hidden');
        contentArea.classList.add('hidden');
        footer.classList.add('hidden');
        updateAiScopeOptions();

        syncVoiceEntry(null);
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

        contentAreaInput.value = isSecretLocked(item) ? '' : (item.content || '');
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
            folderSelect.appendChild(opt);
        });

        folderSelect.value = item.folder;

        if (folderSelect.selectedIndex < 0 && folderSelect.options.length) folderSelect.selectedIndex = 0;
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

            if (!readOnly) {
                const removeBtn = document.createElement('button');
                removeBtn.title = '移除标签';
                removeBtn.innerHTML = '<span class="ms-icon xs">close</span>';

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

        updateTagsFade(tagsContainer);
    }

    bindTagsScroll(tagsContainer);

const doneBtn = document.getElementById('btn-todo-done');
    doneBtn.classList.toggle('hidden', !todoItem);
    if (todoItem) {
        doneBtn.querySelector('.ms-icon').textContent = item.isDone ? 'check_circle' : 'radio_button_unchecked';
        doneBtn.style.color = item.isDone ? 'var(--accent)' : 'var(--text-secondary)';
        doneBtn.title = item.isDone ? '标记为未完成' : '标记为已完成';
        doneBtn.disabled = readOnly;
    }

    applyEditorReadOnly(item);

    applySecretLockUI(item);
    renderMarkdown();
    updateStats();
    updateViewModeUI();

    syncVoiceEntry(item);

    updateAiScopeOptions();

    if (State.fmPanelOpen) renderFileManager();

    if (typeof updateNarrowLayout === 'function') updateNarrowLayout();
}
