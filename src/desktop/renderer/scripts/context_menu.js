let contextItemId = null;

const MENU_SEPARATOR = { type: 'separator' };

function appendMenuGroup(items, entries) {
    const group = entries.filter(entry => !!entry);
    if (!group.length) return;
    if (items.length) items.push(MENU_SEPARATOR);
    items.push(...group);
}

function contextMenuItems(item) {
    const label = itemKindLabel(item);

    if (item.isTrashed) {
        const items = [
            { action: 'open', icon: 'external-link', label: '在标签页打开' }
        ];

        appendMenuGroup(items, [
            { action: 'restore', icon: 'undo-2', label: `恢复${label}` },
            { action: 'export', icon: 'download', label: '导出 Markdown' }
        ]);

        appendMenuGroup(items, [
            isSharedItem(item)
                ? { action: 'leave-share', icon: 'unlink', label: '退出共享', danger: true }
                : { action: 'purge', icon: 'trash', label: '彻底删除', danger: true }
        ]);

        return items;
    }

    const items = [
        { action: 'open', icon: 'external-link', label: '在标签页打开' }
    ];

    appendMenuGroup(items, [
        isTodoItem(item) ? {
            action: 'toggle-done',
            icon: item.isDone ? 'square' : 'circle-check',
            label: item.isDone ? '标记为未完成' : '标记为已完成'
        } : null,
        {
            action: 'pin',
            icon: item.isPinned ? 'pin-off' : 'pin',
            label: item.isPinned ? '取消置顶' : `置顶${label}`
        },
        { action: 'stick', icon: 'pin', label: '贴到桌面' }
    ]);

    if (isSharedItem(item)) {
        appendMenuGroup(items, [
            { action: 'export', icon: 'download', label: '导出 Markdown' }
        ]);
        appendMenuGroup(items, [
            { action: 'leave-share', icon: 'unlink', label: '退出共享', danger: true }
        ]);
        return items;
    }

    appendMenuGroup(items, [
        {
            action: 'hide',
            icon: item.isHidden === true ? 'eye' : 'eye-off',
            label: item.isHidden === true ? '取消隐藏' : '隐藏文档'
        },
        {
            action: item.locked === true ? 'remove-password' : 'set-password',
            icon: item.locked === true ? 'key-round' : 'lock',
            label: item.locked === true ? '解除密码' : '设置密码'
        },
        item.locked === true && item.unlocked === true
            ? { action: 'lock-now', icon: 'lock', label: '立即锁定' }
            : null
    ]);

    appendMenuGroup(items, [
        !isTodoItem(item) && !isSecretItem(item)
            ? { action: 'share', icon: 'share-2', label: '共享…' }
            : null,
        { action: 'export', icon: 'download', label: '导出 Markdown' }
    ]);

    appendMenuGroup(items, [
        { action: 'delete', icon: 'trash-2', label: '移入废纸篓', danger: true }
    ]);

    return items;
}

function fillContextMenu(menu, entries) {
    menu.innerHTML = '';
    entries.forEach(entry => {
        if (entry.type === 'separator') {
            const line = document.createElement('div');
            line.className = 'context-menu-separator';
            menu.appendChild(line);
            return;
        }

        const el = document.createElement('div');
        el.className = `context-menu-item${entry.danger ? ' danger' : ''}`;
        el.dataset.action = entry.action;

        const icon = document.createElement('span');
        icon.className = 'icon sm';
        setLucideIcon(icon, entry.icon);

        const text = document.createElement('span');
        text.textContent = entry.label;

        el.append(icon, text);
        menu.appendChild(el);
    });
}

function showContextMenu(x, y, itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    hideFolderContextMenu();
    hideContextMenu();
    contextItemId = itemId;

    const entries = contextMenuItems(item);
    if (nativeMenuBridge.isMac) {
        nativeMenuBridge.popup(entries).then((action) => {
            if (!action || contextItemId !== itemId) return;
            runContextMenuAction(action);
        });
        return;
    }

    const menu = document.getElementById('note-context-menu');
    fillContextMenu(menu, entries);

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

function runContextMenuAction(action) {
    const itemId = contextItemId;
    if (!itemId) return;
    if (action === 'open') {
        openTab(itemId);
        renderApp();
    } else if (action === 'toggle-done') {
        toggleTodoDone(itemId);
    } else if (action === 'pin') {
        togglePin(itemId);
    } else if (action === 'stick') {
        stickItemToDesktop(itemId);
    } else if (action === 'hide') {
        toggleItemHidden(itemId);
    } else if (action === 'set-password') {
        setItemPassword(itemId);
    } else if (action === 'remove-password') {
        removeItemPassword(itemId);
    } else if (action === 'lock-now') {
        lockItemNow(itemId);
    } else if (action === 'share') {
        shareNoteFromMenu(itemId);
    } else if (action === 'leave-share') {
        leaveSharedNoteFromMenu(itemId);
    } else if (action === 'export') {
        exportItemMarkdown(itemId);
    } else if (action === 'delete') {
        moveToTrash(itemId);
    } else if (action === 'restore') {
        restoreFromTrash(itemId);
    } else if (action === 'purge') {
        purgeItem(itemId);
    }
}

document.getElementById('note-context-menu').onclick = (e) => {
    const target = e.target.closest('[data-action]');
    if (!target || !contextItemId) return;
    runContextMenuAction(target.getAttribute('data-action'));
    hideContextMenu();
};

function folderContextMenuItems() {
    return [
        { action: 'rename-folder', icon: 'pencil', label: '重命名文件夹' },
        { type: 'separator' },
        { action: 'delete-folder', icon: 'trash-2', label: '删除文件夹', danger: true }
    ];
}

function showFolderContextMenu(x, y, folder) {
    if (folder === '默认') return;
    hideContextMenu();
    hideFolderContextMenu();

    const entries = folderContextMenuItems();
    if (nativeMenuBridge.isMac) {
        nativeMenuBridge.popup(entries).then((action) => {
            if (action === 'rename-folder') renameFolder(folder);
            else if (action === 'delete-folder') deleteFolder(folder);
        });
        return;
    }

    const menu = document.getElementById('folder-context-menu');
    fillContextMenu(menu, entries);

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

window.addEventListener('click', (e) => {
    if (!e.target.closest('#note-context-menu')) hideContextMenu();
    if (!e.target.closest('#folder-context-menu')) hideFolderContextMenu();

    if (!e.target.closest('#sticky-notes-menu') && !e.target.closest('#btn-sticky-notes')) {
        if (typeof hideStickyMenu === 'function') hideStickyMenu();
    }
});
