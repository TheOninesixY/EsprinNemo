const { ipcRenderer } = require('electron');
const path = require('path');

const ID_ARG_PREFIX = '--esprin-nemo-sticky-id=';
const DATA_DIR_PREFIX = '--esprin-nemo-data-dir=';
const STICKY_ID = (() => {
    const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith(ID_ARG_PREFIX));
    return matched ? matched.slice(ID_ARG_PREFIX.length).trim() : '';
})();
const DATA_DIR = (() => {
    const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith(DATA_DIR_PREFIX));
    return matched ? matched.slice(DATA_DIR_PREFIX.length).trim() : '';
})();

const STICKY_COLORS = [
    { key: 'yellow', label: '黄色', hue: 48 },
    { key: 'green', label: '绿色', hue: 96 },
    { key: 'blue', label: '蓝色', hue: 205 },
    { key: 'pink', label: '粉色', hue: 335 },
    { key: 'purple', label: '紫色', hue: 268 },
    { key: 'gray', label: '灰色', hue: 220 }
];

const SAVE_DELAY = 400;

const HINT_VISIBLE_MS = 2600;

const rootEl = document.getElementById('sticky-root');
const titleEl = document.getElementById('sticky-title');
const previewEl = document.getElementById('sticky-preview');
const contentEl = document.getElementById('sticky-content');
const doneRowEl = document.getElementById('sticky-done-row');
const doneEl = document.getElementById('sticky-done');
const editBtn = document.getElementById('sticky-edit');
const colorBtn = document.getElementById('sticky-color-btn');
const colorsEl = document.getElementById('sticky-colors');
const menuEl = document.getElementById('sticky-menu');
const menuCloseEl = document.getElementById('sticky-menu-close');
const hintEl = document.getElementById('sticky-hint');

let sticky = null;

let readonly = false;

let editing = false;

let savedTitle = null;
let savedContent = null;
let savedDone = false;
let saveTimer = null;
let hintTimer = null;
let colorsOpen = false;
let contextMenuOpen = false;

let ready = false;

titleEl.readOnly = true;
setEditButtonState(false);

function showHint(text, isError) {
    if (!text) return;
    hintEl.textContent = text;
    hintEl.classList.toggle('error', !!isError);
    hintEl.classList.add('show');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
        hintTimer = null;
        hintEl.classList.remove('show');
    }, HINT_VISIBLE_MS);
}

function reasonText(reason) {
    if (reason === 'readonly') return '条目在废纸篓中，无法保存';
    if (reason === 'locked') return '条目正文已加密，需在主窗口解锁后保存';
    if (reason === 'no-window') return '主窗口未就绪，内容暂存在便利贴里';
    if (reason === 'timeout') return '写入超时，内容暂存在便利贴里';
    if (reason === 'disabled') return '桌面便利贴已关闭';
    return '保存失败';
}

function clearSaveTimer() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
}

function hasChanges() {
    return titleEl.value !== savedTitle || contentEl.value !== savedContent || doneEl.checked !== savedDone;
}

function itemAssetsDir(itemId) {
    const safeName = String(itemId || '').replace(/[\\/:*?"<>|]/g, '_');
    return path.join(DATA_DIR, 'items', safeName);
}

function resolveStickyAssetPath(src) {
    if (!src || src.startsWith('http://') || src.startsWith('https://') ||
        src.startsWith('data:') || src.startsWith('file://')) {
        return src;
    }
    if (!DATA_DIR || !sticky || !sticky.refId) return src;
    const fullPath = path.join(itemAssetsDir(sticky.refId), src);
    const normalized = fullPath.replace(/\\/g, '/');
    return normalized.startsWith('//') ? `file:${normalized}` : `file:///${normalized.replace(/^\/+/, '')}`;
}

function renderPreview() {
    const text = contentEl.value;
    previewEl.innerHTML = text.trim() ? marked.parse(text) : '';

    previewEl.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') || '';
        if (src && src.includes('.')) {
            const resolvedSrc = resolveStickyAssetPath(src);
            if (resolvedSrc.startsWith('file://')) {
                img.src = resolvedSrc;
            }
        }
    });
}

function setEditButtonState(isEditing) {
    const icon = editBtn.querySelector('.ms-icon');
    if (icon) icon.textContent = isEditing ? 'check' : 'edit';
    editBtn.title = isEditing ? '完成' : '编辑';
}

