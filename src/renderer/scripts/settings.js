/* 设置视图的分类导航：侧边栏条目与内容面板按 id 一一对应 */

// 设置分类：侧边栏条目与内容面板（data-settings-panel）按 id 一一对应。
// 只按「用户想改什么」分五大类，面板内部再用 .settings-section 细分，避免左侧目录过长：
//   · 字体、界面布局原本各自独立，现都收进「外观」（它们改的都是观感）
//   · 更新与版本并进「系统」（它属于系统级行为，且便携版整块摘掉更简单）
// 便携版没有更新功能：分类本身保留，由 scripts/update.js 把面板里的更新分区摘掉。
// desc 是切到这个分类时写在设置页顶端的一句话，说明这一类管什么
const SETTINGS_CATEGORIES = [
    { id: 'editor', label: '编辑器', icon: 'edit_note', desc: '拼写检查、随口记（语音转文本）与废纸篓的清理策略' },
    { id: 'appearance', label: '外观', icon: 'palette', desc: '界面布局、缩放、主题与字体' },
    { id: 'ai', label: 'AI 助手', icon: 'chat_bubble', desc: '接口、密钥与提问上下文' },
    { id: 'secret', label: '秘密本', icon: 'lock', desc: '隐藏或已加密的文档：隐藏的条目只在这里能找到' },
    { id: 'data', label: '数据与同步', icon: 'folder', desc: '本地数据目录、文件日志与自建同步' },
    { id: 'system', label: '系统', icon: 'dock_to_bottom', desc: '开机自启、托盘、更新与版本' }
];

// 记录当前分类，退出设置再进入时仍停留在原来的一类
let activeSettingsCategory = SETTINGS_CATEGORIES[0].id;

function switchSettingsCategory(id) {
    // 记错了（例如配置文件里留着一个已不存在的分类 id）就退到第一个分类
    const category = SETTINGS_CATEGORIES.find(c => c.id === id) || SETTINGS_CATEGORIES[0];
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

    // 顶端标题换成当前分类：不必回看左侧目录，也知道现在在改哪一组
    const headerText = document.getElementById('settings-header-text');
    if (headerText) headerText.textContent = category.label;
    const headerDesc = document.getElementById('settings-header-desc');
    if (headerDesc) headerDesc.textContent = category.desc;

    // 新面板通常比上一个短，回到顶部避免留下大片空白
    const content = document.querySelector('#settings-view .settings-content');
    if (content) content.scrollTop = 0;

    // 「系统」分类里的更新区依赖主进程状态（可能已在后台检查/下载过）：每次切进来都刷一遍
    if (category.id === 'system' && typeof refreshUpdateInfo === 'function') refreshUpdateInfo();
}

function initSettingsNav() {
    const nav = document.getElementById('settings-nav');
    if (!nav) return;
    nav.innerHTML = '';

    SETTINGS_CATEGORIES.forEach((category) => {
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
