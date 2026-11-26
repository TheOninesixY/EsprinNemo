const SETTINGS_CATEGORIES = [
    { id: 'editor', label: '编辑器', icon: 'file-pen-line', desc: '拼写检查与废纸篓的清理策略' },
    { id: 'appearance', label: '外观', icon: 'palette', desc: '字号、主题、字体、界面缩放与窗口材质' },
    { id: 'ai', label: 'AI 助手', icon: 'message-circle', desc: '接口、密钥、模型与附带范围' },
    { id: 'secret', label: '秘密本', icon: 'lock', desc: '本地或已加密的文档，离开后项目只在本次运行中可见' },
    { id: 'data', label: '数据与同步', icon: 'folder', desc: '数据存放目录、文件导入、文件日志与自建同步' },
    { id: 'system', label: '系统', icon: 'monitor-cog', desc: '开机自启、托盘、后台运行与桌面便利贴' },
    { id: 'about', label: '关于', icon: 'info', desc: '应用版本、软件更新、项目主页与版本说明' }
];

const DEVELOPER_SETTINGS_CATEGORY = { id: 'developer', label: '开发者选项', icon: 'code', desc: '调试用开关，仅在开发运行时出现' };

const SETTINGS_WINDOW_CATEGORY_ARG = '--esprin-nemo-settings-category=';

function readInitialSettingsCategory() {
    try {
        const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith(SETTINGS_WINDOW_CATEGORY_ARG));
        if (matched) return matched.slice(SETTINGS_WINDOW_CATEGORY_ARG.length).trim();
    } catch (err) {

    }
    return '';
}

const initialSettingsCategory = readInitialSettingsCategory();

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

if (initialSettingsCategory && (SETTINGS_CATEGORIES.some((category) => category.id === initialSettingsCategory)
    || initialSettingsCategory === DEVELOPER_SETTINGS_CATEGORY.id)) {
    activeSettingsCategory = initialSettingsCategory;
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

function openSettingsWindow(category) {
    if (typeof IS_SETTINGS_WINDOW !== 'undefined' && IS_SETTINGS_WINDOW) {
        if (typeof category === 'string' && category) switchSettingsCategory(category);
        return;
    }
    const target = typeof category === 'string' ? category : '';
    ipcRenderer.invoke('settings:open', { category: target })
        .catch((err) => {
            console.error('[Desktop:ERROR] 打开设置窗口失败:', err);
            if (typeof showToast === 'function') showToast('打开设置窗口失败');
        });
}

function openAboutTab() {
    openSettingsWindow('about');
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
                <span class="icon sm" data-lucide="${category.icon}" aria-hidden="true"></span>
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
    if (typeof IS_SETTINGS_WINDOW !== 'undefined' && IS_SETTINGS_WINDOW) {
        ipcRenderer.invoke('window:close').catch(() => {});
        return;
    }
    if (typeof closeTab === 'function') closeTab('settings');
    renderApp();
}

function applySharedConfig(config) {
    if (!config || typeof config !== 'object') return;

    const previousTheme = State.theme;
    const previousAccent = normalizeAccentColor(State.accentColor);
    const previousRadius = normalizeCornerRadius(State.cornerRadius);
    const previousScale = normalizeUiScale(State.uiScale);
    const previousSpellcheck = !!State.spellcheck;
    const previousBlur = State.backgroundBlur !== false;
    const previousTrash = normalizeTrashRetentionDays(State.trashRetentionDays);
    const previousFonts = JSON.stringify(normalizeFonts(State.fonts));
    const previousAi = JSON.stringify(normalizeAiConfig(State.ai));
    const previousAutoUpdate = State.autoUpdate;
    const previousGhProxy = State.ghProxyEnabled;
    const previousTray = State.trayEnabled;

    State.theme = typeof config.theme === 'string' ? config.theme : State.theme;
    State.accentColor = normalizeAccentColor(config.accentColor);
    State.cornerRadius = normalizeCornerRadius(config.cornerRadius);
    State.uiScale = normalizeUiScale(config.uiScale);
    State.spellcheck = typeof config.spellcheck === 'boolean' ? config.spellcheck : State.spellcheck;
    State.trashRetentionDays = normalizeTrashRetentionDays(config.trashRetentionDays);
    State.autoUpdate = config.autoUpdate !== false;
    State.ghProxyEnabled = config.ghProxyEnabled === true;
    State.autoLaunch = config.autoLaunch === true;
    State.trayEnabled = config.trayEnabled !== false;
    State.backgroundBlur = config.backgroundBlur !== false;
    State.backgroundRunning = config.backgroundRunning !== false;
    State.stickyNotes = normalizeStickyConfig(config.stickyNotes);
    State.fonts = normalizeFonts(config.fonts);
    State.ai = normalizeAiConfig(config.ai);
    State.aiScope = State.ai.scope;

    if (config.syncServer && typeof config.syncServer === 'object') {
        State.syncServer = normalizeSyncServerConfig(config.syncServer);
        State.syncServerLoaded = true;
    }

    const nextAccent = normalizeAccentColor(State.accentColor);
    const nextRadius = normalizeCornerRadius(State.cornerRadius);
    const nextScale = normalizeUiScale(State.uiScale);
    const nextFonts = JSON.stringify(normalizeFonts(State.fonts));
    const nextAi = JSON.stringify(normalizeAiConfig(State.ai));

    if (State.theme !== previousTheme) {
        applyTheme();
    } else if (nextAccent !== previousAccent) {
        applyAccentColor();
        syncAccentControls();
    }

    if (nextRadius !== previousRadius) {
        applyCornerRadius();
        syncCornerRadiusControl();
    }
    if (nextScale !== previousScale) {
        applyUiScale();
        syncUiScaleControl();
    }
    if (!!State.spellcheck !== previousSpellcheck) applySpellcheck();
    if ((State.backgroundBlur !== false) !== previousBlur) {
        applyBackgroundBlur();
        syncBackgroundBlurControl();
    }
    if (typeof syncBackgroundRunningControl === 'function') syncBackgroundRunningControl();
    if (nextFonts !== previousFonts) {
        applyFonts();
        syncFontSelects();
    }
    if (normalizeTrashRetentionDays(State.trashRetentionDays) !== previousTrash) syncTrashRetentionSelect();

    if (nextAi !== previousAi) {
        State.aiScope = State.ai.scope;
        syncAiSettingsUI();
        if (typeof applyAiEnabledState === 'function') applyAiEnabledState();
        if (typeof applyAiPanelVisibility === 'function') applyAiPanelVisibility();
        if (typeof refreshAiKeyStatus === 'function') refreshAiKeyStatus();
        if (typeof refreshAiConfigViews === 'function') refreshAiConfigViews();
    }

    if (State.autoUpdate !== previousAutoUpdate || State.ghProxyEnabled !== previousGhProxy) {
        syncUpdateSettingsUI();
    }
    if (State.trayEnabled !== previousTray && typeof syncTrayStatusText === 'function') {
        syncTrayStatusText();
    }
}

ipcRenderer.on('settings:category', (event, id) => {
    if (typeof id === 'string' && id) switchSettingsCategory(id);
});

ipcRenderer.on('settings:config-changed', (event, config) => {
    applySharedConfig(config);
});
