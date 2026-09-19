/* AI 助手设置面板：API 站点 / KEY / 模型，以及提问时附带的笔记范围 */

// 输入过程中攒一下再落盘，避免每敲一个字符就写一次 config.json
const AI_CONFIG_SAVE_DELAY = 400;
let aiConfigSaveTimer = null;

// 已配置的最低要求：有站点、有模型；本地服务（如 Ollama）可以不填 KEY
function isAiConfigured() {
    return !!(State.ai && State.ai.baseUrl && State.ai.model);
}

// 总开关：关闭后界面中不再保留任何 AI 入口
function isAiEnabled() {
    return !!State.ai && State.ai.enabled !== false;
}

function scheduleAiConfigSave() {
    clearTimeout(aiConfigSaveTimer);
    aiConfigSaveTimer = setTimeout(() => {
        aiConfigSaveTimer = null;
        saveConfig();
    }, AI_CONFIG_SAVE_DELAY);
}

function flushAiConfigSave() {
    if (!aiConfigSaveTimer) return;
    clearTimeout(aiConfigSaveTimer);
    aiConfigSaveTimer = null;
    saveConfig();
}

// 面板状态行：tone 为 ok / error 时着色，缺省为普通说明文字
function setAiStatus(text, tone) {
    const status = document.getElementById('ai-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone || '';
}

function describeAiConfigState() {
    const ai = State.ai || {};
    if (!ai.baseUrl && !ai.model) return '尚未配置：填写 API 站点与模型后即可在标题栏打开「AI 助手」提问。';
    if (!ai.baseUrl) return '还差 API 站点：请填写兼容 OpenAI 协议的接口地址。';
    if (!ai.model) return '还差模型名称：填写模型后即可开始提问。';
    return `已配置：${ai.model}${ai.apiKey ? '' : '（未填写 API Key，适用于本地服务）'}`;
}

// 把界面上的值读回 State（含规范化），并刷新依赖配置的界面元素
function readAiConfigFromForm() {
    const field = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : '';
    };

    State.ai = normalizeAiConfig({
        ...State.ai,
        baseUrl: field('setting-ai-baseurl'),
        apiKey: field('setting-ai-apikey'),
        model: field('setting-ai-model'),
        scope: field('setting-ai-scope'),
        maxNotes: field('setting-ai-maxnotes'),
        systemPrompt: field('setting-ai-system')
    });
}

// 配置变化后统一刷新：状态行、面板标题里的模型名、上下文提示
function refreshAiConfigViews() {
    setAiStatus(describeAiConfigState());
    updateAiPanelHeader();
    updateAiContextHint();
}

function syncAiSettingsUI() {
    const baseUrl = document.getElementById('setting-ai-baseurl');
    if (!baseUrl) return;

    const ai = normalizeAiConfig(State.ai);
    baseUrl.value = ai.baseUrl;
    document.getElementById('setting-ai-apikey').value = ai.apiKey;
    document.getElementById('setting-ai-model').value = ai.model;
    document.getElementById('setting-ai-scope').value = ai.scope;
    document.getElementById('setting-ai-maxnotes').value = String(ai.maxNotes);
    document.getElementById('setting-ai-system').value = ai.systemPrompt;
    document.getElementById('setting-ai-enabled').checked = ai.enabled;

    // 关掉设置页再回来时 KEY 恢复为掩码显示
    const keyInput = document.getElementById('setting-ai-apikey');
    keyInput.type = 'password';
    const keyToggle = document.getElementById('btn-ai-key-toggle');
    if (keyToggle) keyToggle.innerHTML = '<span class="ms-icon xs">visibility</span>';

    setAiStatus(describeAiConfigState());
    applyAiEnabledState();
    // Agent 模式开关在对话面板里，但状态同样来自配置：切换数据目录等情况要跟着刷新
    syncAiAgentToggle();
}

// 总开关状态落到界面上：入口按钮、对话面板与设置项一起显隐
function applyAiEnabledState() {
    const enabled = isAiEnabled();

    const entryBtn = document.getElementById('btn-ai-assistant');
    if (entryBtn) entryBtn.classList.toggle('hidden', !enabled);

    // 只保留总开关，其余配置项在关闭时一并隐藏
    document.querySelectorAll('#settings-view .ai-config-section').forEach((section) => {
        section.classList.toggle('hidden', !enabled);
    });
    const disabledHint = document.getElementById('ai-disabled-hint');
    if (disabledHint) disabledHint.classList.toggle('hidden', enabled);

    if (!enabled) {
        // 关闭时正在生成的回答不再有意义，直接停掉并收起面板
        if (State.aiStreaming) stopAiGeneration();
        if (State.aiPanelOpen) setAiPanelOpen(false);
    }
}

// 总开关切换
function toggleAiEnabled(enabled) {
    State.ai = normalizeAiConfig({ ...State.ai, enabled });
    flushAiConfigSave();
    applyAiEnabledState();
    showToast(enabled ? '已启用 AI 助手' : '已关闭 AI 助手');
}

