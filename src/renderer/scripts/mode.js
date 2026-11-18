function applyUiMode() {
    const root = document.documentElement;
    root.classList.add(MODERN_LAYOUT_CLASS);
    syncNewButtonTitles();
}

function syncNewButtonTitles() {
    const newBtn = document.getElementById('btn-new-item');
    if (!newBtn) return;
    newBtn.title = State.currentFilter === 'todos'
        ? '新建待办 (Ctrl+Shift+N)'
        : '新建笔记 (Ctrl+N)';
}

function applySidebarBlur() {
    const root = document.documentElement;
    // 默认关闭：只有开发者选项里打开时才去掉这个类
    root.classList.toggle(SIDEBAR_BLUR_OFF_CLASS, State.sidebarBlur !== true);
}

function toggleSidebarBlur(enabled) {
    const next = enabled === true;
    if (next === (State.sidebarBlur === true)) return;

    State.sidebarBlur = next;
    applySidebarBlur();
    // 开发者选项里的开关不写入配置，只在本次运行内生效

    showToast(next ? '已开启毛玻璃效果' : '已关闭毛玻璃效果');
}

function syncUiModeUI() {
    const blurToggle = document.getElementById('setting-sidebar-blur');
    if (blurToggle) blurToggle.checked = State.sidebarBlur === true;
}

function initUiMode() {
    const blurToggle = document.getElementById('setting-sidebar-blur');
    if (blurToggle) blurToggle.onchange = (event) => toggleSidebarBlur(event.target.checked);

    applyUiMode();
    applySidebarBlur();
    syncUiModeUI();
}
