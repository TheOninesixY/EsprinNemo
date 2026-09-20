/* 设置视图的分类导航：侧边栏条目与内容面板按 id 一一对应 */

// 设置分类：侧边栏条目与内容面板（data-settings-panel）按 id 一一对应。
// 便携版没有更新功能，因此「更新与版本」一项不列出（面板由 scripts/update.js 移除）。
const SETTINGS_CATEGORIES = [
    { id: 'mode', label: '使用模式', icon: 'tune' },
    { id: 'editor', label: '编辑器与文本', icon: 'edit_note' },
    { id: 'appearance', label: '外观与主题色', icon: 'palette' },
    { id: 'fonts', label: '字体', icon: 'text_format' },
    { id: 'ai', label: 'AI 助手', icon: 'smart_toy' },
    { id: 'data', label: '数据与存储', icon: 'folder' },
    { id: 'system', label: '系统与托盘', icon: 'dock_to_bottom' },
    { id: 'update', label: '更新与版本', icon: 'system_update' }
].filter((category) => !(IS_PORTABLE_RUN && category.id === 'update'));

// 当前模式下可见的分类：极简模式里 AI 助手整体不提供，对应的设置分类也一并不列
function visibleSettingsCategories() {
    return SETTINGS_CATEGORIES.filter((category) => !(isMinimalMode() && category.id === 'ai'));
}

// 记录当前分类，退出设置再进入时仍停留在原来的一类
let activeSettingsCategory = SETTINGS_CATEGORIES[0].id;

function switchSettingsCategory(id) {
    const categories = visibleSettingsCategories();
    // 分类可能因切换使用模式而消失（例如极简模式下的 AI），此时退到第一个可见分类
    const category = categories.find(c => c.id === id) || categories[0];
    activeSettingsCategory = category.id;

    document.querySelectorAll('#settings-nav .settings-nav-item').forEach((item) => {
        const isActive = item.dataset.settingsTarget === category.id;
        item.classList.toggle('active', isActive);
        if (isActive) item.setAttribute('aria-current', 'true');
        else item.removeAttribute('aria-current');
    });

    document.querySelectorAll('#settings-view .settings-panel').forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.settingsPanel !== category.id);
    });

    // 新面板通常比上一个短，回到顶部避免留下大片空白
    const content = document.querySelector('#settings-view .settings-content');
    if (content) content.scrollTop = 0;

    // 「更新」分类的面板内容依赖主进程状态（可能已在后台检查/下载过）：每次切进来都刷一遍
    if (category.id === 'update' && typeof refreshUpdateInfo === 'function') refreshUpdateInfo();
}

function initSettingsNav() {
    const nav = document.getElementById('settings-nav');
    if (!nav) return;
    nav.innerHTML = '';

    visibleSettingsCategories().forEach((category) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'nav-item settings-nav-item';
        item.dataset.settingsTarget = category.id;
        item.innerHTML = `
            <span class="nav-item-left">
                <span class="ms-icon sm">${category.icon}</span>
                <span>${escapeHTML(category.label)}</span>
            </span>
        `;
        item.onclick = () => switchSettingsCategory(category.id);
        nav.appendChild(item);
    });

    switchSettingsCategory(activeSettingsCategory);
}
