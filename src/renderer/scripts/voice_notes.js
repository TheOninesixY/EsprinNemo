const VOICE_LANG_LABELS = { 'zh-CN': '普通话', 'en-US': '英语', 'ja-JP': '日语' };

let voiceListening = false;
let voiceStarting = false;
let voiceInsertedChars = 0;

let voiceInsertField = 'content';

let voiceSessionItemId = null;

function voiceErrorText(code, detail) {
    const suffix = detail ? `（${detail}）` : '';
    switch (code) {
        case 'Unsupported':
            return '随口记不可用：当前系统没有 Windows PowerShell 或不是 Windows 环境';
        case 'NoRecognizer':
            return '随口记启动失败：系统未安装该语言的语音识别组件，请在 Windows 设置 → 时间和语言 → 语言和区域 中为该语言添加「语音识别」功能后重试';
        case 'AudioDevice':
            return `随口记启动失败：未检测到可用的麦克风设备，请接入麦克风并允许桌面应用访问麦克风后重试${suffix}`;
        case 'Busy':
            return '随口记启动失败：已有一个识别会话在进行中，请先停止后重试';
        case 'Recognition':
            return `随口记已中断：系统识别引擎无法继续工作${suffix}`;
        default:
            return `随口记启动失败：系统识别引擎启动异常${suffix}`;
    }
}

function voiceLang() {
    return normalizeVoiceLanguage(State.voice.lang);
}

function isVoiceSupportedPlatform() {
    return process.platform === 'win32';
}

const VOICE_STATUS_TTL_MS = 5000;
let voiceStatusCache = { at: 0, value: null };

async function readVoiceStatus(force = false) {
    if (!force && voiceStatusCache.value && Date.now() - voiceStatusCache.at < VOICE_STATUS_TTL_MS) {
        return voiceStatusCache.value;
    }
    let result;
    try {
        result = await ipcRenderer.invoke('speech:status');
    } catch (error) {
        console.error('[ERROR] [Voice] 读取系统语音识别状态失败:', error);
        result = { supported: false, reason: 'ipc', languages: [] };
    }
    voiceStatusCache = { at: Date.now(), value: result };
    return result;
}

function describeVoiceLanguages(languages) {
    return (languages || [])
        .map((item) => `${VOICE_LANG_LABELS[item.culture] || item.culture}（${item.culture}）`)
        .join('、');
}

function voiceBarElement(id) {
    return document.getElementById(id);
}

function setVoiceBarState(text) {
    const state = voiceBarElement('voice-state');
    if (state) state.textContent = text;
}

function setVoiceInterim(text) {
    const interim = voiceBarElement('voice-interim');
    if (interim) interim.textContent = text ? text.trim() : '';
}

function applyVoiceButtonState(mode) {
    const button = voiceBarElement('btn-voice-dictate');
    if (!button) return;

    const listening = mode === 'listening';
    button.classList.toggle('active', listening);
    button.classList.toggle('busy', mode === 'busy');
    button.disabled = mode === 'busy';
    button.setAttribute('aria-pressed', listening ? 'true' : 'false');
    const icon = button.querySelector('.ms-icon');
    if (icon) icon.textContent = listening ? 'stop_circle' : 'mic';
    button.title = listening ? '随口记：停止聆听 (Ctrl+Shift+M)' : '随口记：语音转文本 (Ctrl+Shift+M)';
}

function applyVoiceBarVisibility(visible) {
    const bar = voiceBarElement('voice-bar');
    if (!bar) return;
    bar.classList.toggle('hidden', !visible);
    if (!visible) {
        setVoiceInterim('');
        setVoiceBarState('');
    }
}

function voiceTargetField() {
    const title = voiceBarElement('input-note-title');
    const content = voiceBarElement('textarea-note-content');
    const preferred = voiceInsertField === 'title' ? title : content;
    if (preferred && !preferred.readOnly) return preferred;
    return content && !content.readOnly ? content : null;
}

function insertVoiceText(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return;

    const field = voiceTargetField();
    if (!field) return;

    const value = field.value;
    const start = field.selectionStart === null ? value.length : field.selectionStart;
    const end = field.selectionEnd === null ? start : field.selectionEnd;
    const before = value.slice(0, start);
    const needsSpace = /^[A-Za-z0-9]/.test(text) && before !== '' && !/\s$/.test(before);
    const insert = (needsSpace ? ' ' : '') + text;

    field.value = before + insert + value.slice(end);
    const caret = start + insert.length;
    field.setSelectionRange(caret, caret);

    if (document.activeElement !== field) field.focus();
    voiceInsertedChars += insert.length;

autoSaveActiveItem();
    if (field.id === 'textarea-note-content') scheduleRenderMarkdown();
}

