/* 笔记右键菜单：菜单项按笔记状态（普通 / 废纸篓中）动态生成 */

let contextNoteId = null;

function contextMenuItems(note) {
    if (note.isTrashed) {
        return [
            { action: 'open', icon: 'open_in_new', label: '在标签页打开' },
            { action: 'restore', icon: 'restore_from_trash', label: '恢复笔记' },
            { action: 'purge', icon: 'delete_forever', label: '彻底删除', danger: true }
        ];
    }
    return [
        { action: 'open', icon: 'open_in_new', label: '在标签页打开' },
        {
            action: 'pin',
            icon: note.isPinned ? 'keep_off' : 'push_pin',
            label: note.isPinned ? '取消置顶' : '置顶笔记'
        },
        { action: 'delete', icon: 'delete', label: '移入废纸篓', danger: true }
    ];
}

function showContextMenu(x, y, noteId) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note) return;
    contextNoteId = noteId;

    const menu = document.getElementById('note-context-menu');
    menu.innerHTML = '';
    contextMenuItems(note).forEach(item => {
        const el = document.createElement('div');
        el.className = `context-menu-item${item.danger ? ' danger' : ''}`;
        el.dataset.action = item.action;

        const icon = document.createElement('span');
        icon.className = 'ms-icon sm';
        icon.textContent = item.icon;

        const label = document.createElement('span');
        label.textContent = item.label;

        el.append(icon, label);
        menu.appendChild(el);
    });

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');

    // 菜单项数量随笔记状态变化，显示后再校正一次位置，避免溢出窗口
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

function hideContextMenu() {
    document.getElementById('note-context-menu').classList.add('hidden');
}

document.getElementById('note-context-menu').onclick = (e) => {
    const item = e.target.closest('[data-action]');
    if (!item || !contextNoteId) return;
    const action = item.getAttribute('data-action');
    if (action === 'open') {
        openTab(contextNoteId);
        renderApp();
    } else if (action === 'pin') {
        togglePin(contextNoteId);
    } else if (action === 'delete') {
        moveToTrash(contextNoteId);
    } else if (action === 'restore') {
        restoreFromTrash(contextNoteId);
    } else if (action === 'purge') {
        purgeNote(contextNoteId);
    }
    hideContextMenu();
};

window.addEventListener('click', (e) => {
    if (!e.target.closest('#note-context-menu')) hideContextMenu();
});
