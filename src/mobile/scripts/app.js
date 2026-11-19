import { renderMarkdown } from './markdown.js';
import {
    buildItem, displayTitle, itemIdFromPath, snippet, serializeItem, formatRelative, byteLength, formatBytes
} from './format.js';
import {
    listRecords, readSettings, writeSettings, writeText, removeFile, clearFiles, storageBackendName
} from './store.js';
import {
    initSync, loginWithAccount, syncNow, syncConfigured, isSyncing
} from './sync.js';

const $ = (id) => document.getElementById(id);

const app = $('app');
const paneList = $('pane-list');
const paneEditor = $('pane-editor');
const paneSettings = $('pane-settings');

const btnSync = $('btn-sync');
const btnMenu = $('btn-menu');
const menuScrim = $('menu-scrim');
const menuPop = $('menu-pop');
const menuTheme = $('menu-theme');
const menuSort = $('menu-sort');
const menuFilter = $('menu-filter');
const menuSettings = $('menu-settings');
const btnSearch = $('btn-search');
const searchOverlay = $('search-overlay');
const btnSearchBack = $('btn-search-back');
const searchInput = $('search-input');
const btnSearchClear = $('btn-search-clear');
const searchHint = $('search-hint');
const searchSummary = $('search-summary');
const searchCards = $('search-cards');
const searchEmpty = $('search-empty');
const searchEmptyText = $('search-empty-text');
const btnCompose = $('btn-compose');
const composeEl = $('compose');
const btnNewNote = $('btn-new-note');
const btnNewTodo = $('btn-new-todo');
const tabbar = $('tabbar');
const filterLabel = $('filter-label');
const listScroll = $('list-scroll');
const cards = $('cards');
const listEmpty = $('list-empty');
const listEmptyIcon = $('list-empty-icon');
const listEmptyTitle = $('list-empty-title');
const listEmptyText = $('list-empty-text');

const btnEditorBack = $('btn-editor-back');
const editorKindIcon = $('editor-kind-icon');
const editorKind = $('editor-kind');
const editorSaved = $('editor-saved');
const btnEditorPin = $('btn-editor-pin');
const btnEditorTag = $('btn-editor-tag');
const btnEditorMore = $('btn-editor-more');
const editorEmpty = $('editor-empty');
const editorMeta = $('editor-meta');
const editorScroll = $('editor-scroll');
const editorTitle = $('editor-title');
const editorBody = $('editor-body');
const editorPreview = $('editor-preview');
const editorFoot = $('editor-foot');
const btnEditorMode = $('btn-editor-mode');
const editorModeIcon = $('editor-mode-icon');
const editorModeLabel = $('editor-mode-label');
const btnEditorFolder = $('btn-editor-folder');
const editorFolderLabel = $('editor-folder-label');
const editorStats = $('editor-stats');

const btnSettingsBack = $('btn-settings-back');
const settingsNav = $('settings-nav');
const settingsScroll = $('settings-scroll');
const settingsTitleIcon = $('settings-title-icon');
const settingsTitle = $('settings-title');
const settingsDesc = $('settings-desc');
const themeSegmented = $('theme-segmented');
const sortSegmented = $('sort-segmented');
const syncUrlInput = $('sync-url');
const syncAccountInput = $('sync-account');
const syncPasswordInput = $('sync-password');
const btnSyncLogin = $('btn-sync-login');
const btnSyncNow = $('btn-sync-now');
const syncStatus = $('sync-status');
const btnSyncLogout = $('btn-sync-logout');
const statNotes = $('stat-notes');
const statTodos = $('stat-todos');
const statTrash = $('stat-trash');
const statSize = $('stat-size');
const statBackend = $('stat-backend');
const btnClearLocal = $('btn-clear-local');

const sheetMask = $('sheet-mask');
const sheet = $('sheet');
const sheetTitle = $('sheet-title');
const sheetBody = $('sheet-body');
const toastEl = $('toast');

const SETTINGS_SECTIONS = ['appearance', 'sync', 'data', 'about'];

const SETTINGS_META = {
    appearance: { icon: 'palette', label: '外观', desc: '主题与排序' },
    sync: { icon: 'sync', label: '同步', desc: '服务器地址、账户与本机令牌' },
    data: { icon: 'storage', label: '数据', desc: '本机占用与清空' },
    about: { icon: 'info', label: '关于', desc: '与桌面端共用的数据格式' }
};

const state = {
    items: [],
    settings: null,
    pane: 'list',
    filter: 'notes',
    folder: '',
    tag: '',
    query: '',
    activeId: '',
    draft: null,
    dirty: false,
    preview: false,
    settingsSection: 'appearance'
};

let saveTimer = 0;
let toastTimer = 0;
let sheetToken = 0;

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toast(message) {
    if (!message) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('open'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastEl.classList.remove('open');
        setTimeout(() => { toastEl.hidden = true; }, 180);
    }, 2400);
}

function isWide() {
    return window.matchMedia('(min-width: 860px)').matches;
}

function cloneItem(item) {
    return {
        ...item,
        tags: [...item.tags],
        unknownMeta: item.unknownMeta.map((entry) => [...entry])
    };
}

function normalizeUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '').replace(/\/sync$/i, '');
}

function openSheet({ title, html, mount }) {
    sheetToken += 1;
    const token = sheetToken;
    sheetTitle.textContent = title || '';
    sheetBody.innerHTML = html || '';
    sheet.hidden = false;
    sheetMask.hidden = false;
    requestAnimationFrame(() => {
        if (token !== sheetToken) return;
        sheet.classList.add('open');
        sheetMask.classList.add('open');
    });
    if (typeof mount === 'function') mount(sheetBody);
    return token;
}

