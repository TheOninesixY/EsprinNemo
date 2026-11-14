function applyUiMode() {
    const root = document.documentElement;
    root.classList.add(MODERN_LAYOUT_CLASS);
    root.classList.toggle(TABS_DISABLED_CLASS, isTabsDisabled());
    syncNewButtonTitles();
}

function syncNewButtonTitles() {
    const newBtn = document.getElementById('btn-new-item');
    if (!newBtn) return;
    newBtn.title = State.currentFilter === 'todos'
        ? '新建待办 (Ctrl+Shift+N)'
        : '新建笔记 (Ctrl+N)';
}

function toggleTabsDisabled(disabled) {
    const next = !!disabled;
    if (next === State.tabsDisabled) return;

    State.tabsDisabled = next;
    applyUiMode();
    saveConfig();

    showToast(next ? '标签页已禁用：整条收起，列表里照旧能切条目' : '标签页已恢复');
}

function applySidebarBlur() {
    const root = document.documentElement;
    root.classList.toggle(SIDEBAR_BLUR_OFF_CLASS, State.sidebarBlur === false);
}

function toggleSidebarBlur(enabled) {
    const next = enabled !== false;
    if (next === (State.sidebarBlur !== false)) return;

    State.sidebarBlur = next;
    applySidebarBlur();
    saveConfig();

    showToast(next ? '侧边栏与列表已启用毛玻璃' : '侧边栏与列表已改为不透明背景');
}

function syncUiModeUI() {
    const tabsToggle = document.getElementById('setting-tabs-disabled');
    if (tabsToggle) tabsToggle.checked = State.tabsDisabled;

    const blurToggle = document.getElementById('setting-sidebar-blur');
    if (blurToggle) blurToggle.checked = State.sidebarBlur !== false;
}

function initUiMode() {
    const tabsToggle = document.getElementById('setting-tabs-disabled');
    if (tabsToggle) tabsToggle.onchange = (event) => toggleTabsDisabled(event.target.checked);

    const blurToggle = document.getElementById('setting-sidebar-blur');
    if (blurToggle) blurToggle.onchange = (event) => toggleSidebarBlur(event.target.checked);

    applyUiMode();
    applySidebarBlur();
    syncUiModeUI();
}
