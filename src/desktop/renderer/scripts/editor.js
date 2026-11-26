const PREVIEW_REFRESH_DELAY = 1000;

let lastPreviewNoteId = null;
let lastPreviewContent = null;

function scheduleRenderMarkdown() {
    clearTimeout(State.previewTimer);
    State.previewTimer = setTimeout(() => {
        State.previewTimer = null;
        renderMarkdown();
    }, PREVIEW_REFRESH_DELAY);
}

function flushRenderMarkdown() {
    clearTimeout(State.previewTimer);
    State.previewTimer = null;
    renderMarkdown(true);
}

function isPreviewVisible() {
    return State.viewMode !== 'edit';
}

function renderMarkdown(force = false) {

if (!isPreviewVisible()) return;

    const item = getActiveItem();
    const itemId = item ? item.id : null;

    if (isSecretLocked(item)) {
        lastPreviewNoteId = itemId;
        lastPreviewContent = null;
        document.getElementById('preview-content').innerHTML = '';
        return;
    }
    const content = item ? (item.content || '') : '';

    if (!force && itemId === lastPreviewNoteId && content === lastPreviewContent) return;
    lastPreviewNoteId = itemId;
    lastPreviewContent = content;

    const container = document.getElementById('preview-content');
    if (!item) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = marked.parse(content || '*空内容*');

container.querySelectorAll('a').forEach((link) => {
        const rawHref = link.getAttribute('data-raw-href') || link.getAttribute('href') || '';
        if (!rawHref || rawHref.startsWith('http://') || rawHref.startsWith('https://') ||
            rawHref.startsWith('mailto:') || rawHref.startsWith('#') || rawHref.startsWith('//')) {
            return;
        }
        link.onclick = (e) => {
            e.preventDefault();
            const curItem = getActiveItem();
            if (!curItem) return;
            const fullPath = resolveItemAssetPath(curItem.id, rawHref);
            if (!fs.existsSync(fullPath)) {
                showToast('文件不存在: ' + rawHref);
                return;
            }
            ipcRenderer.invoke('assets:open-file', { path: rawHref, itemId: curItem.id }).then((res) => {
                if (res && !res.ok && res.error) {
                    showToast('打开附件失败: ' + res.error);
                }
            }).catch(() => {
                showToast('打开附件失败');
            });
        };
    });

    container.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') || '';
        if (!src || src.startsWith('http://') || src.startsWith('https://') ||
            src.startsWith('data:') || src.startsWith('file://')) {
            return;
        }
        const fullPath = resolveItemAssetPath(itemId, src);
        const normalized = fullPath.replace(/\\/g, '/');
        img.src = normalized.startsWith('//') ? `file:${normalized}` : `file:///${normalized.replace(/^\/+/, '')}`;
    });

    const taskLines = [];
    let inFence = false;
    String(item.content || '').split('\n').forEach((line, lineIndex) => {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            return;
        }
        if (inFence) return;
        if (/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/.test(line)) taskLines.push(lineIndex);
    });

    container.querySelectorAll('input[type="checkbox"]').forEach((cb, idx) => {
        cb.removeAttribute('disabled');
        cb.onchange = () => {

            const active = getActiveItem();
            if (!active || isReadOnlyItem(active)) return;
            const targetLine = taskLines[idx];
            if (targetLine === undefined) return;
            const lines = String(active.content || '').split('\n');
            lines[targetLine] = lines[targetLine].replace(/\[ \]|\[[xX]\]/, cb.checked ? '[x]' : '[ ]');
            active.content = lines.join('\n');
            document.getElementById('textarea-note-content').value = active.content;
            autoSaveActiveItem();
        };
    });
}

let lastStatsNoteId = null;
let lastStatsContent = null;
let lastStatsUpdatedAt = null;

const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\u{20000}-\u{3ffff}]/gu;