function closeSheet() {
    if (sheet.hidden) return;
    sheetToken += 1;
    sheet.classList.remove('open');
    sheetMask.classList.remove('open');
    setTimeout(() => {
        if (sheet.classList.contains('open')) return;
        sheet.hidden = true;
        sheetMask.hidden = true;
        sheetBody.innerHTML = '';
    }, 220);
}

function confirmSheet({ title, message, confirmText = '确认', danger = false, onConfirm }) {
    openSheet({
        title,
        html: `
            <p class="sheet-note">${esc(message)}</p>
            <button class="sheet-item ${danger ? 'danger' : ''}" data-confirm="yes">
                <span class="ms-icon ms-s18">${danger ? 'delete' : 'check'}</span>
                <span>${esc(confirmText)}</span>
            </button>
            <button class="sheet-item" data-confirm="no">
                <span class="ms-icon ms-s18">close</span>
                <span>取消</span>
            </button>
        `,
        mount(root) {
            root.addEventListener('click', (event) => {
                const button = event.target.closest('[data-confirm]');
                if (!button) return;
                const accepted = button.dataset.confirm === 'yes';
                closeSheet();
                if (accepted) onConfirm();
            });
        }
    });
}

const themeQuery = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme(mode) {
    const resolved = mode === 'system' ? (themeQuery.matches ? 'light' : 'dark') : mode;
    const isLight = resolved === 'light';
    document.documentElement.classList.toggle('light', isLight);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isLight ? '#f6f8fa' : '#161b22');
    themeSegmented.querySelectorAll('[data-theme]').forEach((button) => {
        button.classList.toggle('active', button.dataset.theme === (mode || 'system'));
    });
}

themeQuery.addEventListener('change', () => {
    if (state.settings && state.settings.theme === 'system') applyTheme('system');
});

async function loadItems() {
    const records = await listRecords();
    const items = [];
    for (const [path, record] of records) {
        if (!record || record.enc !== 'utf8') continue;
        const id = itemIdFromPath(path);
        if (!id) continue;
        try {
            items.push(buildItem({ id, path, raw: record.data, time: record.time }));
        } catch (err) {
            console.warn('[Nemo] 条目解析失败：', path, err && err.message);
        }
    }
    state.items = items;
}

function sortValue() {
    return (state.settings && state.settings.sortBy) || 'updated-desc';
}

