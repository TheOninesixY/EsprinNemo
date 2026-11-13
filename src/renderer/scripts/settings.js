const SETTINGS_CATEGORIES = [
    { id: 'editor', label: '编辑器', icon: 'edit_note', desc: '拼写检查、随口记（语音转文本）与废纸篓的清理策略' },
    { id: 'appearance', label: '外观', icon: 'palette', desc: '界面布局、缩放、主题与字体' },
    { id: 'ai', label: 'AI 助手', icon: 'chat_bubble', desc: '接口、密钥与提问上下文' },
    { id: 'secret', label: '秘密本', icon: 'lock', desc: '隐藏或已加密的文档：隐藏的条目只在这里能找到' },
    { id: 'data', label: '数据与同步', icon: 'folder', desc: '本地数据目录、文件导入、文件日志与自建同步' },
    { id: 'system', label: '系统', icon: 'dock_to_bottom', desc: '开机自启、托盘、桌面便利贴与更新版本' }
];

let activeSettingsCategory = SETTINGS_CATEGORIES[0].id;

let settingsSubpageOpen = false;

function setSettingsSubpageOpen(open) {
    settingsSubpageOpen = !!open;
    const view = document.getElementById('settings-view');
    if (view) view.classList.toggle('is-subpage', settingsSubpageOpen);
}

function switchSettingsCategory(id) {

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

    const headerToggle = document.getElementById('settings-ai-toggle');
    if (headerToggle) headerToggle.classList.toggle('visible', category.id === 'ai');

    const aiSwitchSection = document.querySelector('[data-settings-panel="ai"] .settings-section:first-child');
    if (aiSwitchSection) aiSwitchSection.classList.toggle('hidden', category.id === 'ai');

    const headerText = document.getElementById('settings-header-text');
    if (headerText) headerText.textContent = category.label;
    const headerDesc = document.getElementById('settings-header-desc');
    if (headerDesc) headerDesc.textContent = category.desc;

    const crumbIcon = document.getElementById('settings-crumb-icon');
    if (crumbIcon) crumbIcon.textContent = category.icon;
    const crumbText = document.getElementById('settings-crumb-text');
    if (crumbText) crumbText.textContent = category.label;

const content = document.querySelector('#settings-view .settings-content');
    if (content) content.scrollTop = 0;

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

item.title = category.label;
        item.setAttribute('aria-label', category.label);
        item.innerHTML = `
            <span class="nav-item-left">
                <span class="ms-icon sm">${category.icon}</span>
                <span class="settings-nav-label">${escapeHTML(category.label)}</span>
            </span>
            <span class="ms-icon sm settings-nav-chevron">chevron_right</span>
        `;
        item.onclick = () => {
            switchSettingsCategory(category.id);
            setSettingsSubpageOpen(true);
        };
        nav.appendChild(item);
    });

    const crumb = document.getElementById('btn-settings-crumb');
    if (crumb) crumb.onclick = () => setSettingsSubpageOpen(false);

    switchSettingsCategory(activeSettingsCategory);
    setSettingsSubpageOpen(false);
}