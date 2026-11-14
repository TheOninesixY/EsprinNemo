let contextItemId = null;

function contextMenuItems(item) {
    const label = itemKindLabel(item);

    if (item.isTrashed) {
        const items = [
            { action: 'open', icon: 'open_in_new', label: '在标签页打开' },
            { action: 'restore', icon: 'restore_from_trash', label: `恢复${label}` },
            { action: 'export', icon: 'file_download', label: '导出 Markdown' }
        ];

        if (isSharedItem(item)) {
            items.push({ action: 'leave-share', icon: 'link_off', label: '退出共享', danger: true });
        } else {
            items.push({ action: 'purge', icon: 'delete_forever', label: '彻底删除', danger: true });
        }
        return items;
    }

    const items = [
        { action: 'open', icon: 'open_in_new', label: '在标签页打开' }
    ];

if (isTodoItem(item)) {
        items.push({
            action: 'toggle-done',
            icon: item.isDone ? 'check_box_outline_blank' : 'check_circle',
            label: item.isDone ? '标记为未完成' : '标记为已完成'
        });
    }

    items.push({
        action: 'pin',
        icon: item.isPinned ? 'keep_off' : 'push_pin',
        label: item.isPinned ? '取消置顶' : `置顶${label}`
    });

items.push({ action: 'stick', icon: 'keep', label: '贴到桌面' });

if (isSharedItem(item)) {
        items.push(
            { action: 'export', icon: 'file_download', label: '导出 Markdown' },
            { action: 'leave-share', icon: 'link_off', label: '退出共享', danger: true }
        );
        return items;
    }

    items.push(

        {
            action: 'hide',
            icon: item.isHidden === true ? 'visibility' : 'visibility_off',
            label: item.isHidden === true ? '取消隐藏' : '隐藏文档'
        },
        {
            action: item.locked === true ? 'remove-password' : 'set-password',
            icon: item.locked === true ? 'key_off' : 'lock',
            label: item.locked === true ? '解除密码' : '设置密码'
        }
    );

if (item.locked === true && item.unlocked === true) {
        items.push({ action: 'lock-now', icon: 'lock', label: '立即锁定' });
    }

if (!isTodoItem(item) && !isSecretItem(item)) {
        items.push({ action: 'share', icon: 'share', label: '共享…' });
    }

    items.push(
        { action: 'export', icon: 'file_download', label: '导出 Markdown' },
        { action: 'delete', icon: 'delete', label: '移入废纸篓', danger: true }
    );

    return items;
}

