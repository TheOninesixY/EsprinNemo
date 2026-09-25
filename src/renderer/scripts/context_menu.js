/* 条目右键菜单与「新建」菜单：
   右键菜单按条目类型与状态（普通 / 废纸篓中）动态生成；
   文件夹另有一套右键菜单（重命名 / 删除），见文件末尾；
   新建菜单用于选择新建笔记、新建待办，或把本地的 .md / .txt 文件导入为笔记。 */

let contextItemId = null;

function contextMenuItems(item) {
    const label = itemKindLabel(item);

    if (item.isTrashed) {
        return [
            { action: 'open', icon: 'open_in_new', label: '在标签页打开' },
            { action: 'restore', icon: 'restore_from_trash', label: `恢复${label}` },
            { action: 'export', icon: 'file_download', label: '导出 Markdown' },
            { action: 'purge', icon: 'delete_forever', label: '彻底删除', danger: true }
        ];
    }

    const items = [
        { action: 'open', icon: 'open_in_new', label: '在标签页打开' }
    ];

    // 待办额外提供完成状态切换
    if (isTodoItem(item)) {
        items.push({
            action: 'toggle-done',
            icon: item.isDone ? 'check_box_outline_blank' : 'check_circle',
            label: item.isDone ? '标记为未完成' : '标记为已完成'
        });
    }

    items.push(
        {
            action: 'pin',
            icon: item.isPinned ? 'keep_off' : 'push_pin',
            label: item.isPinned ? '取消置顶' : `置顶${label}`
        },
        /* 秘密本：隐藏与密码。隐藏后条目不再出现在任何列表里，只能去「设置 → 秘密本」找回，
           因此这里给出的入口在隐藏后仍然留着一个「取消隐藏」的提示（列表右键菜单虽已看不到它） */
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

    // 已解锁的加密条目：再给一个马上重新上锁的入口（关闭应用同样会失去内存里的密钥）
    if (item.locked === true && item.unlocked === true) {
        items.push({ action: 'lock-now', icon: 'lock', label: '立即锁定' });
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

    // 菜单项数量随条目状态变化，显示后再校正一次位置，避免溢出窗口
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
    } else if (action === 'hide') {
        toggleItemHidden(contextItemId);
    } else if (action === 'set-password') {
        setItemPassword(contextItemId);
    } else if (action === 'remove-password') {
        removeItemPassword(contextItemId);
    } else if (action === 'lock-now') {
        lockItemNow(contextItemId);
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

/* 文件夹右键菜单：重命名与删除。
   「默认」是条目没有归属时的落脚点，既不能改名也不能删除，因此不为它开菜单 */
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
    // 文件夹名随菜单内容一起记在元素上，每次重建时覆盖
    const folder = e.currentTarget.dataset.folder;
    const action = target.getAttribute('data-action');
    hideFolderContextMenu();
    if (!folder) return;
    if (action === 'rename-folder') renameFolder(folder);
    else if (action === 'delete-folder') deleteFolder(folder);
};

/* 新建菜单：侧边栏顶部的「新建」与空状态按钮共用，用于新建笔记 / 待办，或导入现成的文件。
   外观直接复用下拉菜单（styles/dropdown.css 的 .dropdown-menu / .dropdown-option），
   这里只负责建条目与定位，不再另写一套菜单样式 */

// 菜单条目：前两项与快捷键 Ctrl+N / Ctrl+Shift+N 一一对应，末项用于导入现成的文件
const NEW_ITEM_ACTIONS = [
    { action: 'new-note', icon: 'description', label: '新建笔记' },
    { action: 'new-todo', icon: 'check_box', label: '新建待办' },
    { action: 'import-note', icon: 'file_upload', label: '导入文件' }
];

// 在触发按钮下方展开菜单（超出窗口时会自动回收到可视区内）
function showNewItemMenu(anchor) {
    const menu = document.getElementById('new-item-menu');
    menu.innerHTML = '';

    NEW_ITEM_ACTIONS.forEach(entry => {
        // 条目与下拉菜单里的选项同构：图标 + 文字
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

// 同一个按钮反复点击时在展开与收起之间切换
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

// 点击菜单以外的地方收起两个菜单；点触发按钮本身交由按钮的点击处理切换。
// 现代布局下侧边栏的「新建」不再开菜单（它自己就是「新建笔记」，见 scripts/events.js），
// 因此只有空状态那一个（以及经典布局下侧边栏那一个）算触发按钮——
// 否则空状态菜单开着时点侧边栏的「新建」，菜单赖着不收、还顺手新建了一篇
window.addEventListener('click', (e) => {
    if (!e.target.closest('#note-context-menu')) hideContextMenu();
    if (!e.target.closest('#folder-context-menu')) hideFolderContextMenu();
    const isNewMenuTrigger = !!e.target.closest('#btn-empty-new')
        || (!isModernLayout() && !!e.target.closest('#btn-new-note'));
    if (!e.target.closest('#new-item-menu') && !isNewMenuTrigger) {
        hideNewItemMenu();
    }
});
