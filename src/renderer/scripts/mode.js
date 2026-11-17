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

function applyGlassTransparent() {
    const root = document.documentElement;
    root.classList.toggle('glass-transparent', State.glassTransparent === true);
}

function toggleGlassTransparent(enabled) {
    const next = enabled === true;
    if (next === (State.glassTransparent === true)) return;

    State.glassTransparent = next;
    applyGlassTransparent();
    saveConfig();

    showToast(next ? '毛玻璃已改为直接透出背景（无模糊）' : '毛玻璃已恢复模糊');
}

function syncUiModeUI() {
    const blurToggle = document.getElementById('setting-sidebar-blur');
    if (blurToggle) blurToggle.checked = State.sidebarBlur !== false;

    const glassToggle = document.getElementById('setting-glass-transparent');
    if (glassToggle) glassToggle.checked = State.glassTransparent === true;
}

function initUiMode() {
    const blurToggle = document.getElementById('setting-sidebar-blur');
    if (blurToggle) blurToggle.onchange = (event) => toggleSidebarBlur(event.target.checked);

    const glassToggle = document.getElementById('setting-glass-transparent');
    if (glassToggle) glassToggle.onchange = (event) => toggleGlassTransparent(event.target.checked);

    applyUiMode();
    applySidebarBlur();
    applyGlassTransparent();
    syncUiModeUI();
}