function visibleItems(query = '') {
    const needle = query.trim().toLowerCase();

    const list = state.items.filter((item) => {
        if (state.filter === 'trash') {
            if (!item.isTrashed) return false;
        } else {
            if (item.isTrashed || item.isHidden) return false;
            if (state.filter === 'notes' && item.type !== 'note') return false;
            if (state.filter === 'todos' && item.type !== 'todo') return false;
            if (state.filter === 'pinned' && !item.isPinned) return false;
        }
        if (state.folder && item.folder !== state.folder) return false;
        if (state.tag && !item.tags.includes(state.tag)) return false;
        if (needle) {
            const haystack = `${item.title}\n${item.content}\n${item.tags.join(' ')}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        return true;
    });

    const by = sortValue();
    return list.sort((a, b) => {
        if (state.filter !== 'trash') {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
        }
        if (by === 'created-desc') return b.createdAt - a.createdAt;
        if (by === 'title-asc') return displayTitle(a).localeCompare(displayTitle(b), 'zh-CN');
        return b.updatedAt - a.updatedAt;
    });
}

function uniqueFolders() {
    const folders = [];
    state.items.forEach((item) => {
        if (item.isTrashed || !item.folder) return;
        if (!folders.includes(item.folder)) folders.push(item.folder);
    });
    return folders.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function allTags() {
    const tags = [];
    state.items.forEach((item) => {
        if (item.isTrashed) return;
        item.tags.forEach((tag) => {
            if (!tags.includes(tag)) tags.push(tag);
        });
    });
    return tags.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function renderTabbar() {
    tabbar.querySelectorAll('[data-filter]').forEach((tab) => {
        tab.classList.toggle('active', state.filter === tab.dataset.filter);
    });

    const narrowed = state.folder || state.tag;
    filterLabel.textContent = narrowed
        ? [state.folder, state.tag ? `#${state.tag}` : ''].filter(Boolean).join(' · ')
        : '筛选';
    menuFilter.classList.toggle('active', !!narrowed);
}

function setSearchOpen(open) {
    const next = !!open;
    searchOverlay.hidden = !next;
    app.classList.toggle('searching', next);
    if (next) {
        renderSearch();
        setTimeout(() => searchInput.focus(), 80);
    } else {
        searchInput.value = '';
        state.query = '';
        btnSearchClear.hidden = true;
        searchCards.innerHTML = '';
        searchEmpty.hidden = true;
        searchSummary.hidden = true;
        searchHint.hidden = false;
    }
}

function clearSearch() {
    if (!state.query && !searchInput.value) return;
    searchInput.value = '';
    state.query = '';
    btnSearchClear.hidden = true;
    renderSearch();
}

function renderSearch() {
    const query = state.query.trim();
    const hasQuery = !!query;

    searchHint.hidden = hasQuery;
    searchSummary.hidden = !hasQuery;
    btnSearchClear.hidden = !state.query;

    if (!hasQuery) {
        searchCards.innerHTML = '';
        searchEmpty.hidden = true;
        searchSummary.textContent = '';
        return;
    }

    const list = visibleItems(query);
    searchSummary.textContent = `找到 ${list.length} 条结果`;
    searchEmpty.hidden = !!list.length;
    searchEmptyText.textContent = `没有匹配「${query}」的标题、正文或标签`;
    searchCards.innerHTML = list.map(cardHtml).join('');
}

function openSettings(section) {
    hydrateSettingsForm();
    selectSettingsSection(section || state.settingsSection);
    showPane('settings');
    renderDataStats();
}

function selectSettingsSection(name) {
    const section = SETTINGS_SECTIONS.includes(name) ? name : SETTINGS_SECTIONS[0];
    state.settingsSection = section;
    const meta = SETTINGS_META[section] || SETTINGS_META[SETTINGS_SECTIONS[0]];
    settingsTitleIcon.textContent = meta.icon;
    settingsTitle.textContent = meta.label;
    settingsDesc.textContent = meta.desc;
    settingsNav.querySelectorAll('[data-section]').forEach((button) => {
        button.classList.toggle('active', button.dataset.section === section);
    });
    settingsScroll.querySelectorAll('.settings-section').forEach((block) => {
        block.hidden = block.dataset.section !== section;
    });
    settingsScroll.scrollTop = 0;
}

function placeMenu() {
    const rect = btnMenu.getBoundingClientRect();
    menuPop.style.top = `${Math.round(rect.bottom + 4)}px`;
    menuPop.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
}

function openMenu() {
    menuPop.hidden = false;
    menuScrim.hidden = false;
    btnMenu.setAttribute('aria-expanded', 'true');
    placeMenu();
    syncMenuTheme();
    syncMenuSort();
}

function closeMenu() {
    if (menuPop.hidden) return;
    menuPop.hidden = true;
    menuScrim.hidden = true;
    btnMenu.setAttribute('aria-expanded', 'false');
}

function toggleMenu() {
    if (menuPop.hidden) openMenu();
    else closeMenu();
}

function syncMenuTheme() {
    const mode = (state.settings && state.settings.theme) || 'system';
    menuTheme.querySelectorAll('[data-theme]').forEach((button) => {
        button.classList.toggle('active', button.dataset.theme === mode);
    });
}

function syncMenuSort() {
    const by = sortValue();
    menuSort.querySelectorAll('[data-sort]').forEach((button) => {
        button.classList.toggle('active', button.dataset.sort === by);
    });
    sortSegmented.querySelectorAll('[data-sort]').forEach((button) => {
        button.classList.toggle('active', button.dataset.sort === by);
    });
}

async function setSort(by) {
    state.settings.sortBy = by;
    syncMenuSort();
    renderList();
    await writeSettings(state.settings);
}

async function setTheme(mode) {
    state.settings.theme = mode;
    applyTheme(mode);
    syncMenuTheme();
    await writeSettings(state.settings);
}

async function toggleTheme() {
    const light = document.documentElement.classList.contains('light');
    await setTheme(light ? 'dark' : 'light');
}

function openFilterSheet() {
    const folders = uniqueFolders();
    const tags = allTags();

    const folderRows = [{ name: '', label: '全部文件夹' }].concat(
        folders.map((name) => ({ name, label: name }))
    );

    openSheet({
        title: '筛选',
        html: `
            <div class="sheet-section">
                <span class="sheet-section-title">文件夹</span>
                ${folderRows.map((row, index) => `
                    <button class="sheet-item${(state.folder || '') === row.name ? ' selected' : ''}" data-folder-row="${index}">
                        <span class="ms-icon ms-s18">${row.name ? 'folder' : 'folder_open'}</span>
                        <span>${esc(row.label)}</span>
                        ${(state.folder || '') === row.name ? '<span class="ms-icon ms-s16 sheet-check">check</span>' : ''}
                    </button>
                `).join('')}
            </div>
            ${tags.length ? `
                <div class="sheet-section">
                    <span class="sheet-section-title">标签</span>
                    <div class="sheet-chips">
                        ${tags.map((tag) => `
                            <button class="chip${state.tag === tag ? ' accent' : ''}" type="button" data-tag="${esc(tag)}">#${esc(tag)}</button>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            <div class="sheet-actions">
                <button class="settings-btn" id="filter-reset" type="button">清除筛选</button>
                <button class="settings-btn primary" id="filter-done" type="button">完成</button>
            </div>
        `,
        mount(root) {
            root.addEventListener('click', (event) => {
                const folder = event.target.closest('[data-folder-row]');
                if (folder) {
                    const next = folderRows[Number(folder.dataset.folderRow)].name;
                    state.folder = next === state.folder ? '' : next;
                    closeSheet();
                    renderList();
                    return;
                }
                const tag = event.target.closest('[data-tag]');
                if (tag) {
                    state.tag = state.tag === tag.dataset.tag ? '' : tag.dataset.tag;
                    closeSheet();
                    renderList();
                    return;
                }
                if (event.target.closest('#filter-reset')) {
                    state.folder = '';
                    state.tag = '';
                    closeSheet();
                    renderList();
                    return;
                }
                if (event.target.closest('#filter-done')) closeSheet();
            });
        }
    });
}

function cardHtml(item) {
    const done = item.type === 'todo' && item.isDone;
    const locked = item.locked;
    const body = locked ? '' : snippet(item.content, 120);
    const tags = item.tags.slice(0, 2).map((tag) => `<span class="card-tag">#${esc(tag)}</span>`).join('');
    const folder = item.folder ? `<span class="card-folder">${esc(item.folder)}</span>` : '';

    const check = item.type === 'todo'
        ? `<button class="card-check${done ? ' done' : ''}" type="button" data-action="toggle-done" data-id="${esc(item.id)}">
               <span class="ms-icon ms-s18">${done ? 'check_box' : 'check_box_outline_blank'}</span>
           </button>`
        : '';

    const pin = item.isPinned ? '<span class="ms-icon ms-s14">keep</span>' : '';
    const lock = locked ? '<span class="ms-icon ms-s14">lock</span>' : '';

    const inner = `
        <div class="card-title-row">
            <span class="card-title">${esc(displayTitle(item))}</span>
            <span class="card-title-meta">${lock}${pin}</span>
        </div>
        ${locked
            ? '<p class="card-preview">已加密，请在桌面端解锁</p>'
            : (body ? `<p class="card-preview">${esc(body)}</p>` : '')}
        <div class="card-footer">
            <span class="card-date">${esc(formatRelative(item.updatedAt))}</span>
            <span class="card-taxonomy">${folder}${tags}</span>
        </div>
    `;

    const classes = ['card'];
    if (state.activeId === item.id) classes.push('active');
    if (done) classes.push('done');
    if (item.type === 'todo') classes.push('is-todo');

    return `<article class="${classes.join(' ')}" data-id="${esc(item.id)}" role="button" tabindex="0">
        ${check}
        <div class="card-body">${inner}</div>
    </article>`;
}

function emptyState() {
    if (state.filter === 'trash') {
        return { icon: 'delete', title: '废纸篓是空的', text: '删除的笔记会先进入废纸篓' };
    }
    if (state.filter === 'pinned') {
        return { icon: 'keep', title: '还没有置顶', text: '在编辑器里点置顶，笔记会出现在这里' };
    }
    if (state.filter === 'todos') {
        return { icon: 'check_box', title: '还没有待办', text: '点 + 新建一条待办' };
    }
    if (state.folder) {
        return { icon: 'folder', title: '这个文件夹是空的', text: '换一个文件夹，或点 + 新建' };
    }
    if (state.tag) {
        return { icon: 'label', title: '没有这个标签的条目', text: '再点一次标签即可清除筛选' };
    }
    return { icon: 'description', title: '还没有笔记', text: '点 + 开始记录' };
}

function renderList() {
    renderTabbar();

    syncMenuSort();

    const list = visibleItems();

    if (!list.length) {
        cards.innerHTML = '';
        const message = emptyState();
        listEmptyIcon.textContent = message.icon;
        listEmptyTitle.textContent = message.title;
        listEmptyText.textContent = message.text;
        listEmpty.hidden = false;
        return;
    }

    listEmpty.hidden = true;
    cards.innerHTML = list.map(cardHtml).join('');
}

function showPane(name) {
    state.pane = name;
    const wide = isWide();
    app.classList.toggle('wide', wide);

    if (name !== 'list') closeCompose();

    if (name === 'settings') {
        paneSettings.hidden = false;
        if (wide) {
            paneList.hidden = false;
            paneEditor.hidden = false;
        } else {
            paneList.hidden = true;
            paneEditor.hidden = true;
        }
        return;
    }

    paneSettings.hidden = true;

    if (wide) {
        paneList.hidden = false;
        paneEditor.hidden = false;
        return;
    }

    paneList.hidden = name !== 'list';
    paneEditor.hidden = name !== 'editor';
}

function renderMeta() {
    const draft = state.draft;
    if (!draft) {
        editorMeta.innerHTML = '';
        editorMeta.hidden = true;
        return;
    }

    const parts = [];

    if (draft.type === 'todo') {
        parts.push(`<button class="meta-chip${draft.isDone ? ' done' : ''}" type="button" data-meta="toggle-done">
            <span class="ms-icon ms-s13">${draft.isDone ? 'check_box' : 'check_box_outline_blank'}</span>
            <span>${draft.isDone ? '已完成' : '未完成'}</span>
        </button>`);
    }

    draft.tags.forEach((tag) => {
        parts.push(`<span class="meta-chip accent">#${esc(tag)}<button type="button" data-remove-tag="${esc(tag)}">
            <span class="ms-icon ms-s12">close</span>
        </button></span>`);
    });

    editorMeta.innerHTML = parts.join('');
    editorMeta.hidden = !parts.length;
}

function renderStats() {
    const draft = state.draft;
    if (!draft) {
        editorStats.textContent = '';
        return;
    }
    const chars = draft.content.replace(/\s/g, '').length;
    const lines = draft.content ? draft.content.split('\n').length : 0;
    editorStats.textContent = `${chars} 字 · ${lines} 行`;
}

function renderEditor({ force = false } = {}) {
    const draft = state.draft;

    if (!draft) {
        editorEmpty.hidden = false;
        editorScroll.hidden = true;
        editorFoot.hidden = true;
        editorMeta.hidden = true;
        return;
    }

    editorEmpty.hidden = true;
    editorScroll.hidden = false;
    editorFoot.hidden = false;

    const isTodo = draft.type === 'todo';
    editorKindIcon.textContent = isTodo ? 'check_box' : 'description';
    editorKind.textContent = isTodo ? '待办' : '笔记';
    btnEditorPin.classList.toggle('active', !!draft.isPinned);
    editorSaved.textContent = state.dirty ? '未保存' : '已保存';
    editorSaved.classList.toggle('dirty', state.dirty);

    renderMeta();
    renderStats();

    editorFolderLabel.textContent = draft.folder || '默认';

    editorTitle.value = draft.title;
    editorBody.value = draft.content;

    const locked = !!draft.locked;
    editorTitle.disabled = locked;
    editorTitle.hidden = locked;
    btnEditorTag.hidden = locked;
    btnEditorPin.hidden = locked;
    btnEditorFolder.hidden = locked;

    if (locked) {
        editorBody.hidden = true;
        editorPreview.hidden = false;
        editorPreview.innerHTML = `<div class="locked-note">
            <span class="ms-icon ms-s24">lock</span>
            <p>这是一条加密笔记。<br>内容由桌面端加密，移动端暂不支持解密与编辑。</p>
        </div>`;
        editorFoot.hidden = true;
        return;
    }

    if (state.preview) {
        editorBody.hidden = true;
        editorPreview.hidden = false;
        editorPreview.innerHTML = renderMarkdown(draft.content) || '<p class="md-placeholder">没有内容</p>';
        editorModeLabel.textContent = '编辑';
        editorModeIcon.textContent = 'edit';
        btnEditorMode.classList.add('active');
    } else {
        editorPreview.hidden = true;
        editorBody.hidden = false;
        editorModeLabel.textContent = '预览';
        editorModeIcon.textContent = 'visibility';
        btnEditorMode.classList.remove('active');
    }

    if (force) editorScroll.scrollTop = 0;
}

async function openItem(id) {
    if (!state.items.some((entry) => entry.id === id)) return;
    if (state.activeId === id) {
        showPane('editor');
        return;
    }

    await flushSave();

    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;

    state.activeId = id;
    state.draft = cloneItem(item);
    state.dirty = false;
    state.preview = false;

    renderList();
    renderEditor({ force: true });
    showPane('editor');
}

function closeEditor() {
    saveDraft().catch(() => {});
    state.activeId = '';
    state.draft = null;
    state.dirty = false;
    renderList();
    showPane('list');
}

function markDirty() {
    state.dirty = true;
    editorSaved.textContent = '未保存';
    editorSaved.classList.add('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveDraft().catch(() => {}); }, 500);
    renderStats();
}

async function saveDraft() {
    const draft = state.draft;
    if (!draft || draft.locked) return;
    clearTimeout(saveTimer);

    draft.updatedAt = Date.now();
    await writeText(draft.path, serializeItem(draft));

    const target = state.items.find((item) => item.id === draft.id);
    if (target) {
        Object.assign(target, cloneItem(draft));
    } else {
        state.items.push(cloneItem(draft));
    }

    state.dirty = false;
    if (state.draft === draft) {
        editorSaved.textContent = '已保存';
        editorSaved.classList.remove('dirty');
    }
    renderList();
}

async function flushSave() {
    if (!state.dirty) return;
    try {
        await saveDraft();
    } catch (err) {
        toast('保存失败：' + (err && err.message ? err.message : '未知错误'));
    }
}

function newItemId() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    let id = '';
    bytes.forEach((value) => { id += alphabet[value % alphabet.length]; });
    return state.items.some((item) => item.id === id) ? newItemId() : id;
}

async function createItem(type) {
    await flushSave();

    const now = Date.now();
    const id = newItemId();
    const item = {
        id,
        path: `items/${id}.md`,
        type: type === 'todo' ? 'todo' : 'note',
        title: '',
        folder: state.folder || '',
        tags: state.tag ? [state.tag] : [],
        isPinned: false,
        isTrashed: false,
        isHidden: false,
        locked: false,
        isDone: false,
        createdAt: now,
        updatedAt: now,
        content: '',
        hasMeta: true,
        unknownMeta: []
    };

    await writeText(item.path, serializeItem(item));
    state.items.push(item);

    state.activeId = id;
    state.draft = cloneItem(item);
    state.dirty = false;
    state.preview = false;

    renderList();
    renderEditor({ force: true });
    showPane('editor');

    if (item.type === 'note') {
        setTimeout(() => editorTitle.focus(), 240);
    }
}

async function toggleDone(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;

    const wasDone = item.isDone;
    item.isDone = !item.isDone;
    item.updatedAt = Date.now();
    await writeText(item.path, serializeItem(item));

    if (state.draft && state.draft.id === id) {
        state.draft.isDone = item.isDone;
        renderMeta();
    }

    renderList();
    if (!wasDone) toast('已标记完成');
}

async function togglePin() {
    const draft = state.draft;
    if (!draft) return;
    draft.isPinned = !draft.isPinned;
    markDirty();
    btnEditorPin.classList.toggle('active', !!draft.isPinned);
    await saveDraft();
    toast(draft.isPinned ? '已置顶' : '已取消置顶');
}

async function setTrashed(trashed) {
    const draft = state.draft;
    if (!draft) return;
    draft.isTrashed = trashed;
    await saveDraft();
    toast(trashed ? '已移到废纸篓' : '已恢复到笔记列表');
    if (isWide()) {
        state.activeId = '';
        state.draft = null;
        renderEditor();
        renderList();
    } else {
        closeEditor();
    }
}

function deleteForever() {
    const draft = state.draft;
    if (!draft) return;

    confirmSheet({
        title: '永久删除',
        message: `「${displayTitle(draft)}」将被彻底删除，无法恢复。`,
        confirmText: '永久删除',
        danger: true,
        async onConfirm() {
            await removeFile(draft.path);
            state.items = state.items.filter((item) => item.id !== draft.id);
            state.activeId = '';
            state.draft = null;
            renderList();
            renderEditor();
            showPane('list');
            toast('已删除');
        }
    });
}

function setComposeOpen(open) {
    const next = !!open;
    composeEl.classList.toggle('open', next);
    btnCompose.setAttribute('aria-expanded', next ? 'true' : 'false');
}

function toggleCompose() {
    setComposeOpen(!composeEl.classList.contains('open'));
}

function closeCompose() {
    setComposeOpen(false);
}

function openMoreSheet() {
    const draft = state.draft;
    if (!draft) return;

    const rows = [
        { icon: 'keep', label: draft.isPinned ? '取消置顶' : '置顶', run: () => togglePin() },
        { icon: 'folder', label: '移动到文件夹', run: () => openFolderSheet() },
        { icon: 'content_copy', label: '复制正文', run: () => copyBody(draft) }
    ];

    if (draft.isTrashed) {
        rows.push({ icon: 'restore_from_trash', label: '恢复到笔记列表', run: () => setTrashed(false) });
    } else {
        rows.push({ icon: 'delete', label: '移到废纸篓', run: () => setTrashed(true) });
    }
    rows.push({ icon: 'delete_forever', label: '永久删除', danger: true, run: () => deleteForever() });

    openSheet({
        title: displayTitle(draft),
        html: rows.map((row, index) => `
            <button class="sheet-item${row.danger ? ' danger' : ''}" data-row="${index}">
                <span class="ms-icon ms-s18">${row.icon}</span>
                <span>${esc(row.label)}</span>
            </button>
        `).join(''),
        mount(root) {
            root.addEventListener('click', (event) => {
                const button = event.target.closest('[data-row]');
                if (!button) return;
                closeSheet();
                const row = rows[Number(button.dataset.row)];
                if (row) row.run();
            });
        }
    });
}

async function copyBody(draft) {
    try {
        await navigator.clipboard.writeText(draft.content);
        toast('正文已复制');
    } catch (err) {
        toast('无法访问剪贴板');
    }
}

function openTagSheet() {
    const draft = state.draft;
    if (!draft) return;

    const known = allTags();
    draft.tags.forEach((tag) => {
        if (!known.includes(tag)) known.push(tag);
    });

    const chipsHtml = () => known.map((tag) => (
        `<button class="chip${draft.tags.includes(tag) ? ' accent' : ''}" type="button" data-toggle-tag="${esc(tag)}">#${esc(tag)}</button>`
    )).join('') || '<span class="settings-row-desc">还没有标签，先输入一个</span>';

    openSheet({
        title: '标签',
        html: `
            <div class="sheet-chips" id="tag-chips">${chipsHtml()}</div>
            <input class="sheet-field" id="tag-input" type="text" placeholder="输入新标签后回车" autocomplete="off" spellcheck="false">
            <div class="sheet-actions">
                <button class="settings-btn primary" id="tag-done" type="button">完成</button>
            </div>
        `,
        mount(root) {
            const chipsBox = root.querySelector('#tag-chips');
            const input = root.querySelector('#tag-input');

            const refresh = () => { chipsBox.innerHTML = chipsHtml(); };

            const addTag = async (raw) => {
                const tag = String(raw || '').trim().replace(/^#+/, '').trim();
                if (!tag || draft.tags.includes(tag)) return;
                draft.tags.push(tag);
                refresh();
                await saveDraft();
                renderEditor();
            };

            root.addEventListener('click', async (event) => {
                const toggle = event.target.closest('[data-toggle-tag]');
                if (toggle) {
                    const tag = toggle.dataset.toggleTag;
                    if (draft.tags.includes(tag)) {
                        draft.tags = draft.tags.filter((entry) => entry !== tag);
                    } else {
                        draft.tags.push(tag);
                    }
                    refresh();
                    await saveDraft();
                    renderEditor();
                    return;
                }
                if (event.target.closest('#tag-done')) closeSheet();
            });

            input.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addTag(input.value);
                input.value = '';
            });
        }
    });
}

function openFolderSheet() {
    const draft = state.draft;
    if (!draft) return;

    const folders = uniqueFolders();
    const rows = [{ name: '', label: '默认' }].concat(folders.map((name) => ({ name, label: name })));

    openSheet({
        title: '文件夹',
        html: `
            ${rows.map((row, index) => `
                <button class="sheet-item" data-folder-row="${index}">
                    <span class="ms-icon ms-s18">${row.name ? 'folder' : 'folder_open'}</span>
                    <span>${esc(row.label)}</span>
                    ${(draft.folder || '') === row.name ? '<span class="ms-icon ms-s16" style="margin-left:auto;color:var(--accent)">check</span>' : ''}
                </button>
            `).join('')}
            <input class="sheet-field" id="folder-input" type="text" placeholder="新建文件夹后回车" autocomplete="off" spellcheck="false">
        `,
        mount(root) {
            const input = root.querySelector('#folder-input');

            const apply = async (name) => {
                draft.folder = name;
                closeSheet();
                await saveDraft();
                renderEditor();
            };

            root.addEventListener('click', (event) => {
                const button = event.target.closest('[data-folder-row]');
                if (!button) return;
                apply(rows[Number(button.dataset.folderRow)].name);
            });

            input.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const name = input.value.trim();
                if (name) apply(name === '默认' ? '' : name);
            });
        }
    });
}

function renderSyncStatus(errorText) {
    const sync = state.settings.sync;
    btnSync.hidden = !syncConfigured();
    btnSync.disabled = !syncConfigured();
    syncStatus.classList.toggle('error', !!errorText);

    if (errorText) {
        syncStatus.textContent = errorText;
        return;
    }
    if (!sync.url) {
        syncStatus.textContent = '尚未配置';
        return;
    }
    if (!sync.token) {
        syncStatus.textContent = '已填地址，尚未登录';
        return;
    }

    const parts = [];
    parts.push(sync.account ? `已登录：${sync.account}` : '已登录');
    if (sync.lastSyncAt) parts.push(`上次同步 ${formatRelative(sync.lastSyncAt)}`);
    if (sync.summary) parts.push(sync.summary.replace(/^同步完成：/, ''));
    syncStatus.textContent = parts.join(' · ');
}

async function renderDataStats() {
    const notes = state.items.filter((item) => item.type === 'note' && !item.isTrashed && !item.isHidden).length;
    const todos = state.items.filter((item) => item.type === 'todo' && !item.isTrashed && !item.isHidden).length;
    const trash = state.items.filter((item) => item.isTrashed).length;

    statNotes.textContent = String(notes);
    statTodos.textContent = String(todos);
    statTrash.textContent = String(trash);
    statBackend.textContent = storageBackendName() === 'localstorage' ? 'localStorage' : 'IndexedDB';

    const records = await listRecords();
    const size = records.reduce((sum, [, record]) => sum + byteLength(record && record.data), 0);
    statSize.textContent = formatBytes(size);
}

function setSyncingUi(active) {
    btnSync.classList.toggle('spinning', active);
    btnSyncNow.disabled = active;
    btnSyncLogin.disabled = active;
}

async function runSync({ silent = false } = {}) {
    if (!syncConfigured()) {
        if (!silent) toast('请先在设置里填写服务器并登录');
        return;
    }
    if (isSyncing()) return;

    setSyncingUi(true);
    try {
        await flushSave();
        const result = await syncNow();
        if (!result.ok) {
            renderSyncStatus(result.error);
            if (!silent) toast(result.error);
            return;
        }

        await loadItems();
        if (state.activeId) {
            const fresh = state.items.find((item) => item.id === state.activeId);
            if (fresh) {
                state.draft = cloneItem(fresh);
                state.dirty = false;
                renderEditor();
            } else {
                state.activeId = '';
                state.draft = null;
                renderEditor();
            }
        }
        renderList();
        renderSyncStatus();
        if (state.pane === 'settings') renderDataStats();
        if (!silent) toast(result.summary);
    } finally {
        setSyncingUi(false);
    }
}

function hydrateSettingsForm() {
    const sync = state.settings.sync;
    syncUrlInput.value = sync.url || '';
    syncAccountInput.value = sync.account || '';

    themeSegmented.querySelectorAll('[data-theme]').forEach((button) => {
        button.classList.toggle('active', button.dataset.theme === (state.settings.theme || 'system'));
    });
    sortSegmented.querySelectorAll('[data-sort]').forEach((button) => {
        button.classList.toggle('active', button.dataset.sort === sortValue());
    });

    renderSyncStatus();
}

async function handleLogin() {
    const url = normalizeUrl(syncUrlInput.value);
    const account = syncAccountInput.value.trim();
    const password = syncPasswordInput.value;

    if (!url) {
        toast('请填写服务器地址');
        syncUrlInput.focus();
        return;
    }
    if (!account) {
        toast('请填写账户名');
        syncAccountInput.focus();
        return;
    }
    if (!password) {
        toast('请填写账户密码');
        syncPasswordInput.focus();
        return;
    }

    state.settings.sync.url = url;
    state.settings.sync.account = account;
    await writeSettings(state.settings);

    setSyncingUi(true);
    try {
        const result = await loginWithAccount({ url, account, password });
        if (!result.ok) {
            renderSyncStatus(result.error);
            toast(result.error);
            return;
        }

        state.settings.sync.url = url;
        state.settings.sync.account = account;
        state.settings.sync.token = result.token;
        state.settings.sync.tokenName = '移动端';
        state.settings.sync.journalId = '';
        state.settings.sync.lastSeq = 0;
        state.settings.sync.selfPushed = [];
        await writeSettings(state.settings);

        syncPasswordInput.value = '';
        renderSyncStatus();
        toast(`已登录：${(result.user && result.user.name) || account}`);
    } finally {
        setSyncingUi(false);
    }

    await runSync({ silent: true });
    renderSyncStatus();
}

async function handleLogout() {
    confirmSheet({
        title: '退出同步',
        message: '会清除本机的同步令牌与同步位置，笔记本身不会被删除。',
        confirmText: '退出',
        danger: true,
        async onConfirm() {
            const sync = state.settings.sync;
            sync.token = '';
            sync.tokenName = '';
            sync.journalId = '';
            sync.lastSeq = 0;
            sync.selfPushed = [];
            sync.lastSyncAt = 0;
            sync.summary = '';
            await writeSettings(state.settings);
            renderSyncStatus();
            toast('已退出同步');
        }
    });
}

function initSettingsEvents() {
    themeSegmented.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-theme]');
        if (!button) return;
        state.settings.theme = button.dataset.theme;
        applyTheme(state.settings.theme);
        await writeSettings(state.settings);
    });

    sortSegmented.addEventListener('click', (event) => {
        const button = event.target.closest('[data-sort]');
        if (!button) return;
        setSort(button.dataset.sort);
    });

    syncUrlInput.addEventListener('change', async () => {
        state.settings.sync.url = normalizeUrl(syncUrlInput.value);
        syncUrlInput.value = state.settings.sync.url;
        await writeSettings(state.settings);
        renderSyncStatus();
    });

    syncAccountInput.addEventListener('change', async () => {
        state.settings.sync.account = syncAccountInput.value.trim();
        await writeSettings(state.settings);
        renderSyncStatus();
    });

    btnSyncLogin.addEventListener('click', handleLogin);
    btnSyncNow.addEventListener('click', () => runSync());
    btnSyncLogout.addEventListener('click', handleLogout);

    btnClearLocal.addEventListener('click', () => {
        confirmSheet({
            title: '清空本机数据',
            message: '本机保存的全部笔记与待办都会被删除。若已登录同步，下一次同步会从服务器重新拉取。',
            confirmText: '清空',
            danger: true,
            async onConfirm() {
                await clearFiles();
                state.items = [];
                state.activeId = '';
                state.draft = null;
                state.settings.sync.lastSeq = 0;
                state.settings.sync.selfPushed = [];
                state.settings.sync.journalId = '';
                await writeSettings(state.settings);
                renderList();
                renderEditor();
                showPane('list');
                toast('本机数据已清空');
            }
        });
    });

    btnSettingsBack.addEventListener('click', () => {
        showPane('list');
        renderList();
    });

    settingsNav.addEventListener('click', (event) => {
        const button = event.target.closest('[data-section]');
        if (!button) return;
        selectSettingsSection(button.dataset.section);
    });
}

