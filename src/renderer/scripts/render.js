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
    // 笔记与待办各统计一个「全部」；已置顶与废纸篓里两类混排，因此一并计入。
    // 隐藏的条目不进任何列表，也就不参与计数（它们只在设置页的秘密本里出现）
    let activeNoteCount = 0;
    let activeTodoCount = 0;
    let pinnedCount = 0;
    let trashedCount = 0;
    State.notes.forEach(note => {
        if (isSecretHidden(note)) return;
        if (note.isTrashed) {
            trashedCount++;
        } else {
            activeNoteCount++;
            if (note.isPinned) pinnedCount++;
        }
    });

    State.todos.forEach(todo => {
        if (isSecretHidden(todo)) return;
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
    document.getElementById('sidebar-stat').textContent = `${activeNoteCount} 篇笔记 · ${activeTodoCount} 项待办`;

    sidebarNavItems.forEach(el => {
        const f = el.getAttribute('data-filter');
        if (f === State.currentFilter) el.classList.add('active');
        else el.classList.remove('active');
    });

    // 「清空」按钮只在废纸篓视图出现，一次清空笔记与待办
    const clearBtn = document.getElementById('btn-empty-trash');
    clearBtn.classList.toggle('hidden', State.currentFilter !== 'trash');
    // 「导入文件」按钮跟随同一处判断，但方向相反：它在废纸篓视图下藏起来
    // （往废纸篓里导入没有意义），其余视图都排在底栏设置按钮左边
    document.getElementById('btn-import-note').classList.toggle('hidden', State.currentFilter === 'trash');
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
        `;

        item.addEventListener('click', () => {
            State.currentFilter = `folder:${folder}`;
            renderApp();
        });

        // 改名与删除统一收进右键菜单，条目上不再挂删除按钮
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showFolderContextMenu(e.clientX, e.clientY, folder);
        });

        container.appendChild(item);
    });
}

// 应用中已有的标签（仅统计未删除且未隐藏的笔记与待办），排序后供弹窗里的候选项列表使用
function getAllTags() {
    const tags = new Set();
    [...State.notes, ...State.todos].filter(item => !item.isTrashed && !isSecretHidden(item)).forEach(item => {
        if (Array.isArray(item.tags)) item.tags.forEach(t => { if (t) tags.add(t); });
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function renderTags() {
    // 标签面板统计未删除且未隐藏的笔记与待办：两者共用同一个列表，标签过滤因此对两类都生效
    const tagSet = new Set();
    [...State.notes, ...State.todos].forEach(item => {
        if (item.isTrashed || isSecretHidden(item)) return;
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

/* ---------------- 编辑器顶栏的标签行 ----------------
   标签排不下时这一行横向滚动（滚动条藏起来，同标签栏），两端渐隐替藏起来的滚动条
   提示「还能往哪边滚」——样式只对 #editor-tags-container 生效，见 styles/editor.css。
   两个类名只在对应的那一侧「确实还有被截断的标签」时挂上：标签没排满、或已经滚到
   那一端时摘掉，否则最边上的标签会被白白削掉一角。
   容器宽度不只由窗口决定（侧边栏收起、AI 面板开合、切布局都会改动它），因此与标签栏
   一样交给 ResizeObserver 接住，不在那些地方各补一次调用。 */
const TAGS_FADE_RIGHT_CLASS = 'tags-fade-right';
const TAGS_FADE_LEFT_CLASS = 'tags-fade-left';
// 监听只绑一次：容器在页面里只有一个，且不会被替换
let tagsScrollBound = false;

function updateTagsFade(container) {
    if (!container) return;
    // 留 1px 容差：滚动位置的亚像素误差会让差值停在 0 附近
    container.classList.toggle(TAGS_FADE_LEFT_CLASS, container.scrollLeft > 1);
    const moreOnRight = container.scrollWidth - container.clientWidth - container.scrollLeft > 1;
    container.classList.toggle(TAGS_FADE_RIGHT_CLASS, moreOnRight);
}

function bindTagsScroll(container) {
    if (!container || tagsScrollBound) return;
    tagsScrollBound = true;

    // 滚轮纵向滚动这一行：指针停在标签上滚，横向跟着走（标签栏同款做法）。
    // 标签没排满时不动它，把滚轮留给页面自己的滚动
    container.addEventListener('wheel', (e) => {
        if (container.scrollWidth <= container.clientWidth) return;
        e.preventDefault();
        container.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
    }, { passive: false });

    container.addEventListener('scroll', () => updateTagsFade(container), { passive: true });
    // 容器被整条收起时（编辑器未打开）尺寸归零，这里跟着算出「两侧都没有内容」并摘掉类名
    new ResizeObserver(() => updateTagsFade(container)).observe(container);
}

// 标签页的落点随布局走：经典布局在标题栏里（#titlebar-tabs），现代布局在工作区顶部那一行
// （#workspace-tabs，见 main.html 与 styles/mode.css）。两个容器都在，渲染时只往当前布局的那个里写
const TAB_CONTAINER_IDS = ['titlebar-tabs', 'workspace-tabs'];

function tabsContainerId() {
    return isModernLayout() ? 'workspace-tabs' : 'titlebar-tabs';
}

// 此刻栏里已经有的标签 id：两个容器都收——重画只写当前布局的那一个，而切布局时新栏里是空的，
// 只比对当前栏会把整排标签都错当成新开的（见 renderTabs 里挂 tabSlideIn 的那一处）
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

/* 标签栏两端的渐隐：标签排不下时两端淡出去，替藏起来的滚动条把「还能往哪边滚」提示出来
   （样式只对现代布局的标签栏生效，见 styles/mode.css）。
   两个类名只在对应的那一侧「确实还有被截断的标签」时挂上——标签根本没排满、
   或已经滚到那一端时摘掉，否则最边上的标签会被白白削掉一角。
   判定要跟着滚动位置与容器宽度走；宽度不只由窗口决定，AI 面板开合、侧边栏收起、
   切布局都会改动它（见 styles/mode.css 里那几条 margin-right），因此宽度一侧交给
   ResizeObserver 一并接住，省得在那些地方各补一次调用。 */
const TABS_FADE_RIGHT_CLASS = 'tabs-fade-right';
const TABS_FADE_LEFT_CLASS = 'tabs-fade-left';
// 新开标签的滑入类名（样式见 styles/motion.css 的 tabSlideIn）：只挂在这一下新冒出来的那个上
const TAB_SLIDE_IN_CLASS = 'is-sliding-in';
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
        // 加密状态（含本轮是否已解锁）跟着进签名：上锁 / 解锁后标题没变，图标也要换
        const secret = item && item.locked === true ? (item.unlocked === true ? 2 : 1) : 0;
        return `${id}\u0002${item ? (item.title || '') : ''}\u0002${secret}`;
    }).join('\u0001')}`;
    if (renderSignatures.tabs === signature) return;
    renderSignatures.tabs = signature;

    // 拖动排序途中若被别处触发的重画打断（例如自动保存顺手 renderApp），先收掉拖动状态：
    // 下面的 innerHTML 会把被拖的元素换成新的，留着的摆位与落位逻辑就对不上了
    if (tabsDrag) stopTabsDrag();

    // 重画之前把栏里已有的标签收一份：建完对不上的就是这一下新开出来的（见下面挂的滑入）
    const knownTabIds = renderedTabIds();
    // 这一次重画里有没有新标签：它和补空位是冲突的（见 applyTabCloseShift）
    let openedTab = false;

    tabsContainer.innerHTML = '';

    State.openNoteIds.forEach(id => {
        const isActive = id === State.activeNoteId;
        const tab = document.createElement('div');
        tab.className = `tab-item ${isActive ? 'active' : ''}`;
        // 拖动排序后要按 DOM 的实际顺序回写 State.openNoteIds，标签得记住自己是谁
        tab.dataset.tabId = id;
        // 刚刚开出来的那个从左边滑进来（样式见 styles/motion.css），
        // 同一个 id 重新打开也算——栏里那会儿已经没有它了
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
            // 笔记与待办共用标签栏，用图标区分类型；加密条目另带一个锁形标记
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
            // 拖动落位后紧跟的那一次 click 忽略掉：此时指针正好在被拖的标签上，
            // 不拦的话「拖一下就把这个标签置为当前」，与浏览器标签栏的行为不一致
            if (tabsDragSwallowClick) {
                tabsDragSwallowClick = false;
                return;
            }
            State.activeNoteId = id;
            renderApp();
        });

        // 拖动排序：按住左键横向拖动即换位（见下面的「标签栏的拖动排序」）。
        // 与点击共用同一套事件，位移超过阈值才当成拖动，因此点击切标签不受影响
        tab.addEventListener('pointerdown', (event) => {
            // 只认左键（中键留给「关闭标签」）；点在关闭按钮上也不该开始拖
            if (event.button !== 0) return;
            if (event.target.closest('.tab-close-btn')) return;
            startTabsDrag(event, tab);
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

    // 刚关掉一个标签的话，先把它右边那些被重画提前挪过去的标签摆回原位：它们要等标签
    // 飞走了才补位，补位的过程就挂在这一次摆位上（见上面的「关闭标签的两段动效」）
    applyTabCloseShift(openedTab);

    // 标签全部挂完后判定一次：新建标签、关标签、切布局都要重新看右端还需不需要淡
    // （读 scrollWidth 会强制同步一次布局，这里拿到的就是刚排好的宽度）
    updateTabsFade(tabsContainer);
}

/* ---------------- 关闭标签的两段动效 ----------------

   关掉一个标签是连着两下的：先让被关的那个整块退场，等它走开，右边的标签再滑过去把空位
   补上。两段都由 notes.js 的 closeTab 触发——关闭的入口都收在那一个函数里，而它总是先于
   renderApp 被调用，此刻标签还在栏里、位置还量得出来。

   —— 第一段：退场 ——

   常规是向上滑出窗口上沿；关掉的若是栏里仅剩的那一个标签（关完标签栏就空了，向上飞
   没有下文），换成向左滑走。

   标签是整段重建出来的（上面 renderTabs 里的 innerHTML = ''），被关掉的那个节点一换掉
   就没有播动画的机会，所以要在重画之前先把它的样子「复印」一份出来。

   复印件挂在 body 上，而不是留在标签栏里：标签栏是 overflow 裁剪的（两端渐隐、横向滚动
   都依赖它），留在原地只能看见标签被栏口切掉一块，看不出「滑走」。复印件用固定定位摆在
   与原标签逐像素重合的位置、沿用原标签量出来的尺寸，因此长相与它一模一样，又不受任何
   裁剪约束，可以一直滑到窗口上沿之外或向左滑走（动画本身在 styles/motion.css）。

   —— 第二段：补空位 ——

   重画是按新排布建的，空位在那一刻就已经合上了，容不下「先停一下再补」。因此关标签时
   顺手记下每个标签当时的位置，重画之后把因此左移的那些先平移回原位，等第一段走完再
   放进过渡滑到新位置——空位于是能一直撑到标签退场（见 applyTabCloseShift）。 */

// 两段动效的时长，与 tokens.css 的 --motion-slow / --motion-base 同档。样式那边只管
// 「怎么动」，这里要用数值排出先后（第二段延迟多久起步），并算出兜底收尾的时刻
const TAB_FLY_DURATION_MS = 260;
const TAB_SHIFT_DURATION_MS = 180;
// 兜底收尾的余量：正常路径靠 animationend 与过渡自己走完，这一条只防「动画被节流、
// 事件没送到」而把残影或错位留在界面上
const TAB_ANIM_SLACK_MS = 140;
// 滑出窗口上沿后再多走一点，免得正好停在边界上看着像「没走干净」
const TAB_FLY_OVERSHOOT = 12;
// 两种退场方式（样式见 styles/motion.css）：常规的整块滑出窗口上沿；关掉的若是栏里
// 仅剩的那一个（关完标签栏就空了）则改往左滑走——它右边没有标签来补位，向上飞没下文
const TAB_FLY_UP_CLASS = 'is-flying-up';
const TAB_FLY_LEFT_CLASS = 'is-flying-left';

// 关标签时留下的那份排布：紧接着的那次标签栏重建据此补空位，用完即弃
let tabCloseShift = null;

function playTabCloseFlyAway(tabId) {
    const tabsContainer = document.getElementById(tabsContainerId());
    if (!tabsContainer) return;
    // 只在当前布局的这一栏里找：另一个容器是空的（见 tabsContainerId 的说明）
    const tabs = Array.from(tabsContainer.children);
    const tab = tabs.find(el => el.dataset.tabId === tabId);
    if (!tab) return;
    // 关的是栏里仅剩的那一个：标签个数按当前这一栏数，与用户看到的那一排一致
    const isOnlyTab = tabs.length === 1;

    /* 位置必须趁动 DOM 之前一次量完：摘掉这个标签会让右半边当场合上来，之后再量拿到的
       就是「已经补过位」的坐标，算不出任何位移，补空位那一步于是什么都不做
       （这份记录给 applyTabCloseShift 用）。所以先量、再摘。 */
    const rect = tab.getBoundingClientRect();
    const lefts = new Map(tabs.filter(el => el.dataset.tabId)
        .map(el => [el.dataset.tabId, el.getBoundingClientRect().left]));

    const ghost = tab.cloneNode(true);
    // 复印件是新的一份、会从头重播它身上的动画类（新标签的滑入就是其中一个）：先摘掉，
    // 飞出去那支动画才轮得到
    ghost.classList.remove(TAB_SLIDE_IN_CLASS);
    // 先摘掉栏里那个：随后的 renderApp 反正会重建整栏，这样即便某条关闭路径漏了重画，
    // 也不会出现两个一样的标签
    tab.remove();

    // 系统开启「减少动态效果」时直接收场：样式那边虽然也会把动画关掉，但那样元素要等
    // 兜底计时器才消失，不如根本不生成。第二段一并省掉——整条链路都属于动效
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // 量不出尺寸说明标签栏正被收起（一个标签都没有，或设置里禁用了标签页），不必摆这一下
    if (!rect.width || !rect.height) return;

    // 记下这份排布：紧接着的那次重建据此把右边的标签摆回原位，等飞出去的走完再补空位
    // （记录里也有被关掉的那个，它在新排布里已经不存在，对不上就跳过）
    tabCloseShift = { at: performance.now(), lefts };

    ghost.classList.add(isOnlyTab ? TAB_FLY_LEFT_CLASS : TAB_FLY_UP_CLASS);
    /* 坐标以谁为参照，两条路不一样：
       向上飞的那一份直接挂 body，量到的视口坐标就是它要的，参照点因此取视口原点；
       往左滑的那一份夹进与标签栏等大的裁剪框里（见 buildTabFlyClip），得换算成相对
       标签栏左上角的偏移。参照点弄错的话，复印件会被摆到窗口左上角去。 */
    const barRect = isOnlyTab ? tabsContainer.getBoundingClientRect() : { left: 0, top: 0 };
    const clip = isOnlyTab ? buildTabFlyClip(barRect) : null;
    const originLeft = rect.left - barRect.left;
    const originTop = rect.top - barRect.top;
    ghost.style.left = `${originLeft}px`;
    ghost.style.top = `${originTop}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    if (isOnlyTab) {
        /* 滑程就是它自己那一格宽：栏里只剩它一个，左边本没有别的标签可让，这一段滑行
           会滑到栏的左端之外——超出部分由裁剪框直接不画，不会飘到栏外面去 */
        ghost.style.setProperty('--tab-slide-distance', `${rect.width}px`);
    } else {
        // 滑到标签顶边越过窗口上沿为止：两种布局的标签栏高度不同（现代布局的在工作区顶部），
        // 距离按量到的位置算，CSS 那边不写死
        ghost.style.setProperty('--tab-fly-distance', `${rect.top + rect.height + TAB_FLY_OVERSHOOT}px`);
    }
    (clip || document.body).appendChild(ghost);

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        // 往左滑的那一份外面还套着裁剪框，得连框一起摘掉
        (clip || ghost).remove();
    };
    ghost.addEventListener('animationend', dismiss, { once: true });
    setTimeout(dismiss, TAB_FLY_DURATION_MS + TAB_ANIM_SLACK_MS);
}

/* 往左滑的那一份复印件得留在标签栏里面，于是给它套一个与标签栏等大的裁剪框：
   复印件是固定定位的，本来不受标签栏那层 overflow 裁剪约束，不套就会飘到栏外面去
   （栏里只剩它一个时，它左侧根本没有余量）。框按量到的位置直接插在 body 上，
   尺寸给出后由调用方把复印件塞进去。 */
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

/* 关闭标签后的补空位：把刚才因为重画而提前挪过去的那些标签摆回原位，等被关的那个飞走
   之后再滑到新位置。只有确实左移了的标签需要补偿——关闭位置左边的标签本来就没动。

   由 renderTabs 在每次重建之后调用，并把「这一次重画里有没有新开的标签」交给它。
   位移用 transform：它既不改布局（标签栏的宽度、滚动位置都跟着这一次重画走，不必救），
   也不改命中区域（指针看到哪儿就点到哪儿）。

   这一段用 Web Animations 而不是 CSS 过渡：停住的那一段也要交给动画自己。关键帧的起点
   是明写的，节点刚建出来就直接落在正确位置上；换成 CSS 过渡就得先写一次 transform 当
   起点、再强制刷一次布局把它定下来（过渡只看「变化之前的样子」，那份样式没被计算过就
   补间不起来），一不小心标签就瞬移到位、只剩下复印件在那儿飞。 */
function applyTabCloseShift(hasNewTab) {
    const shift = tabCloseShift;
    tabCloseShift = null;
    if (!shift) return;
    // 同一次重画里又关又开：新标签要占的正是那块空位，撑住它只会让新标签和右移的那些
    // 叠在一起，直接按最终排布落位（新标签自己的滑入照旧）
    if (hasNewTab) return;
    // 关标签那条路上的重画都发生在同一个任务里（见 notes.js 的 closeTab），隔了这么久
    // 说明这一次重建与它无关，记下的位置早已不作数
    if (performance.now() - shift.at > 250) return;

    const tabsContainer = document.getElementById(tabsContainerId());
    if (!tabsContainer) return;

    // 缓动沿用样式里的 --ease-out：动效改由 JS 排，曲线仍归 tokens.css 说了算
    const easing = tabShiftEasing();
    const shifts = [];
    tabsContainer.querySelectorAll('.tab-item').forEach(el => {
        const from = shift.lefts.get(el.dataset.tabId);
        if (from === undefined) return;
        const distance = from - el.getBoundingClientRect().left;
        // 没挪动（关闭位置左边的标签，或者挪动量小到看不出来）就不补偿。留 1px 容差是因为
        // 排布上的小数差、以及「滚到底时关标签」（内容变短，容器跟着回滚，新旧位置正好抵掉）
        // 都会算出零头，不值得白挂一层动画
        if (distance < 1) return;
        shifts.push(el.animate(
            [{ transform: `translateX(${distance}px)` }, { transform: 'translateX(0)' }],
            {
                duration: TAB_SHIFT_DURATION_MS,
                // 延迟就是第一段的时长：标签在原地停到复印件飞走，这才起步补位。
                // fill: 'both' 让它在延迟这段时间里也按起点摆着，空位因此一直撑得住
                delay: TAB_FLY_DURATION_MS,
                easing,
                fill: 'both'
            }
        ));
    });
    if (!shifts.length) return;

    // 收尾即撤掉动画：终点就是元素本来的样子，撤掉前后看不出差别，界面上却少背一层
    // 动画效果（悬停底色一类的过渡也跟着回来）
    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        shifts.forEach(shiftAnim => {
            shiftAnim.onfinish = null;
            shiftAnim.cancel();
        });
        // 顺带重新判一次两端渐隐——补位用的位移会算进 scrollWidth
        if (tabsContainer.isConnected) updateTabsFade(tabsContainer);
    };
    shifts.forEach(shiftAnim => { shiftAnim.onfinish = settle; });
    // 兜底：动画没跑完（窗口被隐藏时会被节流）也要把效果撤掉
    setTimeout(settle, TAB_FLY_DURATION_MS + TAB_SHIFT_DURATION_MS + TAB_ANIM_SLACK_MS);
}

// 补位用的缓动曲线（见 applyTabCloseShift）：令牌被改成 animate 认不出的写法时退回字面量，
// 免得在这里抛错、把关闭标签这条路上的重画带崩
function tabShiftEasing() {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim();
    return /^cubic-bezier\(/.test(value) ? value : 'cubic-bezier(0.22, 0.61, 0.36, 1)';
}

/* ---------------- 标签栏的拖动排序 ----------------
   按住标签左右拖动，标签跟着指针走，松手后按落定的位置重排标签栏——顺序就是
   State.openNoteIds 的顺序，与 Ctrl+Tab 的切换次序同源（两个容器都适用）。

   用指针事件而不是 HTML5 拖放：标签要连续跟手，且拖动中会真的把节点插到新位置，
   这样「空位」由标签自己占着、其余标签跟着让位，观感与浏览器标签栏一致。
   与点击共用同一套事件：位移超过 TAB_DRAG_THRESHOLD 才算拖动，否则照旧当成切标签。 */

// 位移超过这么多像素才算拖动：按下时手抖一下不该变成拖动
const TAB_DRAG_THRESHOLD = 4;
// 指针进入标签栏两端这么多像素内开始自动横向滚动（标签多到一屏放不下时用得上）
const TAB_DRAG_EDGE = 28;
// 自动滚动每帧推进的像素
const TAB_DRAG_SCROLL_STEP = 8;

// 拖动状态：同一时刻只可能有一个标签在被拖，因此整体只留这一份
let tabsDrag = null;
// 自动滚动的 rAF 句柄
let tabsDragFrame = 0;
// 刚拖完的那一下 click 要吞掉（见 renderTabs 里的 click 处理）；
// 每次 pointerdown 都重置，即使某次 click 没发生也不会一直卡住
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
        // 抓取点在标签内的偏移：拖动中标签的左边缘始终摆在「指针位置 - 这个偏移」上
        grabOffset: event.clientX - rect.left,
        startX: event.clientX,
        startY: event.clientY,
        pointerX: event.clientX,
        moved: false,
        // 自动滚动的方向：-1 向左、1 向右、0 不滚
        edgeDir: 0
    };

    window.addEventListener('pointermove', onTabsDragMove);
    window.addEventListener('pointerup', onTabsDragEnd);
    window.addEventListener('pointercancel', onTabsDragCancel);
    // 在窗口外松开鼠标收不到 pointerup：失焦同样按取消处理，免得留个拖到一半的标签
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
        // 整条标签栏一起换成抓手光标：指针掠过别的标签时不该又变回小手
        tabsDrag.container.classList.add('is-dragging');
    }
    event.preventDefault();
    tabsDrag.pointerX = event.clientX;

    updateTabsAutoScroll();
    moveDraggedTab();
    placeDraggedTab();
}

// 指针落在标签栏两端时开始（或继续）自动滚动
function updateTabsAutoScroll() {
    const { container, pointerX } = tabsDrag;
    const rect = container.getBoundingClientRect();
    const maxScroll = container.scrollWidth - container.clientWidth;
    // 已经滚到那一端就不必再滚，否则指针停在边缘会一直空转
    let dir = 0;
    if (pointerX < rect.left + TAB_DRAG_EDGE && container.scrollLeft > 0) dir = -1;
    else if (pointerX > rect.right - TAB_DRAG_EDGE && container.scrollLeft < maxScroll - 1) dir = 1;
    if (dir === tabsDrag.edgeDir) return;
    tabsDrag.edgeDir = dir;
    if (dir) scheduleTabsAutoScroll();
}

/* 自动滚动用 rAF 循环推进，而不是跟着 pointermove 走：指针停在边缘不动时不会再有
   pointermove，只有循环才能把被挡住的那几个标签一直滚出来。每帧滚一小段后重新
   排位、重新摆位，被拖标签因此始终跟着指针。 */
function scheduleTabsAutoScroll() {
    if (tabsDragFrame) return;
    tabsDragFrame = requestAnimationFrame(() => {
        tabsDragFrame = 0;
        if (!tabsDrag || !tabsDrag.edgeDir) return;
        tabsDrag.container.scrollLeft += tabsDrag.edgeDir * TAB_DRAG_SCROLL_STEP;
        moveDraggedTab();
        placeDraggedTab();
        // 滚到那一端后方向会归零，循环随之停下
        updateTabsAutoScroll();
        if (tabsDrag && tabsDrag.edgeDir) scheduleTabsAutoScroll();
    });
}

/* 把被拖标签插到指针落点上：找出第一个「中心仍在指针右侧」的标签，插到它前面；
   没有这样的标签就排到最后。每次跨过一个邻居才换一次位，落点因此稳定不抖。
   已经在目标位置时不动它——反复搬动同一个节点会让其余标签来回跳。 */
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

// 让被拖标签的左边缘跟着指针：先清掉 transform 读一次布局位置（上一步可能刚换过位、
// 或容器刚滚过），再按新位置算偏移。标签栏里最多十来个标签，每帧这一次读写可以忽略
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
        // 没到阈值：这一下是点击，切标签交给 click 那条路
        stopTabsDrag();
        return;
    }

    // 拖动中 DOM 已经排成了最终顺序，直接按它回写状态即可
    State.openNoteIds = Array.from(container.querySelectorAll('.tab-item'))
        .map(el => el.dataset.tabId)
        .filter(id => id);
    tabsDragSwallowClick = true;
    stopTabsDrag();
    // 手动换过位的 DOM 与状态已经一致，重画一次让标签与渐隐都回到干净状态
    forceRenderTabs();
}

// 取消（指针被系统打断、窗口失焦）：顺序原样恢复
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

// 拖动排序全程没碰状态、签名自然没变，重画前先把签名清掉，否则会被当成「没变化」跳过
function forceRenderTabs() {
    renderSignatures.tabs = null;
    renderTabs();
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
    // 加密且未解锁的条目没有明文可展示：给一句固定文案，不把密文信封当成摘要
    if (isSecretLocked(item)) return '已加密的正文';

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
        syncSyncServerSettingsUI();
        syncUiModeUI();
        syncUpdateSettingsUI();
        applyAiPanelVisibility();
        // 随口记：设置页也要收摊（聆听中进设置页时不能继续把结果插到旧条目上），
        // 并刷新识别语言与本机组件状态
        syncVoiceEntry(null);
        syncVoiceSettingsUI();
        // 秘密本：隐藏与加密状态可能刚在别处改过，进设置页时重扫一遍
        syncSecretSettingsUI();
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
        updateAiScopeOptions();
        // 随口记没有可插入的落点时收起入口与聆听条
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
        // 加密且未解锁的条目：正文取出来的是密文信封，不往编辑器里放（由锁面板接手）
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
        // 标签换了一批：两侧的渐隐要重新判（条数变少后右端可能不必再淡）
        updateTagsFade(tagsContainer);
    }
    // 滚动与两端渐隐的监听只需绑一次，余下的宽度变化由 ResizeObserver 接住
    bindTagsScroll(tagsContainer);

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
    // 加密条目：编辑区盖上锁面板，解锁按钮就摆在那里
    applySecretLockUI(item);
    renderMarkdown();
    updateStats();
    updateViewModeUI();
    // 条目切换 / 只读状态变化后同步随口记的入口（聆听中切走条目会就此收摊）
    syncVoiceEntry(item);
    // 切换条目后，AI 面板里那条下拉的「附带当前笔记：<笔记名>」要跟着变
    updateAiScopeOptions();
}