function showContextMenu(x, y, itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    hideFolderContextMenu();
    contextItemId = itemId;

    const menu = document.getElementById('note-context-menu');
    menu.innerHTML = '';
    contextMenuItems(item).forEach(entry => {
        const el = document.createElement('div');
        el.className = `context-menu-item${entry.danger ? ' danger' : ''}`;
        el.dataset.action = entry.action;

        const icon = document.createElement('span');
        icon.className = 'ms-icon sm';
        icon.textContent = entry.icon;

        const label = document.createElement('span');
        label.textContent = entry.label;

        el.append(icon, label);
        menu.appendChild(el);
    });

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');

const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

function hideContextMenu() {
    document.getElementById('note-context-menu').classList.add('hidden');
}

document.getElementById('note-context-menu').onclick = (e) => {
    const target = e.target.closest('[data-action]');
    if (!target || !contextItemId) return;
    const action = target.getAttribute('data-action');
    if (action === 'open') {
        openTab(contextItemId);
        renderApp();
    } else if (action === 'toggle-done') {
        toggleTodoDone(contextItemId);
    } else if (action === 'pin') {
        togglePin(contextItemId);
    } else if (action === 'stick') {
        stickItemToDesktop(contextItemId);
    } else if (action === 'hide') {
        toggleItemHidden(contextItemId);
    } else if (action === 'set-password') {
        setItemPassword(contextItemId);
    } else if (action === 'remove-password') {
        removeItemPassword(contextItemId);
    } else if (action === 'lock-now') {
        lockItemNow(contextItemId);
    } else if (action === 'share') {
        shareNoteFromMenu(contextItemId);
    } else if (action === 'leave-share') {
        leaveSharedNoteFromMenu(contextItemId);
    } else if (action === 'export') {
        exportItemMarkdown(contextItemId);
    } else if (action === 'delete') {
        moveToTrash(contextItemId);
    } else if (action === 'restore') {
        restoreFromTrash(contextItemId);
    } else if (action === 'purge') {
        purgeItem(contextItemId);
    }
    hideContextMenu();
};

function showFolderContextMenu(x, y, folder) {
    if (folder === '默认') return;
    hideContextMenu();

    const menu = document.getElementById('folder-context-menu');
    menu.innerHTML = '';
    [
        { action: 'rename-folder', icon: 'edit', label: '重命名文件夹' },
        { action: 'delete-folder', icon: 'delete', label: '删除文件夹', danger: true }
    ].forEach(entry => {
        const el = document.createElement('div');
        el.className = `context-menu-item${entry.danger ? ' danger' : ''}`;
        el.dataset.action = entry.action;

        const icon = document.createElement('span');
        icon.className = 'ms-icon sm';
        icon.textContent = entry.icon;

        const label = document.createElement('span');
        label.textContent = entry.label;

        el.append(icon, label);
        menu.appendChild(el);
    });

    menu.dataset.folder = folder;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');

    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

function hideFolderContextMenu() {
    document.getElementById('folder-context-menu').classList.add('hidden');
}

document.getElementById('folder-context-menu').onclick = (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const folder = e.currentTarget.dataset.folder;
    const action = target.getAttribute('data-action');
    hideFolderContextMenu();
    if (!folder) return;
    if (action === 'rename-folder') renameFolder(folder);
    else if (action === 'delete-folder') deleteFolder(folder);
};

const NEW_ITEM_ACTIONS = [
    { action: 'new-note', icon: 'description', label: '新建笔记' },
    { action: 'new-todo', icon: 'check_box', label: '新建待办' },
    { action: 'import-note', icon: 'file_upload', label: '导入文件' }
];

function showNewItemMenu(anchor) {
    const menu = document.getElementById('new-item-menu');
    menu.innerHTML = '';

    NEW_ITEM_ACTIONS.forEach(entry => {

        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'dropdown-option';
        el.dataset.action = entry.action;

        const icon = document.createElement('span');
        icon.className = 'ms-icon sm';
        icon.textContent = entry.icon;

        const label = document.createElement('span');
        label.className = 'dropdown-option-text';
        label.textContent = entry.label;

        el.append(icon, label);
        menu.appendChild(el);
    });

    const rect = anchor ? anchor.getBoundingClientRect() : null;
    const x = rect ? rect.left : 8;
    const y = rect ? rect.bottom + 4 : 8;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');

    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menuRect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menuRect.height - 4))}px`;
}

function hideNewItemMenu() {
    document.getElementById('new-item-menu').classList.add('hidden');
}

function toggleNewItemMenu(anchor) {
    const menu = document.getElementById('new-item-menu');
    if (menu.classList.contains('hidden')) showNewItemMenu(anchor);
    else hideNewItemMenu();
}

document.getElementById('new-item-menu').onclick = (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    hideNewItemMenu();
    if (action === 'new-note') createNewNote();
    else if (action === 'new-todo') createNewTodo();
    else if (action === 'import-note') importNoteFiles();
};

window.addEventListener('click', (e) => {
    if (!e.target.closest('#note-context-menu')) hideContextMenu();
    if (!e.target.closest('#folder-context-menu')) hideFolderContextMenu();

    if (!e.target.closest('#sticky-notes-menu') && !e.target.closest('#btn-sticky-notes')) {
        if (typeof hideStickyMenu === 'function') hideStickyMenu();
    }
    const isNewMenuTrigger = !!e.target.closest('#btn-empty-new');
    if (!e.target.closest('#new-item-menu') && !isNewMenuTrigger) {
        hideNewItemMenu();
    }
});
