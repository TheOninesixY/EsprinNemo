const AI_ATTACHMENT_MAX = 6;

const AI_ATTACHMENT_IMPORT_MAX = 12;

const AI_ATTACHMENT_READ_MAX_BYTES = 10 * 1024 * 1024;

function aiAttachmentsDir() {
    return path.join(DATA_DIR, 'ai_files');
}

function resolveAiAttachmentPath(file) {
    return path.join(aiAttachmentsDir(), file);
}

function aiAttachmentFileUrl(file) {
    const name = typeof file === 'string' ? file : '';
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) return '';
    try {
        return require('url').pathToFileURL(resolveAiAttachmentPath(name)).href;
    } catch (err) {
        console.error('生成附件地址失败:', err);
        return '';
    }
}

function formatAiFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function aiAttachmentIcon(kind) {
    const icon = document.createElement('span');
    icon.className = 'ms-icon sm';
    icon.textContent = kind === 'image' ? 'image' : 'description';
    return icon;
}

async function importAiAttachments(payload) {
    let result = null;
    try {
        result = await ipcRenderer.invoke('ai:import-attachments', payload);
    } catch (err) {
        console.error('导入附件失败:', err);
        showToast('导入附件失败');
        return;
    }

    const attachments = (result && Array.isArray(result.attachments)) ? result.attachments : [];
    const errors = (result && Array.isArray(result.errors)) ? result.errors : [];

    if (errors.length) {

        errors.slice(0, 2).forEach(message => showToast(message));
    }
    if (!attachments.length) return;

    const list = State.aiPendingAttachments;
    let dropped = 0;
    attachments.forEach((item) => {
        if (list.length >= AI_ATTACHMENT_MAX) {
            dropped++;
            return;
        }
        list.push(item);
    });

    renderAiPendingAttachments();
    updateAiComposerState();
    if (dropped > 0) showToast(`一条消息最多带 ${AI_ATTACHMENT_MAX} 个附件，已忽略 ${dropped} 个`);
}

async function pickAiAttachments() {
    if (!isAiEnabled()) return;

    let picked = null;
    try {
        picked = await ipcRenderer.invoke('ai:pick-attachments');
    } catch (err) {
        console.error('打开文件选择框失败:', err);
        showToast('打开文件选择框失败');
        return;
    }
    if (!picked || picked.canceled || !Array.isArray(picked.paths) || !picked.paths.length) return;

    await importAiAttachments({ paths: picked.paths.slice(0, AI_ATTACHMENT_IMPORT_MAX) });
}

function aiFilePathFromFile(file) {
    try {
        if (typeof file.path === 'string' && file.path) return file.path;
        const { webUtils } = require('electron');
        if (webUtils && typeof webUtils.getPathForFile === 'function') {
            return webUtils.getPathForFile(file) || '';
        }
    } catch (err) {

    }
    return '';
}

function aiClipboardFiles(clipboardData) {
    const files = [];
    if (!clipboardData) return files;

    Array.from(clipboardData.files || []).forEach((file) => files.push(file));
    if (!files.length && clipboardData.items) {
        Array.from(clipboardData.items).forEach((item) => {
            if (item.kind !== 'file') return;
            const file = item.getAsFile();
            if (file) files.push(file);
        });
    }
    return files;
}

async function importAiAttachmentsFromFiles(files) {
    const paths = [];
    const blobs = [];
    let skipped = 0;

    for (const file of files.slice(0, AI_ATTACHMENT_IMPORT_MAX)) {
        const filePath = aiFilePathFromFile(file);
        if (filePath) {

            paths.push(filePath);
            continue;
        }
        if (Number(file.size) > AI_ATTACHMENT_READ_MAX_BYTES) {
            skipped++;
            continue;
        }

        try {
            const buffer = await file.arrayBuffer();
            blobs.push({
                name: file.name || `附件-${Date.now()}`,
                mime: file.type || '',
                data: new Uint8Array(buffer)
            });
        } catch (err) {
            console.error('读取拖入文件失败:', err);
            skipped++;
        }
    }

    if (skipped > 0) showToast(`已跳过 ${skipped} 个无法读取或过大的文件`);
    if (paths.length || blobs.length) await importAiAttachments({ paths, blobs });
}

function removeAiPendingAttachment(id) {
    const target = State.aiPendingAttachments.find(item => item.id === id);
    State.aiPendingAttachments = State.aiPendingAttachments.filter(item => item.id !== id);

    if (target && target.kind === 'image' && target.file) {
        releaseAiAttachments([{ attachments: [target] }]);
    }
    renderAiPendingAttachments();
    updateAiComposerState();
}

