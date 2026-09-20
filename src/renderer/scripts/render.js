/* 界面渲染：侧边栏、标签页、中栏列表（笔记与待办混排）与工作区 */

// 各区域的渲染签名：与上一次一致时跳过 DOM 重建，避免无意义的整树重排
const renderSignatures = { folders: null, tags: null, tabs: null, list: null };

/* 中栏列表分批挂载：卡片是一次性全量建出来的（每张都要建节点、解析一次 innerHTML、
   挂上点击与右键两个监听器），几千条时会连着好几帧占住主线程，
   期间拖动窗口、点按钮都像卡住了一样。这里改成第一批立即挂上、其余按帧续挂：
   视觉上依旧是整列一起出现，主线程却始终留出空隙响应输入；
   列表不长时一批就挂完，与原来的行为完全一致。 */
const LIST_RENDER_CHUNK = 80;
// 列表渲染代号：每轮渲染自增，用来作废上一轮还没挂完的分批任务
let listRenderToken = 0;

/* 中栏列表的进场动画（关键帧见 styles/motion.css）：只在「换了一批内容」时播一次——
   筛选、搜索词、排序任一变化。编辑正文同样会整列重建（自动保存每 300ms 刷新一次列表），
   那种重建必须保持静态，否则打字过程中卡片会一遍遍淡入。
   容器上的 .list-enter 会在动画跑完后自动摘掉，避免后续重建的卡片又赶上一轮。 */
const LIST_ENTER_CLASS = 'list-enter';
// 动画总时长：最大延迟 128ms + 单卡时长 180ms，再留一点余量
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
// 侧边栏文字渐隐时长（与 CSS 中 .nav-text 等的 opacity 过渡保持一致）
const SIDEBAR_TEXT_FADE_MS = 160;
// 底栏图标（清空废纸篓 / 设置 / 收起）渐隐渐显的临时类：只在收起方向上挂。
// 收起时它们跟文字一起先渐隐，宽度过渡结束（收起动画走完）后再渐显回新位置，
// 样式见 styles/sidebar.css 里的 .sidebar.icons-fading
const SIDEBAR_ICONS_FADING_CLASS = 'icons-fading';

let sidebarFadeTimer = null;
let sidebarCollapseTimer = null;
let sidebarFadeInBound = false;

// 渐显结束（文字与底栏图标共用）：移除临时类并清掉兜底定时器
function finishSidebarTextFadeIn() {
    if (sidebarFadeTimer) {
        clearTimeout(sidebarFadeTimer);
        sidebarFadeTimer = null;
    }
    const sidebar = document.getElementById('app-sidebar');
    if (sidebar) sidebar.classList.remove('text-fading', SIDEBAR_ICONS_FADING_CLASS);
}

function clearSidebarCollapseTimer() {
    if (sidebarCollapseTimer) {
        clearTimeout(sidebarCollapseTimer);
        sidebarCollapseTimer = null;
    }
}

// 兜底：侧边栏处于隐藏状态时不会触发宽度过渡，靠定时器保证临时类最终能被摘掉
function scheduleSidebarFadeInFallback() {
    if (sidebarFadeTimer) clearTimeout(sidebarFadeTimer);
    sidebarFadeTimer = setTimeout(finishSidebarTextFadeIn, SIDEBAR_WIDTH_TRANSITION_MS + 60);
}