function setEditing(next, { save = true } = {}) {
    if (editing === next) return;
    editing = next;
    rootEl.classList.toggle('editing', editing);
    setEditButtonState(editing);

    if (editing) {

        setColorsOpen(false);
        previewEl.classList.add('hidden');
        contentEl.classList.remove('hidden');
        titleEl.readOnly = false;

        if (!titleEl.value.trim()) {
            titleEl.focus();
            return;
        }
        contentEl.focus();
        contentEl.setSelectionRange(contentEl.value.length, contentEl.value.length);
        return;
    }

    titleEl.readOnly = true;
    contentEl.classList.add('hidden');
    previewEl.classList.remove('hidden');
    renderPreview();
    if (save) saveNow();
}

function applyColor(color) {
    const entry = STICKY_COLORS.find((item) => item.key === color) || STICKY_COLORS[0];
    document.body.dataset.stickyColor = entry.key;
    document.body.style.setProperty('--sticky-hue', String(entry.hue));
}

function applyDoneState() {
    const isTodo = !!sticky && sticky.kind === 'todo';
    doneRowEl.classList.toggle('hidden', !isTodo);
    rootEl.classList.toggle('done', isTodo && savedDone);
    if (!isTodo) return;

    doneEl.checked = savedDone;
    doneEl.disabled = readonly;
}

function applyReadonly() {
    rootEl.classList.toggle('readonly', readonly);
    editBtn.classList.toggle('hidden', readonly);
    if (!readonly) return;

    setEditing(false, { save: false });
    showHint('该内容为只读：条目在废纸篓中，或正文已加密需先在主窗口解锁', true);
}

function applySnapshot(snapshot) {
    sticky = snapshot;
    readonly = snapshot.readonly === true;

    titleEl.value = snapshot.title || '';
    contentEl.value = snapshot.content || '';
    savedTitle = titleEl.value;
    savedContent = contentEl.value;
    savedDone = snapshot.isDone === true;

    applyColor(snapshot.color);
    renderPreview();
    setEditing(false, { save: false });
    applyDoneState();
    applyReadonly();
}

async function saveNow() {
    clearSaveTimer();
    if (!ready || !hasChanges()) return true;

    const title = titleEl.value;
    const content = contentEl.value;
    const isDone = doneEl.checked;

    let result = null;
    try {
        result = await ipcRenderer.invoke('sticky:save', { title, content, isDone });
    } catch (err) {
        console.error('保存便利贴失败:', err);
    }

    if (result && result.ok) {
        savedTitle = title;
        savedContent = content;
        savedDone = isDone;

if (result.reason === 'missing') {
            sticky = { ...sticky, refId: '', kind: 'free' };
            readonly = false;
            renderPreview();
            applyDoneState();
            applyReadonly();
            showHint('原条目已不存在，内容留在便利贴上', true);
            return true;
        }

        const wasReadonly = readonly;
        readonly = result.readonly === true;
        if (readonly !== wasReadonly) applyReadonly();
        return true;
    }

    showHint(reasonText(result && result.reason), true);
    return false;
}

function scheduleSave() {
    clearSaveTimer();
    saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

function buildColors() {
    colorsEl.innerHTML = '';
    STICKY_COLORS.forEach((entry) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'sticky-color-swatch' + (sticky && sticky.color === entry.key ? ' active' : '');
        swatch.title = entry.label;
        swatch.dataset.color = entry.key;
        swatch.style.setProperty('--swatch-hue', String(entry.hue));
        colorsEl.appendChild(swatch);
    });
}

function setColorsOpen(next) {
    colorsOpen = next;
    if (colorsOpen) buildColors();
    colorsEl.classList.toggle('hidden', !colorsOpen);

    titleEl.classList.toggle('hidden', colorsOpen);
}

colorsEl.addEventListener('click', async (e) => {
    const swatch = e.target.closest('[data-color]');
    if (!swatch) return;

    const color = swatch.dataset.color;
    let result = null;
    try {
        result = await ipcRenderer.invoke('sticky:set-color', { color });
    } catch (err) {
        console.error('更改便利贴颜色失败:', err);
    }
    if (!result || !result.ok) return;

    applyColor(result.color);
    if (sticky) sticky.color = result.color;
    setColorsOpen(false);
});

function setContextMenuOpen(next, x = 0, y = 0) {
    contextMenuOpen = next;
    if (!contextMenuOpen) {
        menuEl.classList.add('hidden');
        return;
    }

    menuEl.classList.remove('hidden');

    const rect = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

menuCloseEl.onclick = () => {
    setContextMenuOpen(false);
    requestClose();
};

document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setColorsOpen(false);
    setContextMenuOpen(true, e.clientX, e.clientY);
});

document.addEventListener('mousedown', (e) => {
    if (colorsOpen && !e.target.closest('#sticky-colors') && !e.target.closest('#sticky-color-btn')) {
        setColorsOpen(false);
    }
    if (contextMenuOpen && !e.target.closest('#sticky-menu')) setContextMenuOpen(false);
    ipcRenderer.send('sticky:raise');
});