// 地址快捷填入：把常用站点的地址一键写进输入框
function applyAiBaseUrlPreset(url) {
    const input = document.getElementById('setting-ai-baseurl');
    if (!input || !url) return;

    input.value = url;
    readAiConfigFromForm();
    flushAiConfigSave();
    refreshAiConfigViews();
    showToast(`已填入 API 站点：${url}`);
}

function setAiButtonBusy(id, busy) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = busy;
    btn.dataset.busy = busy ? '1' : '';
}

// 拉取模型列表：结果填充到模型输入框的候选里，仍允许手动填写
async function fetchAiModels() {
    readAiConfigFromForm();
    if (!State.ai.baseUrl) {
        setAiStatus('请先填写 API 站点', 'error');
        return;
    }
    flushAiConfigSave();

    setAiButtonBusy('btn-ai-models', true);
    setAiStatus('正在获取模型列表…');
    try {
        const result = await ipcRenderer.invoke('ai:models');
        if (!result || !result.ok) {
            setAiStatus((result && result.error) || '获取模型列表失败', 'error');
            return;
        }
        const list = document.getElementById('ai-model-list');
        if (list) {
            list.innerHTML = result.models
                .map(model => `<option value="${escapeHTML(model)}"></option>`)
                .join('');
        }
        setAiStatus(`已获取 ${result.models.length} 个模型，可在模型输入框中下拉选择`, 'ok');
        showToast(`已获取 ${result.models.length} 个模型`);
    } catch (err) {
        console.error('获取模型列表失败:', err);
        setAiStatus('获取模型列表失败', 'error');
    } finally {
        setAiButtonBusy('btn-ai-models', false);
    }
}

// 连接测试：让站点真的回一句话，确认站点 / KEY / 模型三者都能用
async function testAiConnection() {
    readAiConfigFromForm();
    if (!State.ai.baseUrl || !State.ai.model) {
        setAiStatus('请先填写 API 站点与模型', 'error');
        return;
    }
    flushAiConfigSave();

    setAiButtonBusy('btn-ai-test', true);
    setAiStatus('正在测试连接…');
    try {
        const result = await ipcRenderer.invoke('ai:test');
        if (!result || !result.ok) {
            setAiStatus((result && result.error) || '连接测试失败', 'error');
            return;
        }
        const reply = String(result.content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        setAiStatus(`连接正常，模型回复：${reply}`, 'ok');
        showToast('AI 连接测试通过');
    } catch (err) {
        console.error('AI 连接测试失败:', err);
        setAiStatus('连接测试失败', 'error');
    } finally {
        setAiButtonBusy('btn-ai-test', false);
    }
}

function initAiSettings() {
    const baseUrl = document.getElementById('setting-ai-baseurl');
    if (!baseUrl) return;

    // 文本类字段：输入时只更新内存并稍后落盘，失焦/回车时立即落盘
    ['setting-ai-baseurl', 'setting-ai-apikey', 'setting-ai-model', 'setting-ai-system'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.oninput = () => {
            readAiConfigFromForm();
            scheduleAiConfigSave();
            refreshAiConfigViews();
        };
        el.onchange = () => {
            readAiConfigFromForm();
            flushAiConfigSave();
            refreshAiConfigViews();
        };
    });

    const scopeSelect = document.getElementById('setting-ai-scope');
    if (scopeSelect) {
        scopeSelect.onchange = () => {
            readAiConfigFromForm();
            flushAiConfigSave();
            // 设置里的默认范围同时作用于本次会话，避免"改了设置却没生效"的错觉
            State.aiScope = State.ai.scope;
            const panelSelect = document.getElementById('ai-scope-select');
            if (panelSelect) panelSelect.value = State.aiScope;
            refreshAiConfigViews();
        };
    }

    const maxNotes = document.getElementById('setting-ai-maxnotes');
    if (maxNotes) {
        maxNotes.onchange = () => {
            readAiConfigFromForm();
            flushAiConfigSave();
            maxNotes.value = String(State.ai.maxNotes);
            refreshAiConfigViews();
        };
    }

    const keyToggle = document.getElementById('btn-ai-key-toggle');
    if (keyToggle) {
        keyToggle.onclick = () => {
            const keyInput = document.getElementById('setting-ai-apikey');
            const reveal = keyInput.type === 'password';
            keyInput.type = reveal ? 'text' : 'password';
            keyToggle.innerHTML = `<span class="ms-icon xs">${reveal ? 'visibility_off' : 'visibility'}</span>`;
        };
    }

    const modelsBtn = document.getElementById('btn-ai-models');
    if (modelsBtn) modelsBtn.onclick = fetchAiModels;

    const testBtn = document.getElementById('btn-ai-test');
    if (testBtn) testBtn.onclick = testAiConnection;

    // 总开关：关闭后界面中不再保留任何 AI 入口
    const enabledToggle = document.getElementById('setting-ai-enabled');
    if (enabledToggle) enabledToggle.onchange = (event) => toggleAiEnabled(event.target.checked);

    // 地址快捷填入：DeepSeek / Ollama 等常用站点一键填好地址
    document.querySelectorAll('#settings-view .ai-quick-chip').forEach((chip) => {
        chip.onclick = () => applyAiBaseUrlPreset(chip.dataset.url || '');
    });

    syncAiSettingsUI();
}
