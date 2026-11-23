const SETTINGS_CATEGORIES = [
    { id: 'editor', label: '编辑器', icon: 'edit_note', desc: '拼写检查与废纸篓的清理策略' },
    { id: 'appearance', label: '外观', icon: 'palette', desc: '字号、主题、字体与界面缩放' },
    { id: 'ai', label: 'AI 助手', icon: 'chat_bubble', desc: '接口、密钥、模型与附带范围' },
    { id: 'secret', label: '秘密本', icon: 'lock', desc: '本地或已加密的文档，离开后项目只在本次运行中可见' },
    { id: 'data', label: '数据与同步', icon: 'folder', desc: '数据存放目录、文件导入、文件日志与自建同步' },
    { id: 'system', label: '系统', icon: 'dock_to_bottom', desc: '开机自启、托盘与桌面便利贴' },
    { id: 'about', label: '关于', icon: 'info', desc: '应用版本、软件更新、项目主页与版本说明' }
];

const DEVELOPER_SETTINGS_CATEGORY = { id: 'developer', label: '开发者选项', icon: 'developer_mode', desc: '调试用开关，仅在开发运行时出现' };

let activeSettingsCategory = SETTINGS_CATEGORIES[0].id;

function isDevRunActive() {
    if (typeof dataDirInfo !== 'undefined' && dataDirInfo && dataDirInfo.isDevRun) return true;
    try {
        if (typeof process !== 'undefined' && process && process.defaultApp === true) return true;
    } catch (err) {

    }
    return false;
}

function settingsCategories() {
    return isDevRunActive() ? [...SETTINGS_CATEGORIES, DEVELOPER_SETTINGS_CATEGORY] : SETTINGS_CATEGORIES;
}

function switchSettingsCategory(id) {
    const categories = settingsCategories();
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

    const headerToggle = document.getElementById('settings-ai-toggle');
    if (headerToggle) headerToggle.classList.toggle('visible', category.id === 'ai');

    const aiSwitchSection = document.querySelector('[data-settings-panel="ai"] .settings-section:first-child');
    if (aiSwitchSection) aiSwitchSection.classList.toggle('hidden', category.id === 'ai');

    const headerText = document.getElementById('settings-header-text');
    if (headerText) headerText.textContent = category.label;
    const headerDesc = document.getElementById('settings-header-desc');
    if (headerDesc) headerDesc.textContent = category.desc;

    const topbarCurrent = document.getElementById('settings-topbar-current');
    if (topbarCurrent) topbarCurrent.textContent = category.label;

    const content = document.querySelector('#settings-view .settings-content');
    if (content) content.scrollTop = 0;

    if (category.id === 'about' && typeof refreshUpdateInfo === 'function') refreshUpdateInfo();
    if (category.id === 'about') ensureAboutVersion();
}

function ensureAboutVersion() {
    const el = document.getElementById('update-current-version');
    if (!el || (el.textContent && el.textContent !== '…')) return;
    ipcRenderer.invoke('app:get-version')
        .then((version) => {
            if (el.textContent && el.textContent !== '…') return;
            el.textContent = `v${version}`;
        })
        .catch(() => {});
}

function openAboutTab() {
    openSettingsTab();
    switchSettingsCategory('about');
}

function renderSettingsNavItems() {
    const nav = document.getElementById('settings-nav');
    if (!nav) return;
    nav.innerHTML = '';

    settingsCategories().forEach((category) => {
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
        `;
        item.onclick = () => switchSettingsCategory(category.id);
        nav.appendChild(item);
    });

    switchSettingsCategory(activeSettingsCategory);
}

function initSettingsNav() {
    const nav = document.getElementById('settings-nav');
    if (!nav) return;

    renderSettingsNavItems();
}

function closeSettingsTab() {
    if (typeof closeTab === 'function') closeTab('settings');
    renderApp();
}