function countWords(text) {
    if (!text) return 0;
    const segments = text.split(CJK_CHAR_PATTERN);

    let words = 0;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i].trim();

        if (segment) words += segment.split(/\s+/).length;
    }
    return (segments.length - 1) + words;
}

function updateStats() {
    const item = getActiveItem();
    if (!item) return;

    const locked = isSecretLocked(item);

    const content = locked ? '' : (item.content || '');
    if (item.id === lastStatsNoteId && content === lastStatsContent && item.updatedAt === lastStatsUpdatedAt) return;
    lastStatsNoteId = item.id;
    lastStatsContent = content;
    lastStatsUpdatedAt = item.updatedAt;

    document.getElementById('stat-char-count').textContent = locked ? '字符: —' : `字符: ${content.length}`;
    document.getElementById('stat-word-count').textContent = locked ? '字数: —' : `字数: ${countWords(content)}`;
    document.getElementById('stat-last-edit').textContent = `修改于 ${formatDate(item.updatedAt)}`;
}

const READONLY_STATUS_TEXT = '只读 · 位于废纸篓';
const LOCKED_STATUS_TEXT = '只读 · 正文已加密';

function applyEditorReadOnly(item) {
    const readOnly = isReadOnlyItem(item);
    const locked = isSecretLocked(item);

    const titleInput = document.getElementById('input-note-title');
    const contentInput = document.getElementById('textarea-note-content');
    const folderSelect = document.getElementById('editor-folder-select');
    const addTagBtn = document.getElementById('btn-add-tag');
    const doneBtn = document.getElementById('btn-todo-done');

    titleInput.readOnly = readOnly;
    contentInput.readOnly = readOnly;
    folderSelect.disabled = readOnly;
    addTagBtn.disabled = readOnly;
    if (doneBtn) doneBtn.disabled = readOnly;

applyEditorToolbarState();

    const saveStatus = document.getElementById('save-status');
    if (readOnly) {
        saveStatus.textContent = locked ? LOCKED_STATUS_TEXT : READONLY_STATUS_TEXT;
    } else if (saveStatus.textContent === READONLY_STATUS_TEXT || saveStatus.textContent === LOCKED_STATUS_TEXT) {
        saveStatus.textContent = '就绪';
    }
}

function applySecretLockUI(item) {
    const overlay = document.getElementById('secret-lock-overlay');
    if (!overlay) return;

    const locked = isSecretLocked(item);
    overlay.classList.toggle('hidden', !locked);
    if (!locked) return;

    const title = document.getElementById('secret-lock-title');
    if (title) title.textContent = `《${itemDisplayTitle(item)}》的正文已加密`;

    const unlockBtn = document.getElementById('btn-secret-unlock');
    if (unlockBtn) unlockBtn.onclick = () => unlockItem(item.id);
}

function applyEditorToolbarState() {
    const toolbar = document.getElementById('editor-toolbar');
    if (!toolbar) return;
    const item = getActiveItem();
    const readOnly = !item || isReadOnlyItem(item);
    const preview = State.viewMode === 'preview';
    toolbar.classList.toggle('hidden', readOnly);
    toolbar.querySelectorAll('.fmt-btn').forEach((btn) => {
        btn.disabled = !readOnly && preview && btn.hasAttribute('data-fmt');
    });
    toolbar.querySelectorAll('select').forEach((select) => {
        select.disabled = !readOnly && preview;
    });
}

function updateViewModeUI() {
    const editPane = document.getElementById('editor-pane');
    const previewPane = document.getElementById('preview-pane');

    document.getElementById('btn-mode-edit').classList.toggle('active', State.viewMode === 'edit');
    document.getElementById('btn-mode-split').classList.toggle('active', State.viewMode === 'split');
    document.getElementById('btn-mode-preview').classList.toggle('active', State.viewMode === 'preview');

    if (State.viewMode === 'edit') {
        editPane.classList.remove('hidden');
        previewPane.classList.add('hidden');
    } else if (State.viewMode === 'split') {
        editPane.classList.remove('hidden');
        previewPane.classList.remove('hidden');
    } else {
        editPane.classList.add('hidden');
        previewPane.classList.remove('hidden');
    }

    applyEditorToolbarState();
}

