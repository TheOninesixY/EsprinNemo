const AI_CONFIG_SAVE_DELAY = 400;
let aiConfigSaveTimer = null;

function isAiConfigured() {
    return !!(State.ai && State.ai.baseUrl && State.ai.model);
}

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

    clearTimeout(aiConfigSaveTimer);
    aiConfigSaveTimer = null;
    saveConfig();
}

function setAiStatus(text, tone) {
    const status = document.getElementById('ai-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone || '';
}

function describeAiConfigState() {
    const ai = State.ai || {};
    if (!ai.baseUrl && !ai.model) return '尚未配置：填写 API 站点与模型后即可在标题栏打开「AI 助手」提问。';
    if (!ai.baseUrl) return '尚未配置 API 站点：请填写兼容 OpenAI 协议的接口地址。';
    if (!ai.model) return '尚未配置模型：请填写模型名称。';
    return `已配置：${ai.model}${State.aiHasApiKey ? '' : '（未保存 API Key，适用于本地服务）'}`;
}

function aiKeyStorageKind(status) {
    if (!status || !status.hasKey) return '';
    if (status.strong) return 'keychain';
    return status.encrypted ? 'encrypted' : 'plain';
}

function describeAiKeyStorage() {
    if (!State.aiHasApiKey) return '尚未保存 API Key：输入后回车即保存；密钥不写入配置或笔记文件。';
    if (State.aiKeyStorage === 'keychain') return '已保存到系统密钥链（内存与磁盘上均为密文）。';
    if (State.aiKeyStorage === 'encrypted') return '已保存：当前系统未提供密钥链，仅做基础加密。';
    return '已保存：当前系统不支持加密存储，仅按本机可读的文件权限保存。';
}

function applyAiKeyStatus(status) {
    State.aiHasApiKey = !!(status && status.hasKey);
    State.aiKeyStorage = aiKeyStorageKind(status);

    const keyInput = document.getElementById('setting-ai-apikey');
    if (keyInput) {

        keyInput.placeholder = State.aiHasApiKey ? '已保存；输入新的 API Key 即可替换' : 'sk-…';
    }
    const clearBtn = document.getElementById('btn-ai-key-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !State.aiHasApiKey);

    const hint = document.getElementById('ai-key-hint');
    if (hint) hint.textContent = describeAiKeyStorage();
}

async function refreshAiKeyStatus() {
    try {
        applyAiKeyStatus(await ipcRenderer.invoke('ai:key-status'));
    } catch (err) {
        console.error('读取 API Key 状态失败:', err);
    }
}

async function commitAiKeyFromForm() {
    const input = document.getElementById('setting-ai-apikey');
    if (!input) return false;
    const apiKey = input.value.trim();
    if (!apiKey) return false;

    try {
        const result = await ipcRenderer.invoke('ai:set-key', { apiKey });
        if (!result || !result.ok) {
            setAiStatus((result && result.error) || '保存 API Key 失败：与主进程通信异常，请重试', 'error');
            return false;
        }
        input.value = '';
        applyAiKeyStatus(result);
        refreshAiConfigViews();
        showToast('API Key 已保存');
        return true;
    } catch (err) {
        console.error('保存 API Key 失败:', err);
        setAiStatus('保存 API Key 失败：与主进程通信异常，请重试', 'error');
        return false;
    }
}

async function clearAiApiKey() {
    const confirmed = await showConfirm('清除已保存的 API Key？', {
        title: '清除 API Key',
        detail: '清除后需重新填写才能使用需要鉴权的 API 站点；本地服务（如 Ollama）不受影响。',
        confirmLabel: '清除',
        danger: true
    });
    if (!confirmed) return;

    try {
        const result = await ipcRenderer.invoke('ai:set-key', { apiKey: '' });
        if (!result || !result.ok) {
            setAiStatus((result && result.error) || '清除 API Key 失败：与主进程通信异常，请重试', 'error');
            return;
        }
        applyAiKeyStatus(result);
        refreshAiConfigViews();
        showToast('已清除 API Key');
    } catch (err) {
        console.error('清除 API Key 失败:', err);
        setAiStatus('清除 API Key 失败：与主进程通信异常，请重试', 'error');
    }
}

function readAiConfigFromForm() {
    const field = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : '';
    };

    State.ai = normalizeAiConfig({
        ...State.ai,
        baseUrl: field('setting-ai-baseurl'),
        model: field('setting-ai-model'),
        scope: field('setting-ai-scope'),
        maxNotes: field('setting-ai-maxnotes'),
        systemPrompt: field('setting-ai-system')
    });
}

function refreshAiConfigViews() {
    setAiStatus(describeAiConfigState());
    updateAiPanelHeader();
    updateAiScopeOptions();
}

function syncAiSettingsUI() {
    const baseUrl = document.getElementById('setting-ai-baseurl');
    if (!baseUrl) return;

    const ai = normalizeAiConfig(State.ai);
    baseUrl.value = ai.baseUrl;
    document.getElementById('setting-ai-model').value = ai.model;
    document.getElementById('setting-ai-scope').value = ai.scope;
    document.getElementById('setting-ai-maxnotes').value = String(ai.maxNotes);
    document.getElementById('setting-ai-system').value = ai.systemPrompt;
    document.getElementById('setting-ai-enabled').checked = ai.enabled;

const keyInput = document.getElementById('setting-ai-apikey');
    keyInput.value = '';
    keyInput.type = 'password';
    const keyToggle = document.getElementById('btn-ai-key-toggle');
    if (keyToggle) keyToggle.innerHTML = '<span class="ms-icon xs">visibility</span>';
    applyAiKeyStatus({ hasKey: State.aiHasApiKey, encrypted: State.aiKeyStorage === 'encrypted', strong: State.aiKeyStorage === 'keychain' });
    refreshAiKeyStatus();

    setAiStatus(describeAiConfigState());
    applyAiEnabledState();

    syncAiAgentToggle();
}

function applyAiEnabledState() {
    const enabled = isAiEnabled();

    const entryBtn = document.getElementById('btn-ai-assistant');
    if (entryBtn) entryBtn.classList.toggle('hidden', !enabled);

    document.querySelectorAll('#settings-view .ai-config-section').forEach((section) => {
        section.classList.toggle('hidden', !enabled);
    });
    const disabledHint = document.getElementById('ai-disabled-hint');
    if (disabledHint) disabledHint.classList.toggle('hidden', enabled);

    const headerCheckbox = document.getElementById('setting-ai-enabled-header');
    if (headerCheckbox) headerCheckbox.checked = enabled;

    if (!enabled) {
        if (State.aiStreaming) stopAiGeneration();
        if (State.aiPanelOpen) setAiPanelOpen(false);
    }
}

function toggleAiEnabled(enabled) {
    State.ai = normalizeAiConfig({ ...State.ai, enabled });
    flushAiConfigSave();
    applyAiEnabledState();
    showToast(enabled ? '已启用 AI 助手' : '已关闭 AI 助手');
}

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

async function fetchAiModels() {
    readAiConfigFromForm();
    if (!State.ai.baseUrl) {
        setAiStatus('请先填写 API 站点', 'error');
        return;
    }
    flushAiConfigSave();

    await commitAiKeyFromForm();

    setAiButtonBusy('btn-ai-models', true);
    setAiStatus('正在获取模型列表…');
    try {
        const result = await ipcRenderer.invoke('ai:models');
        if (!result || !result.ok) {
            setAiStatus((result && result.error) || '获取模型列表失败：请检查 API 站点与 API Key', 'error');
            return;
        }
        const list = document.getElementById('ai-model-list');
        if (list) {
            list.innerHTML = result.models
                .map(model => `<option value="${escapeHTML(model)}"></option>`)
                .join('');
        }
        setAiStatus(`已获取 ${result.models.length} 个模型：可在模型输入框中输入，或从候选列表中选择`, 'ok');
        showToast(`已获取 ${result.models.length} 个模型`);
    } catch (err) {
        console.error('获取模型列表失败:', err);
        setAiStatus('获取模型列表失败：与主进程通信异常，请重试', 'error');
    } finally {
        setAiButtonBusy('btn-ai-models', false);
    }
}

async function testAiConnection() {
    readAiConfigFromForm();
    if (!State.ai.baseUrl || !State.ai.model) {
        setAiStatus('请先填写 API 站点与模型', 'error');
        return;
    }
    flushAiConfigSave();

    await commitAiKeyFromForm();

    setAiButtonBusy('btn-ai-test', true);
    setAiStatus('正在测试连接…');
    try {
        const result = await ipcRenderer.invoke('ai:test');
        if (!result || !result.ok) {
            setAiStatus((result && result.error) || '连接测试失败：请检查 API 站点、API Key 与模型', 'error');
            return;
        }
        const reply = String(result.content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        setAiStatus(`连接正常，模型回复：${reply}`, 'ok');
        showToast('AI 连接测试通过');
    } catch (err) {
        console.error('AI 连接测试失败:', err);
        setAiStatus('连接测试失败：与主进程通信异常，请重试', 'error');
    } finally {
        setAiButtonBusy('btn-ai-test', false);
    }
}

function initAiSettings() {
    const baseUrl = document.getElementById('setting-ai-baseurl');
    if (!baseUrl) return;

['setting-ai-baseurl', 'setting-ai-model', 'setting-ai-system'].forEach((id) => {
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

const keyInput = document.getElementById('setting-ai-apikey');
    if (keyInput) {
        keyInput.onchange = () => { commitAiKeyFromForm(); };
        keyInput.onkeydown = (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commitAiKeyFromForm();
        };
    }

    const keyClearBtn = document.getElementById('btn-ai-key-clear');
    if (keyClearBtn) keyClearBtn.onclick = clearAiApiKey;

    const scopeSelect = document.getElementById('setting-ai-scope');
    if (scopeSelect) {
        scopeSelect.onchange = () => {
            readAiConfigFromForm();
            flushAiConfigSave();

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

const enabledToggle = document.getElementById('setting-ai-enabled');
    if (enabledToggle) enabledToggle.onchange = (event) => toggleAiEnabled(event.target.checked);

    const headerToggle = document.getElementById('setting-ai-enabled-header');
    if (headerToggle) headerToggle.onchange = (event) => toggleAiEnabled(event.target.checked);

    document.querySelectorAll('#settings-view .ai-quick-chip').forEach((chip) => {
        chip.onclick = () => applyAiBaseUrlPreset(chip.dataset.url || '');
    });

    syncAiSettingsUI();
}