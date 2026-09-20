/* 条目右键菜单与「新建」菜单：
   右键菜单按条目类型与状态（普通 / 废纸篓中）动态生成；
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
        { action: 'export', icon: 'file_download', label: '导出 Markdown' },
        { action: 'delete', icon: 'delete', label: '移入废纸篓', danger: true }
    );

    return items;
}

function showContextMenu(x, y, itemId) {
    const item = getItemById(itemId);
    if (!item) return;
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

// 点击菜单以外的地方收起两个菜单；点触发按钮本身交由按钮的点击处理切换
window.addEventListener('click', (e) => {
    if (!e.target.closest('#note-context-menu')) hideContextMenu();
    if (!e.target.closest('#new-item-menu') && !e.target.closest('#btn-new-note') && !e.target.closest('#btn-empty-new')) {
        hideNewItemMenu();
    }
});
