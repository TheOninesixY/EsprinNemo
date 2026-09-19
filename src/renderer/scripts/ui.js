/* 通用工具与消息弹窗：时间格式化、HTML 转义、Toast，以及由主进程承载的独立弹窗 */

function formatDate(timestamp) {
    const d = new Date(timestamp);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
}

function showToast(msg) {
    const container = document.getElementById('toast-container');
    const item = document.createElement('div');
    item.className = 'toast-item';
    item.innerHTML = `<span class="ms-icon sm">info</span><span>${escapeHTML(msg)}</span>`;
    container.appendChild(item);
    setTimeout(() => {
        item.style.opacity = '0';
        item.style.transition = 'opacity 0.2s';
        setTimeout(() => item.remove(), 200);
    }, 1800);
}

// 所有消息弹窗都由主进程创建独立窗口（自绘标题栏，非窗口内假窗口）
// 三个入口与浏览器原生 alert/confirm/prompt 的用法保持一致，便于替换
async function showAlert(message, options = {}) {
    try {
        await ipcRenderer.invoke('dialog:message', {
            type: options.type || 'info',
            icon: options.icon,
            title: options.title || '提示',
            message,
            detail: options.detail || '',
            buttons: [{ id: 'ok', label: options.confirmLabel || '确定', variant: 'primary' }]
        });
    } catch (err) {
        console.error('打开消息窗口失败:', err);
    }
}

async function showConfirm(message, options = {}) {
    try {
        const result = await ipcRenderer.invoke('dialog:message', {
            type: options.type || 'question',
            icon: options.icon,
            title: options.title || '确认操作',
            message,
            detail: options.detail || '',
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
