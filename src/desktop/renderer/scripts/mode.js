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

function initUiMode() {
    applyUiMode();
}