function formatMarkdown(type) {
    const textarea = document.getElementById('textarea-note-content');
    if (!textarea || textarea.readOnly) return;
    if (State.viewMode === 'preview') return;

    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.substring(start, end);
    const hadSelection = end > start;

    const applyEdit = (next, nextStart, nextEnd) => {
        textarea.value = next;
        textarea.focus();
        textarea.setSelectionRange(nextStart, nextEnd);
        autoSaveActiveItem();
        flushRenderMarkdown();
    };

    const wrapInline = (prefix, suffix, placeholder) => {
        const inner = hadSelection ? selected : placeholder;
        const inserted = prefix + inner + suffix;
        const next = value.substring(0, start) + inserted + value.substring(end);
        const innerStart = start + prefix.length;
        applyEdit(next, innerStart, innerStart + inner.length);
    };

    const stripMarker = (content) => content.replace(/^(?:#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]?)/, '');

    const applyLineFormat = (prefixFor) => {
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = value.indexOf('\n', end);
        if (lineEnd === -1) lineEnd = value.length;
        const block = value.substring(lineStart, lineEnd);
        let counter = 0;
        const replaced = block.split('\n').map((line) => {
            if (!line.trim()) return line;
            const indentMatch = /^([ \t]*)([\s\S]*)$/.exec(line);
            const prefix = prefixFor(counter);
            counter += 1;
            return indentMatch[1] + prefix + stripMarker(indentMatch[2]);
        }).join('\n');
        const next = value.substring(0, lineStart) + replaced + value.substring(lineEnd);
        const blockEnd = lineStart + replaced.length;
        applyEdit(next, hadSelection ? lineStart : blockEnd, blockEnd);
    };

    const insertLink = () => {
        const label = hadSelection ? selected : '链接文本';
        const url = 'https://';
        const inserted = `[${label}](${url})`;
        const next = value.substring(0, start) + inserted + value.substring(end);
        if (hadSelection) {
            const urlStart = start + label.length + 3;
            applyEdit(next, urlStart, urlStart + url.length);
        } else {
            applyEdit(next, start + 1, start + 1 + label.length);
        }
    };

    const insertCodeBlock = () => {
        const body = hadSelection ? selected : '';
        const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
        const after = end < value.length && value[end] !== '\n' ? '\n' : '';
        const inserted = `${before}\`\`\`\n${body}\n\`\`\`${after}`;
        const next = value.substring(0, start) + inserted + value.substring(end);
        const bodyStart = start + before.length + 4;
        applyEdit(next, bodyStart, bodyStart + body.length);
    };

    const insertTable = () => {
        const table = '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |';
        const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
        const after = end < value.length && value[end] !== '\n' ? '\n' : '';
        const next = value.substring(0, start) + before + table + after + value.substring(end);
        const caret = start + before.length + table.length;
        applyEdit(next, caret, caret);
    };

    const insertRule = () => {
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = value.indexOf('\n', end);
        if (lineEnd === -1) lineEnd = value.length;
        const lineEmpty = !value.substring(lineStart, lineEnd).trim();
        const rule = lineEmpty ? '---' : '\n\n---';
        const next = value.substring(0, lineEnd) + rule + value.substring(lineEnd);
        const caret = lineEnd + rule.length;
        applyEdit(next, caret, caret);
    };

    switch (type) {
        case 'bold': wrapInline('**', '**', '加粗文本'); break;
        case 'italic': wrapInline('*', '*', '斜体文本'); break;
        case 'strike': wrapInline('~~', '~~', '删除文本'); break;
        case 'inline-code': wrapInline('`', '`', '行内代码'); break;
        case 'link': insertLink(); break;
        case 'h1': applyLineFormat(() => '# '); break;
        case 'h2': applyLineFormat(() => '## '); break;
        case 'h3': applyLineFormat(() => '### '); break;
        case 'h4': applyLineFormat(() => '#### '); break;
        case 'h5': applyLineFormat(() => '##### '); break;
        case 'h6': applyLineFormat(() => '###### '); break;
        case 'ul': applyLineFormat(() => '- '); break;
        case 'ol': applyLineFormat((index) => `${index + 1}. `); break;
        case 'task': applyLineFormat(() => '- [ ] '); break;
        case 'quote': applyLineFormat(() => '> '); break;
        case 'code': insertCodeBlock(); break;
        case 'table': insertTable(); break;
        case 'hr': insertRule(); break;
    }
}

const IMAGE_EXT_LIST = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'];

function isImageFileName(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    return IMAGE_EXT_LIST.includes(ext);
}

const VIDEO_EXT_LIST = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.ogv'];

function isVideoFileName(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    return VIDEO_EXT_LIST.includes(ext);
}

function resolveUniqueFileName(itemId, baseName) {
    const dir = ensureItemAssetsDir(itemId);
    let name = baseName;
    let counter = 1;
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length);
    while (fs.existsSync(path.join(dir, name))) {
        name = `${stem}_${counter}${ext}`;
        counter++;
    }
    return name;
}

function ensureActiveItemCommitted() {
    const item = getActiveItem();
    if (!item) return null;
    if (!isDraftId(item.id)) return item;

    flushPendingSave();
    const stillDraft = getDraft(item.id);
    const committed = stillDraft ? commitDraft(item.id, { force: true }) : null;
    if (stillDraft && !committed) return null;
    renderApp();
    return getItemById(committed ? committed.id : State.activeNoteId);
}

function saveAssetFile(sourcePath, buffer = null, originalName = '') {
    const item = ensureActiveItemCommitted();
    if (!item) return null;
    const itemId = item.id;
    const dir = ensureItemAssetsDir(itemId);
    const name = originalName || (sourcePath ? path.basename(sourcePath) : 'file.bin');
    const storedName = resolveUniqueFileName(itemId, name);
    const targetPath = path.join(dir, storedName);

    if (buffer) {
        fs.writeFileSync(targetPath, buffer);
    } else if (sourcePath) {
        fs.copyFileSync(sourcePath, targetPath);
    } else {
        return null;
    }
    notifyRemoteWrite(targetPath);
    return {
        name: storedName,
        relative: itemAssetRelativePath(itemId, storedName),
        isImage: isImageFileName(name)
    };
}

function insertAssetReferences(assetList) {
    if (!assetList || !assetList.length) return;
    const textarea = document.getElementById('textarea-note-content');
    if (!textarea || textarea.readOnly) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    let insertText = '';
    assetList.forEach((asset) => {
        const title = asset.name || '附件';
        if (asset.isImage) {
            insertText += `![${title}](${asset.relative})\n`;
        } else {
            insertText += `[${title}](${asset.relative})\n`;
        }
    });

    textarea.value = textarea.value.substring(0, start) + insertText + textarea.value.substring(end);
    const newPos = start + insertText.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    autoSaveActiveItem();
    flushRenderMarkdown();
}

async function pickAndInsertAssets() {
    const active = getActiveItem();
    if (!active) {
        showToast('请先打开或新建一篇笔记');
        return;
    }
    if (isReadOnlyItem(active)) {
        showToast('废纸篓中的内容为只读');
        return;
    }

    let picked = null;
    try {
        picked = await ipcRenderer.invoke('assets:pick-files');
    } catch (err) {
        console.error('[Desktop:ERROR] 打开文件选择对话框失败:', err);
        showToast('打开文件选择对话框失败');
        return;
    }
    if (!picked || picked.canceled || !Array.isArray(picked.paths) || !picked.paths.length) return;

    const saved = [];
    picked.paths.forEach((filePath) => {
        try {
            const asset = saveAssetFile(filePath);
            if (asset) saved.push(asset);
        } catch (err) {
            console.error('[Desktop:ERROR] 保存附件失败:', filePath, err);
        }
    });

    if (saved.length) {
        insertAssetReferences(saved);
        showToast(`已插入 ${saved.length} 个文件`);
    } else {
        showToast('插入文件失败');
    }
}

const FM_PANEL_WIDTH_TRANSITION_MS = 260;
const FM_PANEL_COLLAPSED_CLASS = 'fm-collapsed';

let fmPanelExpanded = false;
let fmPanelHideTimer = null;

function clearFmPanelHideTimer() {
    if (fmPanelHideTimer) {
        clearTimeout(fmPanelHideTimer);
        fmPanelHideTimer = null;
    }
}

function expandFmPanel(panel) {
    clearFmPanelHideTimer();
    panel.classList.add(FM_PANEL_COLLAPSED_CLASS);
    panel.classList.remove('hidden');
    void panel.offsetWidth;
    panel.classList.remove(FM_PANEL_COLLAPSED_CLASS);
}

function collapseFmPanel(panel) {
    panel.classList.add(FM_PANEL_COLLAPSED_CLASS);
    clearFmPanelHideTimer();
    fmPanelHideTimer = setTimeout(() => {
        fmPanelHideTimer = null;
        panel.classList.add('hidden');
    }, FM_PANEL_WIDTH_TRANSITION_MS + 60);
}

function hideFmPanelImmediately(panel) {
    clearFmPanelHideTimer();
    panel.classList.add(FM_PANEL_COLLAPSED_CLASS, 'hidden');
}

function applyFileManagerVisibility() {
    const panel = document.getElementById('fm-panel');
    const btn = document.getElementById('btn-file-manager');
    if (!panel) return;

    const inSettings = State.activeNoteId === 'settings';
    const show = !!State.fmPanelOpen && !!State.activeNoteId && !inSettings;
    if (btn) btn.classList.toggle('active', show);

    if (show === fmPanelExpanded) {
        return;
    }
    fmPanelExpanded = show;

    if (show) expandFmPanel(panel);
    else if (inSettings) hideFmPanelImmediately(panel);
    else collapseFmPanel(panel);
}

function toggleFileManager() {
    if (!State.activeNoteId || State.activeNoteId === 'settings') {
        showToast('请先打开一篇笔记或待办');
        return;
    }

    if (State.fmPanelOpen) {
        State.fmPanelOpen = false;
        applyFileManagerVisibility();
        return;
    }

    if (State.aiPanelOpen) {
        setAiPanelOpen(false);
    }

    State.fmPanelOpen = true;
    applyFileManagerVisibility();
    renderFileManager();
}

function renderFileManager() {
    const panel = document.getElementById('fm-panel');
    const list = document.getElementById('fm-file-list');
    const empty = document.getElementById('fm-empty');
    const count = document.getElementById('fm-file-count');
    if (!panel || !list) return;

    const item = getActiveItem();
    if (!item) { list.innerHTML = ''; return; }

    const files = listItemAssetFiles(item.id);
    list.innerHTML = '';
    if (empty) empty.classList.toggle('hidden', files.length > 0);

    if (count) count.textContent = `${files.length} 个文件`;

    const relativePrefix = `items/${item.id}/`;

    files.forEach((file) => {
        const sizeText = formatFileSize(file.size);
        const row = document.createElement('div');
        row.className = 'fm-file-row';
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', file.name);
            e.dataTransfer.setData('application/x-fm-file', JSON.stringify({
                name: file.name,
                itemId: item.id
            }));
            e.dataTransfer.effectAllowed = 'copy';
        });

        const icon = document.createElement('span');
        icon.className = 'icon sm fm-file-icon';
        setLucideIcon(icon, isImageFileName(file.name) ? 'image' : 'file-text');

        const info = document.createElement('div');
        info.className = 'fm-file-info';

        const nameEl = document.createElement('span');
        nameEl.className = 'fm-file-name';
        nameEl.textContent = file.name;
        nameEl.title = file.name;

        const sizeEl = document.createElement('span');
        sizeEl.className = 'fm-file-size';
        sizeEl.textContent = sizeText;

        info.appendChild(nameEl);
        info.appendChild(sizeEl);

        const actions = document.createElement('div');
        actions.className = 'fm-file-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'btn-action-icon fm-file-action';
        renameBtn.title = '重命名';
        renameBtn.innerHTML = '<span class="icon xs" data-lucide="pencil" aria-hidden="true"></span>';
        renameBtn.onclick = () => promptRenameItemFile(item, file.name);

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'btn-action-icon fm-file-action';
        downloadBtn.title = '下载/另存为';
        downloadBtn.innerHTML = '<span class="icon xs" data-lucide="download" aria-hidden="true"></span>';
        downloadBtn.onclick = () => downloadItemFile(item.id, file.name);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-action-icon fm-file-action fm-file-action-danger';
        deleteBtn.title = '删除';
        deleteBtn.innerHTML = '<span class="icon xs" data-lucide="trash-2" aria-hidden="true"></span>';
        deleteBtn.onclick = () => confirmDeleteItemFile(item, file.name);

        actions.appendChild(renameBtn);
        actions.appendChild(downloadBtn);
        actions.appendChild(deleteBtn);

        row.appendChild(icon);
        row.appendChild(info);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function downloadItemFile(itemId, filename) {
    try {
        const safeId = String(itemId || '').replace(/[\\/:*?"<>|]/g, '_');
        const result = await ipcRenderer.invoke('fm:save-file', { itemId: safeId, filename });
        if (result && !result.ok && result.error) {
            showToast(`下载失败: ${result.error}`);
        }
    } catch (err) {
        console.error('[Desktop:ERROR] 下载文件失败:', err);
        showToast('下载文件失败');
    }
}

function confirmDeleteItemFile(item, filename) {
    if (!item || isReadOnlyItem(item)) return;
    const confirmed = confirm(`确定要删除文件「${filename}」吗？此操作不可撤销。`);
    if (!confirmed) return;
    deleteItemFile(item, filename);
}

function deleteItemFile(item, filename) {
    if (!item || isReadOnlyItem(item)) return;
    try {
        const filePath = resolveItemAssetPath(item.id, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            notifyRemoteDelete(filePath);
        }
        renderFileManager();
        showToast(`已删除「${filename}」`);
    } catch (err) {
        console.error('[Desktop:ERROR] 删除文件失败:', err);
        showToast('删除文件失败');
    }
}

async function promptRenameItemFile(item, oldName) {
    if (!item || isReadOnlyItem(item)) return;
    const newName = await showPrompt('请输入新文件名：', {
        title: '重命名文件',
        placeholder: oldName,
        confirmLabel: '重命名',
        value: oldName
    });
    if (!newName || newName === oldName) return;
    if (!/^[^\\/:*?"<>|]{1,200}$/.test(newName)) {
        showToast('文件名包含非法字符或过长');
        return;
    }
    renameItemFile(item, oldName, newName);
}

function renameItemFile(item, oldName, newName) {
    if (!item || isReadOnlyItem(item)) return;
    const dir = itemAssetsDir(item.id);
    const oldPath = path.join(dir, oldName);
    const newPath = path.join(dir, newName);
    try {
        if (!fs.existsSync(oldPath)) {
            showToast('文件不存在');
            return;
        }
        if (fs.existsSync(newPath)) {
            showToast('已存在同名文件');
            return;
        }
        fs.renameSync(oldPath, newPath);
        notifyRemoteWrite(newPath);
        notifyRemoteDelete(oldPath);

        const oldRelative = itemAssetRelativePath(item.id, oldName);
        const newRelative = itemAssetRelativePath(item.id, newName);
        updateItemFileReferences(item, oldRelative, newRelative);

        renderFileManager();
        showToast(`已重命名为「${newName}」`);
    } catch (err) {
        console.error('[Desktop:ERROR] 重命名文件失败:', err);
        showToast('重命名文件失败');
    }
}

function updateItemFileReferences(item, oldRelative, newRelative) {
    const textarea = document.getElementById('textarea-note-content');
    if (!textarea) return;

    let content = textarea.value;
    let changed = false;

    content = content.split(oldRelative).join(newRelative);
    if (content !== textarea.value) changed = true;

    if (changed) {
        textarea.value = content;
        autoSaveActiveItem();
        flushRenderMarkdown();
    }
}

const INDENT_UNIT = '\t';

function handleContentTab(e) {
    const textarea = document.getElementById('textarea-note-content');
    if (!textarea || textarea.readOnly) return;
    e.preventDefault();

    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;

    if (e.shiftKey) {

        const singleLine = start === end;
        let lineEnd = value.indexOf('\n', singleLine ? start : end);
        if (lineEnd === -1) lineEnd = value.length;

        const lines = value.slice(lineStart, lineEnd).split('\n');
        let removedFirst = 0;
        const newLines = lines.map((line, idx) => {
            const m = line.match(/^(?:\t| {1,4})/);
            if (!m) return line;
            if (idx === 0) removedFirst = m[0].length;
            return line.slice(m[0].length);
        });
        const newBlock = newLines.join('\n');
        textarea.value = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);

        if (singleLine) {
            const caret = Math.max(lineStart, start - removedFirst);
            textarea.setSelectionRange(caret, caret);
        } else {
            textarea.setSelectionRange(
                Math.max(lineStart, start - removedFirst),
                lineStart + newBlock.length
            );
        }
    } else if (start === end) {

        textarea.value = value.slice(0, start) + INDENT_UNIT + value.slice(end);
        const caret = start + INDENT_UNIT.length;
        textarea.setSelectionRange(caret, caret);
    } else {

        let lineEnd = value.indexOf('\n', end);
        if (lineEnd === -1) lineEnd = value.length;

        let inserted = 0;
        const newBlock = value.slice(lineStart, lineEnd).split('\n').map(line => {
            if (!line.length) return line;
            inserted++;
            return INDENT_UNIT + line;
        }).join('\n');
        textarea.value = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
        textarea.setSelectionRange(
            start + INDENT_UNIT.length,
            end + INDENT_UNIT.length * inserted
        );
    }

    textarea.focus();
    autoSaveActiveItem();
    scheduleRenderMarkdown();
}

let fmDropCursorPos = null;

function setupEditorDrop() {
    const textarea = document.getElementById('textarea-note-content');
    if (!textarea) return;

    textarea.addEventListener('dragover', (e) => {
        const data = e.dataTransfer;
        if (!data.types.includes('application/x-fm-file')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        fmDropCursorPos = textarea.selectionStart;
    });

    textarea.addEventListener('drop', (e) => {
        const raw = e.dataTransfer.getData('application/x-fm-file');
        if (!raw) return;
        e.preventDefault();

        let fileInfo;
        try {
            fileInfo = JSON.parse(raw);
        } catch {
            return;
        }
        const name = fileInfo.name;
        if (!name) return;

        if (textarea.readOnly) return;
        const start = fmDropCursorPos != null ? fmDropCursorPos : textarea.selectionStart;
        const end = textarea.selectionEnd;
        fmDropCursorPos = null;

        let insertText;
        if (isImageFileName(name)) {
            insertText = `![${name}](${name})`;
        } else if (isVideoFileName(name)) {
            insertText = `<video src="${name}" controls></video>`;
        } else {
            insertText = `[${name}](${name})`;
        }

        textarea.value = textarea.value.substring(0, start) + insertText + textarea.value.substring(end);
        const newPos = start + insertText.length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();
        autoSaveActiveItem();
        flushRenderMarkdown();
    });
}

setupEditorDrop();