function stopVoiceDictation(options = {}) {
    const wasAlive = voiceListening;
    voiceListening = false;
    voiceStarting = false;

    ipcRenderer.invoke('speech:stop').catch((error) => {
        console.error('[ERROR] [Voice] 停止系统语音识别失败:', error);
    });

    const inserted = voiceInsertedChars;
    voiceInsertedChars = 0;
    voiceSessionItemId = null;
    applyVoiceBarVisibility(false);
    applyVoiceButtonState('idle');

    if (options.silent || !wasAlive) return;
    showToast(inserted > 0 ? `随口记：已插入 ${inserted} 字` : '随口记：本次未识别到可插入的内容');
}

async function startVoiceDictation() {

    if (!isVoiceSupportedPlatform()) {
        applyVoiceBarVisibility(false);
        showToast('随口记仅在 Windows 上可用：当前 Linux 环境已隐藏此功能');
        return;
    }
    if (voiceListening) {
        stopVoiceDictation();
        return;
    }
    if (voiceStarting) return;

    const item = getActiveItem();
    if (!item) {
        showToast('随口记无法开始：当前没有打开的内容，请先打开一篇笔记或一项待办');
        return;
    }
    if (isReadOnlyItem(item)) {
        showToast('随口记无法开始：废纸篓中的内容为只读，请先恢复该条目');
        return;
    }

voiceInsertField = document.activeElement === voiceBarElement('input-note-title') ? 'title' : 'content';

    const lang = voiceLang();
    voiceStarting = true;
    applyVoiceButtonState('busy');
    applyVoiceBarVisibility(true);
    setVoiceBarState('正在检查系统语音识别…');

const status = await readVoiceStatus();
    if (!status.supported) {
        voiceStarting = false;
        applyVoiceBarVisibility(false);
        applyVoiceButtonState('idle');
        showToast(voiceErrorText(status.reason === 'platform' ? 'Unsupported' : 'Engine'));
        return;
    }
    const installed = (status.languages || []).map((entry) => entry.culture);
    if (!installed.includes(lang)) {
        voiceStarting = false;
        applyVoiceBarVisibility(false);
        applyVoiceButtonState('idle');
        showToast(installed.length
            ? `随口记无法开始：系统未安装${VOICE_LANG_LABELS[lang] || lang}的语音识别组件，当前可用：${describeVoiceLanguages(status.languages)}`
            : '随口记无法开始：系统未安装任何语音识别组件，请在 Windows 设置 → 时间和语言 → 语言和区域 中为语言添加「语音识别」功能');
        return;
    }

    setVoiceBarState('正在启动系统语音识别…');
    const result = await ipcRenderer.invoke('speech:start', { culture: lang });
    voiceStarting = false;

    if (!result || !result.ok) {
        applyVoiceBarVisibility(false);
        applyVoiceButtonState('idle');
        showToast(voiceErrorText(result && result.code, result && result.message));
        return;
    }

    voiceInsertedChars = 0;
    voiceSessionItemId = item.id;
    voiceListening = true;
    setVoiceInterim('');
    setVoiceBarState(`正在聆听 · 系统识别（${VOICE_LANG_LABELS[lang] || lang}）`);
    applyVoiceButtonState('listening');
}

async function refreshVoiceEngineStatus(force = false) {
    const status = voiceBarElement('voice-status');
    if (!status) return;

    status.textContent = '正在检测系统语音识别…';
    const result = await readVoiceStatus(force);
    if (!result.supported) {
        status.textContent = result.reason === 'platform'
            ? '当前系统不支持：随口记使用 Windows 自带的语音识别，仅在 Windows 上可用'
            : '系统语音识别不可用：未能启动检测进程（见主进程日志）';
        return;
    }
    if (!result.languages.length) {
        status.textContent = '系统未安装任何语音识别组件：请在 Windows 设置 → 时间和语言 → 语言和区域 中为语言添加「语音识别」功能';
        return;
    }
    const engine = result.languages[0];
    status.textContent = `可用识别语言：${describeVoiceLanguages(result.languages)}；识别在本机完成，音频不出本机（引擎：${engine.id}）`;
}