document.addEventListener('mouseup', () => {
    ipcRenderer.send('sticky:keep-bottom');
});

window.addEventListener('blur', () => {
    ipcRenderer.send('sticky:keep-bottom');
});

async function requestClose() {
    if (editing) await saveNow();

    const isFree = !sticky || !sticky.refId;
    const hasText = !!titleEl.value.trim() || !!contentEl.value.trim();
    if (isFree && hasText) {
        let choice = null;
        try {
            choice = await ipcRenderer.invoke('dialog:message', {
                type: 'question',
                icon: 'help',
                title: '桌面便利贴',
                message: '关闭并移除这张便利贴？',
                detail: '这张便利贴没有关联任何笔记或待办，纸上的内容只属于它自己，移除后无法恢复。',
                buttons: [
                    { id: 'cancel', label: '取消', cancel: true },
                    { id: 'remove', label: '移除', variant: 'danger' }
                ]
            });
        } catch (err) {
            console.error('打开确认窗口失败:', err);
            return;
        }
        if (!choice || choice.id !== 'remove') return;
    }

    ipcRenderer.invoke('sticky:close');
}

editBtn.onclick = () => setEditing(!editing);
colorBtn.onclick = (e) => {
    e.stopPropagation();
    setColorsOpen(!colorsOpen);
};

titleEl.addEventListener('input', scheduleSave);
contentEl.addEventListener('input', scheduleSave);

doneEl.addEventListener('change', async () => {
    let result = null;
    try {
        result = await ipcRenderer.invoke('sticky:toggle-done', { isDone: doneEl.checked });
    } catch (err) {
        console.error('更改完成状态失败:', err);
    }

    if (!result || !result.ok) {
        doneEl.checked = savedDone;
        applyDoneState();
        showHint(result && result.reason === 'readonly' ? '条目在废纸篓中，无法更改完成状态' : '更改完成状态失败', true);
        return;
    }

    savedDone = result.isDone === true;
    applyDoneState();
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (colorsOpen) {
            setColorsOpen(false);
            return;
        }
        if (contextMenuOpen) {
            setContextMenuOpen(false);
            return;
        }

        if (editing) setEditing(false);
        return;
    }

    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() !== 's') return;
    e.preventDefault();

    if (editing) setEditing(false);
    else saveNow();
});

window.addEventListener('blur', () => {
    setColorsOpen(false);
    setContextMenuOpen(false);
    if (!readonly) saveNow();
});

window.addEventListener('beforeunload', () => {
    if (readonly || !hasChanges()) return;
    ipcRenderer.send('sticky:flush', {
        id: STICKY_ID,
        title: titleEl.value,
        content: contentEl.value,
        isDone: doneEl.checked
    });
});

ipcRenderer.on('sticky:appearance', (event, payload) => {
    window.applyWindowAppearance(payload || {});
});

ipcRenderer.on('sticky:request-close', () => requestClose());

ipcRenderer.on('sticky:item', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    if (!sticky || !sticky.refId || data.itemId !== sticky.refId) return;

    if (data.exists === false) {
        sticky = { ...sticky, refId: '', kind: 'free' };
        readonly = false;
        applyDoneState();
        applyReadonly();
        showHint('原条目已不存在，内容留在便利贴上', true);
        return;
    }

    if (data.readonly === true) {
        readonly = true;
        applyReadonly();
        return;
    }

    if (titleEl.value !== savedTitle || contentEl.value !== savedContent) return;

    titleEl.value = data.title;
    contentEl.value = data.content;
    savedTitle = data.title;
    savedContent = data.content;
    savedDone = data.isDone === true;
    applyDoneState();
    if (!editing) renderPreview();
});

async function boot() {
    window.applyWindowAppearance(window.readWindowAppearanceFromArgs());

    if (!STICKY_ID) {
        showHint('便利贴标识缺失，无法载入内容', true);
        return;
    }

    let result = null;
    try {
        result = await ipcRenderer.invoke('sticky:resolve');
    } catch (err) {
        console.error('载入便利贴失败:', err);
    }

    if (!result || !result.ok) {
        showHint('便利贴记录已不存在', true);
        ready = true;
        return;
    }

    applySnapshot(result.sticky);
    ready = true;

    if (result.reason === 'missing') showHint('原条目已不存在，内容留在便利贴上', true);
    else if (result.reason === 'no-window' || result.reason === 'timeout') {
        showHint('主窗口未就绪，内容暂存在便利贴里', true);
    }
}

boot();