function clearAiPendingAttachments() {
    State.aiPendingAttachments = [];
    renderAiPendingAttachments();
}

function renderAiPendingAttachments() {
    const strip = document.getElementById('ai-attachment-strip');
    if (!strip) return;

    const list = State.aiPendingAttachments;
    strip.innerHTML = '';
    strip.classList.toggle('hidden', !list.length);
    list.forEach((file) => {
        strip.appendChild(createAiAttachmentChip(file, { onRemove: () => removeAiPendingAttachment(file.id) }));
    });
}

function createAiAttachmentChip(file, options = {}) {
    const chip = document.createElement('div');
    chip.className = `ai-attach-chip${file.kind === 'image' ? ' image' : ' text'}`;

    if (file.kind === 'image') {
        const url = aiAttachmentFileUrl(file.file);
        if (url) {
            const img = document.createElement('img');
            img.className = 'ai-attach-thumb';
            img.alt = file.name || '';
            img.src = url;
            img.onerror = () => img.replaceWith(aiAttachmentIcon('image'));
            chip.appendChild(img);
        } else {
            chip.appendChild(aiAttachmentIcon('image'));
        }
    } else {
        chip.appendChild(aiAttachmentIcon('text'));
    }

    const info = document.createElement('div');
    info.className = 'ai-attach-info';

    const name = document.createElement('div');
    name.className = 'ai-attach-name';
    name.textContent = file.name || '未命名文件';
    name.title = file.name || '';

    const meta = document.createElement('div');
    meta.className = 'ai-attach-meta';
    meta.textContent = `${file.kind === 'image' ? '图片' : '文本'} · ${formatAiFileSize(file.size)}`;

    info.appendChild(name);
    info.appendChild(meta);
    chip.appendChild(info);

    if (typeof options.onRemove === 'function') {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'ai-attach-remove';
        removeBtn.title = '移除附件';
        removeBtn.innerHTML = '<span class="ms-icon xs">close</span>';
        removeBtn.onclick = options.onRemove;
        chip.appendChild(removeBtn);
    }

    return chip;
}

function createAiAttachmentList(attachments) {
    const box = document.createElement('div');
    box.className = 'ai-attach-list';
    (Array.isArray(attachments) ? attachments : []).forEach((file) => {
        box.appendChild(createAiAttachmentChip(file));
    });
    return box;
}

function releaseAiAttachments(messages) {
    const files = [];
    (Array.isArray(messages) ? messages : []).forEach((msg) => {
        (Array.isArray(msg.attachments) ? msg.attachments : []).forEach((file) => {
            if (file && file.kind === 'image' && file.file) files.push(file.file);
        });
    });
    if (!files.length) return;

    ipcRenderer.invoke('ai:delete-attachments', { files }).catch((err) => {
        console.error('清理 AI 附件失败:', err);
    });
}

function guardDocumentFileDrop() {
    const blockFileDrag = (event) => {
        const types = event.dataTransfer && event.dataTransfer.types;
        if (!types || !Array.from(types).includes('Files')) return;
        event.preventDefault();
    };
    document.addEventListener('dragover', blockFileDrag);
    document.addEventListener('drop', blockFileDrag);
}

function initAiFiles() {
    const input = document.getElementById('ai-input');
    const panel = document.getElementById('ai-panel');
    if (!input || !panel) return;

    const attachBtn = document.getElementById('btn-ai-attach');
    if (attachBtn) attachBtn.onclick = () => pickAiAttachments();

    guardDocumentFileDrop();

input.addEventListener('paste', async (event) => {
        const files = aiClipboardFiles(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        await importAiAttachmentsFromFiles(files);
    });

['dragover', 'drop'].forEach((type) => {
        input.addEventListener(type, (event) => {
            const types = event.dataTransfer && event.dataTransfer.types;
            if (!types || !Array.from(types).includes('Files')) return;
            event.preventDefault();
        });
    });

panel.addEventListener('dragover', (event) => {
        if (!isAiEnabled() || !event.dataTransfer) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        panel.classList.add('drop-active');
    });

    panel.addEventListener('dragleave', (event) => {

        if (event.target === panel || !event.relatedTarget) panel.classList.remove('drop-active');
    });

    panel.addEventListener('drop', async (event) => {
        panel.classList.remove('drop-active');
        if (!isAiEnabled() || !event.dataTransfer) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files || []);
        if (files.length) await importAiAttachmentsFromFiles(files);
    });

    window.addEventListener('blur', () => panel.classList.remove('drop-active'));
}