function initEvents() {
    btnCompose.addEventListener('click', toggleCompose);
    btnNewNote.addEventListener('click', () => {
        closeCompose();
        createItem('note');
    });
    btnNewTodo.addEventListener('click', () => {
        closeCompose();
        createItem('todo');
    });

    btnSearch.addEventListener('click', () => setSearchOpen(true));

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value;
        renderSearch();
    });

    searchInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        if (state.query) {
            clearSearch();
        } else {
            setSearchOpen(false);
        }
    });

    btnSearchClear.addEventListener('click', () => {
        clearSearch();
        searchInput.focus();
    });

    btnSearchBack.addEventListener('click', () => setSearchOpen(false));

    searchCards.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-action="toggle-done"]');
        if (toggle) {
            event.stopPropagation();
            toggleDone(toggle.dataset.id);
            return;
        }
        const card = event.target.closest('.card');
        if (!card) return;
        setSearchOpen(false);
        openItem(card.dataset.id);
    });

    menuSort.addEventListener('click', (event) => {
        const button = event.target.closest('[data-sort]');
        if (!button) return;
        setSort(button.dataset.sort);
    });

    tabbar.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-filter]');
        if (!tab) return;
        state.filter = tab.dataset.filter;
        if (state.filter === 'trash') state.folder = '';
        renderList();
    });

    menuFilter.addEventListener('click', () => {
        closeMenu();
        openFilterSheet();
    });

    cards.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-action="toggle-done"]');
        if (toggle) {
            event.stopPropagation();
            toggleDone(toggle.dataset.id);
            return;
        }
        const card = event.target.closest('.card');
        if (card) openItem(card.dataset.id);
    });

    cards.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('.card');
        if (!card) return;
        event.preventDefault();
        openItem(card.dataset.id);
    });

    listScroll.addEventListener('scroll', () => {
        if (composeEl.classList.contains('open')) closeCompose();
    }, { passive: true });

    listScroll.addEventListener('pointerdown', (event) => {
        if (composeEl.contains(event.target)) return;
        closeCompose();
    });

    btnMenu.addEventListener('click', toggleMenu);

    menuScrim.addEventListener('click', closeMenu);

    menuTheme.addEventListener('click', (event) => {
        const button = event.target.closest('[data-theme]');
        if (!button) return;
        setTheme(button.dataset.theme);
    });

    menuSettings.addEventListener('click', () => {
        closeMenu();
        openSettings();
    });

    btnSync.addEventListener('click', () => runSync());

    btnEditorBack.addEventListener('click', closeEditor);
    btnEditorPin.addEventListener('click', togglePin);
    btnEditorTag.addEventListener('click', openTagSheet);
    btnEditorMore.addEventListener('click', openMoreSheet);
    btnEditorFolder.addEventListener('click', openFolderSheet);

    editorTitle.addEventListener('input', () => {
        if (!state.draft) return;
        state.draft.title = editorTitle.value;
        markDirty();
    });

    editorBody.addEventListener('input', () => {
        if (!state.draft) return;
        state.draft.content = editorBody.value;
        markDirty();
    });

    btnEditorMode.addEventListener('click', () => {
        state.preview = !state.preview;
        renderEditor();
    });

    editorMeta.addEventListener('click', (event) => {
        const meta = event.target.closest('[data-meta]');
        if (meta) {
            const kind = meta.dataset.meta;
            if (kind === 'add-tag') {
                openTagSheet();
                return;
            }
            if (kind === 'folder') {
                openFolderSheet();
                return;
            }
            if (kind === 'toggle-done' && state.draft) {
                state.draft.isDone = !state.draft.isDone;
                markDirty();
                renderMeta();
                saveDraft();
                return;
            }
        }
        const remove = event.target.closest('[data-remove-tag]');
        if (remove && state.draft) {
            state.draft.tags = state.draft.tags.filter((tag) => tag !== remove.dataset.removeTag);
            renderMeta();
            saveDraft();
        }
    });

    sheetMask.addEventListener('click', closeSheet);

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!sheet.hidden) {
            closeSheet();
            return;
        }
        if (!searchOverlay.hidden) {
            if (state.query) {
                clearSearch();
            } else {
                setSearchOpen(false);
            }
            return;
        }
        if (!menuPop.hidden) {
            closeMenu();
            return;
        }
        if (composeEl.classList.contains('open')) {
            closeCompose();
            return;
        }
        if (state.pane === 'settings') {
            showPane('list');
            return;
        }
        if (state.pane === 'editor' && !isWide()) closeEditor();
    });

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => showPane(state.pane), 120);
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushSave();
            return;
        }
        if (!syncConfigured()) return;
        const last = state.settings.sync.lastSyncAt || 0;
        if (Date.now() - last > 60000) runSync({ silent: true });
    });

    window.addEventListener('pagehide', () => {
        if (!state.dirty) return;
        const draft = state.draft;
        if (!draft || draft.locked) return;
        draft.updatedAt = Date.now();
        writeText(draft.path, serializeItem(draft)).catch(() => {});
    });

    window.addEventListener('online', () => {
        if (syncConfigured()) runSync({ silent: true });
    });
}

