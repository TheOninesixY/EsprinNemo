/* 随口记：语音转文本（Windows 系统语音识别）。

   识别在主进程拉起的 Windows 桌面识别引擎里完成（System.Speech 的 DictationGrammar），
   音频只进本机引擎、不出本机，也不经过网络；本模块只负责入口、聆听反馈与结果插入——
   识别的文本按句插到当前编辑位置（标题框或正文框），落盘交给编辑器自身的自动保存链路。
   与系统的往来全在主进程里（见 src/main/speech_windows.js），这里只调这几个通道：
   speech:status / speech:start / speech:stop，以及主进程推来的 speech:event。

   入口与配置：
   · 编辑器顶栏的麦克风按钮（#btn-voice-dictate）与 Ctrl+Shift+M 起停
   · 设置 → 编辑器 → 随口记：入口开关、识别语言与系统识别引擎状态 */

// 语言下拉的显示名（取值与 state.js 的 VOICE_LANGUAGE_VALUES 一一对应）
const VOICE_LANG_LABELS = { 'zh-CN': '普通话', 'en-US': '英语', 'ja-JP': '日语' };

// 会话状态（运行期数据，不落盘）
let voiceListening = false;
let voiceStarting = false;
let voiceInsertedChars = 0;
// 识别结果的落点：title（标题框）/ content（正文框），开始聆听时按当时的焦点决定
let voiceInsertField = 'content';
// 本次会话写进哪个条目：聆听中切走条目（换了另一篇）时据此收尾，避免结果插错地方
let voiceSessionItemId = null;

/* 主进程回传的失败码 -> 可执行的说明。只说失败的动作、原因与下一步，
   不使用「未知错误」这类没有信息量的说法（码值见 src/main/speech_windows.js） */
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

// 系统状态里已安装的识别语言（形如 [{culture:'zh-CN', id, description}]），供设置页与启动前校验使用。
// 探测要拉一个 PowerShell 子进程，因此结果按 TTL 缓存：设置页每次渲染都问一遍也不会反复起进程
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

// 把系统报告的语言列表写成一句话：普通话（zh-CN）等，未安装任何语言时返回空串
function describeVoiceLanguages(languages) {
    return (languages || [])
        .map((item) => `${VOICE_LANG_LABELS[item.culture] || item.culture}（${item.culture}）`)
        .join('、');
}

/* ---------- 界面：入口按钮、聆听反馈条与设置项 ---------- */

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

// 入口按钮的三种样子：idle（麦克风）/ busy（检测中，不可点）/ listening（聆听中，点亮成主题色并换成停止）
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

/* ---------- 识别结果的落点 ---------- */

// 结果插入哪个输入框：标题框 / 正文框；两者都不可写时返回 null
function voiceTargetField() {
    const title = voiceBarElement('input-note-title');
    const content = voiceBarElement('textarea-note-content');
    const preferred = voiceInsertField === 'title' ? title : content;
    if (preferred && !preferred.readOnly) return preferred;
    return content && !content.readOnly ? content : null;
}

/* 把一段最终识别结果插到光标处。中英文的拼接规则不同：英文单词之间要补空格，中文不能补，
   这里只在「前一个字符不是空白、且新片段以 ASCII 字母或数字开头」时补一个空格。 */
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
    // 点过入口按钮或语言下拉后焦点已经离开编辑区，这里把焦点与光标位置一起交还
    if (document.activeElement !== field) field.focus();
    voiceInsertedChars += insert.length;

    // 落盘走编辑器自身的自动保存链路，渲染预览只在正文改动时需要
    autoSaveActiveItem();
    if (field.id === 'textarea-note-content') scheduleRenderMarkdown();
}

/* ---------- 会话：启动与收尾 ---------- */

// 停止聆听：silent 用于「不是用户按下停止」的收尾（切走条目、会话异常结束等），此时不报插入字数
function stopVoiceDictation(options = {}) {
    const wasAlive = voiceListening;
    voiceListening = false;
    voiceStarting = false;
    // 主进程无论有没有会话都会应答，这里不必等它
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
    // 正在聆听时按钮即「停止」
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

    // 落点按开始时的焦点决定：光标在标题框里就插标题，其余一律插正文
    voiceInsertField = document.activeElement === voiceBarElement('input-note-title') ? 'title' : 'content';

    const lang = voiceLang();
    voiceStarting = true;
    applyVoiceButtonState('busy');
    applyVoiceBarVisibility(true);
    setVoiceBarState('正在检查系统语音识别…');

    /* 起会话之前先看系统装了什么：没装对应语言的识别组件就直接说清楚，
       不去起一个注定失败的进程（第一次启动的进程开销不小） */
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

/* ---------- 设置项与快捷键 ---------- */

// 设置页的状态行：列出系统已安装的识别语言与当前使用的引擎。
// force 为真时重新探测（「重新检测」按钮），否则用缓存，免得设置页每次渲染都起一个探测进程
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

// 两处语言下拉（编辑器里的聆听条与设置页）始终与配置一致
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
        // 语言只在会话启动时生效，直接换语言会得到一锅夹生结果：这里先停下来，由用户重新开始
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

/* 条目渲染后的同步：入口按钮的显隐与可用性，以及切走条目 / 进入只读时的收尾。
   由 render.js 在每次工作区渲染后调用。 */
function syncVoiceEntry(item) {
    const itemId = item ? item.id : null;
    const available = State.voice.enabled !== false && itemId !== null && !isReadOnlyItem(item);
    const button = voiceBarElement('btn-voice-dictate');
    if (button) button.classList.toggle('hidden', !available);

    // 聆听中切走条目、进入只读或换了一篇：直接收尾，避免把识别结果插到别的条目上
    if (voiceListening && (!available || voiceSessionItemId !== itemId)) stopVoiceDictation({ silent: true });
    if (!available && !voiceStarting) applyVoiceBarVisibility(false);
}

// 主进程推来的识别事件：定稿进正文，实时片段只显示在聆听条上
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
        // 会话在用户没喊停的情况下结束（进程退出、音频设备被拔掉等）
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
    const button = voiceBarElement('btn-voice-dictate');
    if (button) button.onclick = () => startVoiceDictation();
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

    // 识别结果与失败都由主进程推来，这里只接一次
    ipcRenderer.on('speech:event', handleVoiceEvent);

    // Ctrl+Shift+M：起停随口记（入口关闭时快捷键一并失效）
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
