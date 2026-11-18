const DATE_TEXT_CACHE = new Map();

const DATE_TEXT_CACHE_LIMIT = 512;

const TOAST_VISIBLE_MS = 1800;
const TOAST_LEAVE_MS = 200;

function buildDateTexts(time) {
    const d = new Date(time);
    return {

        day: d.toDateString(),

        time: d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),

        date: `${d.getMonth() + 1}月${d.getDate()}日`
    };
}

let todayKeyMinute = -1;
let todayKeyValue = '';

function currentDayKey() {
    const minute = Math.floor(Date.now() / 60000);
    if (minute !== todayKeyMinute) {
        todayKeyMinute = minute;
        todayKeyValue = new Date().toDateString();
    }
    return todayKeyValue;
}

function formatDate(timestamp) {
    const time = Number(timestamp);
    if (!Number.isFinite(time)) return '';

    const minuteKey = Math.floor(time / 60000);
    let entry = DATE_TEXT_CACHE.get(minuteKey);
    if (!entry) {
        entry = buildDateTexts(time);
        if (DATE_TEXT_CACHE.size >= DATE_TEXT_CACHE_LIMIT) DATE_TEXT_CACHE.clear();
        DATE_TEXT_CACHE.set(minuteKey, entry);
    }

    return entry.day === currentDayKey() ? entry.time : entry.date;
}

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };

function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => HTML_ESCAPE_MAP[m]);
}

function showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const item = document.createElement('div');
    item.className = 'toast-item';
    item.innerHTML = `<span class="ms-icon sm">info</span><span>${escapeHTML(msg)}</span>`;
    container.appendChild(item);

setTimeout(() => {
        item.classList.add('is-leaving');
        setTimeout(() => item.remove(), TOAST_LEAVE_MS);
    }, TOAST_VISIBLE_MS);
}

async function showConfirm(message, options = {}) {
    try {
        const result = await ipcRenderer.invoke('dialog:message', {
            type: options.type || 'question',
            icon: options.icon,
            title: options.title || '确认操作',
            message,
            detail: options.detail || '',

timeoutMs: options.timeoutMs || 0,
            buttons: [
                { id: 'cancel', label: options.cancelLabel || '取消', cancel: true },
                { id: 'confirm', label: options.confirmLabel || '确定', variant: options.danger ? 'danger' : 'primary' }
            ]
        });
        return !!result && result.id === 'confirm';
    } catch (err) {
        console.error('打开确认窗口失败:', err);
        return false;
    }
}

async function runInputDialog(message, options, inputConfig, defaultTitle) {
    try {
        return await ipcRenderer.invoke('dialog:message', {
            type: options.type || 'question',
            icon: options.icon,
            title: options.title || defaultTitle,
            message,
            detail: options.detail || '',
            width: options.width,
            input: inputConfig,
            buttons: [
                { id: 'cancel', label: options.cancelLabel || '取消', cancel: true },
                { id: 'confirm', label: options.confirmLabel || '确定', variant: 'primary' }
            ]
        });
    } catch (err) {
        console.error('打开输入窗口失败:', err);
        return null;
    }
}

async function showPrompt(message, options = {}) {
    const result = await runInputDialog(message, options, {
        value: options.value || '',
        placeholder: options.placeholder || '',
        label: options.label || ''
    }, '输入');
    if (!result || result.id !== 'confirm') return null;
    return typeof result.value === 'string' ? result.value.trim() : '';
}

async function showPasswordPrompt(message, options = {}) {
    const result = await runInputDialog(message, options, {
        value: options.value || '',
        placeholder: options.placeholder || '',
        label: options.label || '',
        type: 'password'
    }, '输入密码');
    if (!result || result.id !== 'confirm') return null;
    return typeof result.value === 'string' ? result.value : '';
}

async function showPromptWithChoices(message, options = {}) {
    const result = await runInputDialog(message, options, {
        value: options.value || '',
        placeholder: options.placeholder || '',
        label: options.label || '',
        choices: Array.isArray(options.choices) ? options.choices : [],
        selected: Array.isArray(options.selected) ? options.selected : [],
        multiple: options.multiple !== false
    }, '选择');
    if (!result || result.id !== 'confirm') return null;
    return {
        value: typeof result.value === 'string' ? result.value.trim() : '',
        selected: Array.isArray(result.selected) ? result.selected : []
    };
}