async function loadBrandIcon() {
    const slot = $('app-brand-icon');
    if (!slot) return;
    if (slot.querySelector('svg')) return;
    try {
        const response = await fetch('./assets/tray.svg');
        if (!response.ok) return;
        const svg = await response.text();
        slot.innerHTML = svg
            .replace(/fill="(?!none)[^"]*"/g, 'fill="currentColor"')
            .replace(/<svg([^>]*)>/, '<svg$1 class="app-brand-icon" aria-hidden="true">');
    } catch (err) {
        console.warn('[Nemo] 读取品牌图标失败：', err && err.message);
    }
}

async function boot() {
    state.settings = await readSettings();

    if (!state.settings.sync.url && /^https?:$/.test(location.protocol)) {
        state.settings.sync.url = location.origin;
        await writeSettings(state.settings);
    }

    applyTheme(state.settings.theme || 'system');

    initSync({
        settings: state.settings,
        persist: () => writeSettings(state.settings),
        onChange: (event) => {
            if (event && event.type === 'syncing') setSyncingUi(true);
        }
    });

    initEvents();
    initSettingsEvents();
    loadBrandIcon();

    await loadItems();
    showPane('list');
    renderList();
    renderEditor();
    renderSyncStatus();

    if (isSyncing()) setSyncingUi(true);

    if (syncConfigured()) {
        const last = state.settings.sync.lastSyncAt || 0;
        if (Date.now() - last > 30000) {
            setTimeout(() => runSync({ silent: true }), 1200);
        }
    }
}

boot().catch((error) => {
    console.error('[Nemo] 启动失败：', error);
    toast('启动失败：' + (error && error.message ? error.message : '未知错误'));
});