function applyVoiceLanguage(value) {
    const lang = normalizeVoiceLanguage(value);
    const changed = lang !== State.voice.lang;
    State.voice = normalizeVoiceConfig({ ...State.voice, lang });
    saveConfig();

    const barSelect = voiceBarElement('voice-lang-select');
    if (barSelect) barSelect.value = lang;
    const settingSelect = voiceBarElement('setting-voice-lang');
    if (settingSelect) settingSelect.value = lang;

    if (voiceListening) {

        stopVoiceDictation({ silent: true });
        showToast(`识别语言已切换为${VOICE_LANG_LABELS[lang] || lang}，随口记已停止`);
        return;
    }
    if (changed) refreshVoiceEngineStatus();
}

function syncVoiceSettingsUI() {
    const enabled = voiceBarElement('setting-voice-enabled');
    if (!enabled) return;

    const voice = normalizeVoiceConfig(State.voice);
    enabled.checked = voice.enabled;
    voiceBarElement('setting-voice-lang').value = voice.lang;
    refreshVoiceEngineStatus();
}

function syncVoiceEntry(item) {
    const itemId = item ? item.id : null;
    const available = isVoiceSupportedPlatform()
        && State.voice.enabled !== false
        && itemId !== null
        && !isReadOnlyItem(item);
    const button = voiceBarElement('btn-voice-dictate');
    if (button) button.classList.toggle('hidden', !available);

    if (!isVoiceSupportedPlatform()) {
        applyVoiceBarVisibility(false);
        return;
    }

if (voiceListening && (!available || voiceSessionItemId !== itemId)) stopVoiceDictation({ silent: true });
    if (!available && !voiceStarting) applyVoiceBarVisibility(false);
}

function handleVoiceEvent(event, payload) {
    if (!payload || typeof payload.type !== 'string') return;
    if (payload.type === 'final') {
        if (voiceListening) insertVoiceText(payload.text);
        return;
    }
    if (payload.type === 'partial') {
        if (voiceListening) setVoiceInterim(payload.text);
        return;
    }
    if (payload.type === 'rejected') {
        if (voiceListening) setVoiceBarState('未识别到内容，继续聆听…');
        return;
    }
    if (payload.type === 'closed') {

        if (!voiceListening) return;
        voiceListening = false;
        voiceInsertedChars = 0;
        voiceSessionItemId = null;
        applyVoiceBarVisibility(false);
        applyVoiceButtonState('idle');
        showToast(payload.code
            ? voiceErrorText(payload.code, payload.message)
            : '随口记已停止：系统识别会话意外结束，请重试');
    }
}

function initVoiceNotes() {
    if (!isVoiceSupportedPlatform()) {
        applyVoiceBarVisibility(false);
    }

    const button = voiceBarElement('btn-voice-dictate');
    if (button) {
        button.classList.toggle('hidden', !isVoiceSupportedPlatform());
        button.onclick = () => startVoiceDictation();
    }
    const stopButton = voiceBarElement('btn-voice-stop');
    if (stopButton) stopButton.onclick = () => stopVoiceDictation();

    const barSelect = voiceBarElement('voice-lang-select');
    if (barSelect) {
        barSelect.value = voiceLang();
        barSelect.onchange = () => applyVoiceLanguage(barSelect.value);
    }
    const settingSelect = voiceBarElement('setting-voice-lang');
    if (settingSelect) settingSelect.onchange = () => applyVoiceLanguage(settingSelect.value);

    const enabledToggle = voiceBarElement('setting-voice-enabled');
    if (enabledToggle) {
        enabledToggle.onchange = () => {
            State.voice = normalizeVoiceConfig({ ...State.voice, enabled: enabledToggle.checked });
            saveConfig();
            syncVoiceEntry(getActiveItem());
            showToast(State.voice.enabled ? '随口记入口已显示' : '随口记入口已隐藏');
        };
    }

    const checkButton = voiceBarElement('btn-voice-check');
    if (checkButton) checkButton.onclick = () => refreshVoiceEngineStatus(true);

ipcRenderer.on('speech:event', handleVoiceEvent);

window.addEventListener('keydown', (event) => {
        if (typeof event.key !== 'string') return;
        if (event.key === 'Escape' && voiceListening) {
            stopVoiceDictation();
            return;
        }
        if (!event.ctrlKey && !event.metaKey) return;
        if (event.key.toLowerCase() !== 'm' || !event.shiftKey) return;
        event.preventDefault();

        if (State.voice.enabled === false) {
            showToast('随口记已关闭：请在设置 → 编辑器 → 随口记 中开启');
            return;
        }
        if (!voiceListening && !getActiveItem() && !voiceStarting) {
            showToast('随口记无法开始：当前没有打开的内容，请先打开一篇笔记或一项待办');
            return;
        }
        startVoiceDictation();
    });
}
