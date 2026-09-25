/* 通用工具与消息弹窗：时间格式化、HTML 转义、Toast，以及由主进程承载的独立弹窗 */

/* 时间格式化：列表里每张卡片都要显示时间，而列表在每次界面刷新时都会重新计算一遍，
   同一批时间戳会被反复格式化（toLocaleTimeString 走 ICU，开销不低）。
   这里按「分钟」缓存三种候选文本，命中缓存时只剩一次字符串比较。 */

const DATE_TEXT_CACHE = new Map();
// 缓存条数上限：超过后整体清空，避免长时间驻留累积过多条目
const DATE_TEXT_CACHE_LIMIT = 512;

// Toast 停留时长与退场动画时长（动画定义见 styles/overlays.css 的 .toast-item.is-leaving，
// 节点在这段动画跑完后才被摘掉，否则动画会被截断）
const TOAST_VISIBLE_MS = 1800;
const TOAST_LEAVE_MS = 200;

function buildDateTexts(time) {
    const d = new Date(time);
    return {
        // 判断是否为当天的依据
        day: d.toDateString(),
        // 当天：只显示时刻
        time: d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        // 非当天：显示月日
        date: `${d.getMonth() + 1}月${d.getDate()}日`
    };
}

/* 「今天」的判定基准：列表里每张卡片都要拿它比一次。
   原先是每次调用都 new Date().toDateString()，一张卡片就多一次日期对象与一次字符串拼接；
   这里按分钟缓存一次，跨零点后自动换新值（与上面的分钟缓存同一步调）。 */
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
    // 以「当天」为界，跨零点时不会取到过期结果
    return entry.day === currentDayKey() ? entry.time : entry.date;
}

// 转义表提到函数外，避免每次调用都重新创建字面量对象
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
    // 退场交给样式表里的动画（原来是就地写行内样式）：曲线与时长跟其余动效同一套，
    // 并且「减少动态效果」下能跟着一起降级——动画关掉、换成纯透明度过渡，见 overlays.css
    setTimeout(() => {
        item.classList.add('is-leaving');
        setTimeout(() => item.remove(), TOAST_LEAVE_MS);
    }, TOAST_VISIBLE_MS);
}

// 所有消息弹窗都由主进程创建独立窗口（自绘标题栏，非窗口内假窗口）
// 入口与浏览器原生 confirm/prompt 的用法保持一致，便于替换
async function showConfirm(message, options = {}) {
    try {
        const result = await ipcRenderer.invoke('dialog:message', {
            type: options.type || 'question',
            icon: options.icon,
            title: options.title || '确认操作',
            message,
            detail: options.detail || '',
            // 自动关闭时长（毫秒）：到点没回应按「取消」处理。
            // 设置类改动用它做超时回退（见 appearance.js 的自定义界面尺寸）
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

// 输入类弹窗的共用调用，inputConfig 为输入框配置（可含候选项列表）
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

// 单值输入：返回去除首尾空格后的内容，取消返回 null
async function showPrompt(message, options = {}) {
    const result = await runInputDialog(message, options, {
        value: options.value || '',
        placeholder: options.placeholder || '',
        label: options.label || ''
    }, '输入');
    if (!result || result.id !== 'confirm') return null;
    return typeof result.value === 'string' ? result.value.trim() : '';
}

/* 口令输入：与 showPrompt 同一套用法，区别是输入框不回显明文（见 main/dialog_window.js 的 input.type）。
   返回原样输入的内容（口令不去首尾空白，空格本身也可以是口令的一部分），取消返回 null。 */
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

// 输入 + 已有候选项多选：返回 { value, selected }，取消返回 null
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