// 侧边栏收起/展开：收起后只剩一条窄条，筛选入口仅保留图标。
// 动效分两拍，两个方向正好相反：
//   收起：先渐隐文字（计数、文件夹 / 标签分区、应用名同步淡出）与底栏图标
//         （清空废纸篓 / 设置 / 收起——它们紧接着要换排布并放大，先隐掉才看不到那一跳），
//         此阶段布局不动，导航图标原地不动；淡出结束再切到收起态，
//         只让背景与「新建」按钮往里收，宽度过渡走完底栏图标才渐显回新位置；
//   展开：先把背景与按钮展开，宽度过渡结束后文字才淡入（底栏图标不参与，全程可见）。
function applySidebarCollapsed() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;

    // 宽度过渡结束（或超时兜底）后再让文字（收起方向上还有底栏图标）渐显
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
    const wasCollapsed = rootClass.contains(SIDEBAR_COLLAPSED_CLASS);
    const fading = sidebar.classList.contains('text-fading');

    if (collapsed) {
        if (wasCollapsed) {
            // 已经是收起态（首屏或重复调用）：清掉可能残留的动画状态，直接停在收起布局上
            clearSidebarCollapseTimer();
            finishSidebarTextFadeIn();
        } else if (!fading) {
            // 第一拍：文字与底栏图标一起渐隐。此时不碰布局，导航图标因此不会位移
            sidebar.classList.add('text-fading', SIDEBAR_ICONS_FADING_CLASS);
            clearSidebarCollapseTimer();
            sidebarCollapseTimer = setTimeout(() => {
                sidebarCollapseTimer = null;
                // 第二拍：文字与底栏图标已看不见了，这时才换收起态布局——
                // 背景变窄，「新建」按钮与底栏按钮跟着一起往里收
                rootClass.add(SIDEBAR_COLLAPSED_CLASS);
                // 收起动画走完（宽度过渡结束）再由 finishSidebarTextFadeIn 摘掉临时类、
                // 让底栏图标渐显；这里只是过渡不触发时的兜底
                scheduleSidebarFadeInFallback();
            }, SIDEBAR_TEXT_FADE_MS);
        }
        // 其余情况（渐隐正进行中）：让动画走完，不重启计时
    } else {
        clearSidebarCollapseTimer();
        rootClass.remove(SIDEBAR_COLLAPSED_CLASS);
        if (wasCollapsed) {
            // 收起 → 展开：宽度过渡期间文字保持不可见，过渡结束（或超时）后再淡入
            sidebar.classList.add('text-fading');
            // 兜底：侧边栏处于隐藏状态时不会触发过渡，靠定时器保证文字最终可见
            scheduleSidebarFadeInFallback();
        } else {
            // 渐隐途中被撤销（还没进入收缩）：让文字淡回来即可，布局始终没变过
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

// 标签页的落点随布局走：经典布局在标题栏里（#titlebar-tabs），现代布局在工作区顶部那一行
// （#workspace-tabs，见 main.html 与 styles/mode.css）。两个容器都在，渲染时只往当前布局的那个里写
function tabsContainerId() {
    return isModernLayout() ? 'workspace-tabs' : 'titlebar-tabs';
}

/* 标签栏两端的渐隐：标签排不下时两端淡出去，替藏起来的滚动条把「还能往哪边滚」提示出来
   （样式只对现代布局的标签栏生效，见 styles/mode.css）。
   两个类名只在对应的那一侧「确实还有被截断的标签」时挂上——标签根本没排满、
   或已经滚到那一端时摘掉，否则最边上的标签会被白白削掉一角。
   判定要跟着滚动位置与容器宽度走；宽度不只由窗口决定，AI 面板开合、侧边栏收起、
   切布局都会改动它（见 styles/mode.css 里那几条 margin-right），因此宽度一侧交给
   ResizeObserver 一并接住，省得在那些地方各补一次调用。 */
const TABS_FADE_RIGHT_CLASS = 'tabs-fade-right';
const TABS_FADE_LEFT_CLASS = 'tabs-fade-left';
// 已绑过监听的容器（两个容器各绑一次，不必每次渲染都重建闭包）
const tabsFadeObserved = new WeakSet();

function updateTabsFade(container) {
    if (!container) return;
    // 留 1px 容差：滚动位置的亚像素误差、面板宽度过渡途中都会让差值停在 0 附近
    container.classList.toggle(TABS_FADE_LEFT_CLASS, container.scrollLeft > 1);
    const moreOnRight = container.scrollWidth - container.clientWidth - container.scrollLeft > 1;
    container.classList.toggle(TABS_FADE_RIGHT_CLASS, moreOnRight);
}

function bindTabsFade(container) {
    if (!container || tabsFadeObserved.has(container)) return;
    tabsFadeObserved.add(container);

    container.addEventListener('scroll', () => updateTabsFade(container));
    // 容器被整条收起时（一个标签都没有，或设置里开了「禁用标签页」）尺寸归零，
    // 这里跟着算出「右边没有内容」并摘掉类名，不必另判那两种情形
    new ResizeObserver(() => updateTabsFade(container)).observe(container);
}

// Tabs (Extends up to the new note button, mouse wheel over container scrolls horizontally)
function renderTabs() {
    const tabsContainer = document.getElementById(tabsContainerId());

    // 滚轮横向滚动：只需绑定一次，不必每次渲染都重建闭包
    if (!tabsContainer.onwheel) {
        tabsContainer.onwheel = (e) => {
            if (tabsContainer.scrollWidth > tabsContainer.clientWidth) {
                e.preventDefault();
                tabsContainer.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
            }
        };
    }

    // 右端渐隐的监听同样只需绑一次
    bindTabsFade(tabsContainer);

    // 丢弃指向已不存在条目的标签，避免留下打不开的幽灵标签
    State.openNoteIds = State.openNoteIds.filter(id => id === 'settings' || !!getItemById(id));

    // 签名里带上模式：切模式后标签本身没变，也要换到另一个容器里重排一次
    const signature = `${State.uiMode}\u0001${State.activeNoteId}\u0001${State.openNoteIds.map(id => {
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

    // 标签全部挂完后判定一次：新建标签、关标签、切布局都要重新看右端还需不需要淡
    // （读 scrollWidth 会强制同步一次布局，这里拿到的就是刚排好的宽度）
    updateTabsFade(tabsContainer);
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
function buildNotePreviewText(raw) {
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

/* 摘要缓存：同一条目在同一份正文上只会被算一次。
   中栏列表每次界面刷新都要算一遍摘要（渲染签名里一次、建卡片时再一次），
   而自动保存每隔 300ms 就会刷新一次列表，未改动的条目因此会被反复重算。
   缓存挂在条目对象上（WeakMap），条目被删除后随之回收；
   正文没变（同一个字符串引用）就直接复用，改过正文则自动重算。 */
const PREVIEW_TEXT_CACHE = new WeakMap();

function notePreviewText(item) {
    const raw = typeof item.content === 'string' ? item.content : '';
    const cached = PREVIEW_TEXT_CACHE.get(item);
    if (cached && cached.source === raw) return cached.text;

    const text = buildNotePreviewText(raw);
    PREVIEW_TEXT_CACHE.set(item, { source: raw, text });
    return text;
}

// 搜索框提示随当前视图变化：笔记 / 待办两个入口各说各的，其余视图为两类混合
function searchPlaceholderText(filter) {
    if (filter === 'all') return '搜索笔记... (Ctrl+K)';
    if (filter === 'todos') return '搜索待办... (Ctrl+K)';
    return '搜索笔记与待办... (Ctrl+K)';
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

    // 换了一批内容（筛选 / 搜索词 / 排序）才播入场动画；签名里的正文摘要与展示时间变化不算
    const enterKey = `${State.currentFilter}\u0001${State.searchQuery}\u0002${State.sortBy}`;
    if (enterKey !== listEnterKey) {
        listEnterKey = enterKey;
        playListEnter(container);
    }

    // 新一轮渲染开始：作废上一轮尚未挂完的分批任务
    const token = ++listRenderToken;
    container.innerHTML = '';

    if (list.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 32px 10px; color: var(--text-muted); font-size: 12px;">
                无匹配内容
            </div>
        `;
        return;
    }

    // 先挂上第一批，其余按帧续挂（见上面的 LIST_RENDER_CHUNK 说明）
    let next = 0;
    const appendChunk = () => {
        // 期间又渲染过一次（切了筛选、改了搜索词）：这批作废，
        // 否则旧列表会被续接到新列表下面
        if (token !== listRenderToken) return;

        const end = Math.min(next + LIST_RENDER_CHUNK, list.length);
        // 一帧内的若干卡片仍走文档碎片，避免逐个卡片触发样式计算与重排
        const fragment = document.createDocumentFragment();
        for (; next < end; next++) {
            const item = list[next];
            fragment.appendChild(isTodoItem(item) ? createTodoCard(item, { isTrashView }) : createNoteCard(item));
        }
        container.appendChild(fragment);

        if (next >= list.length) return;
        // 窗口不可见时 rAF 不触发（在后台启动会停在半截列表上），此时退回定时器续挂
        if (document.hidden) setTimeout(appendChunk, 0);
        else requestAnimationFrame(appendChunk);
    };
    appendChunk();
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
        syncUiModeUI();
        syncUpdateSettingsUI();
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
            folderSelect.appendChild(opt);
        });
        // 统一用 value 选中当前文件夹：自绘下拉包装了 value 的 setter，能同步刷新显示
        folderSelect.value = item.folder;
        // 兜底：文件夹不在选项里时（正常流程下不会发生）退回第一项，避免下拉空着
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

    // 待办多一个完成状态开关，非待办条目下隐藏该按钮（顶栏右侧只剩它一个动作按钮）
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
