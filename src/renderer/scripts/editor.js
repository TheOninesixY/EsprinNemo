/* 编辑器：Markdown 预览刷新、字数统计、只读态与视图模式，以及格式化与 Tab 缩进 */

// MD 预览刷新节流：连续输入时每次字符变动都重置计时，
// 只有静默满 1 秒才真正重新解析 Markdown 并刷新预览
const PREVIEW_REFRESH_DELAY = 1000;

// 已渲染内容指纹：笔记与正文都没变时跳过整篇解析与 DOM 重建
let lastPreviewNoteId = null;
let lastPreviewContent = null;

function scheduleRenderMarkdown() {
    clearTimeout(State.previewTimer);
    State.previewTimer = setTimeout(() => {
        State.previewTimer = null;
        renderMarkdown();
    }, PREVIEW_REFRESH_DELAY);
}

// 立即刷新，并取消等待中的延时刷新（切换笔记/视图等场景要即时看到结果）
function flushRenderMarkdown() {
    clearTimeout(State.previewTimer);
    State.previewTimer = null;
    renderMarkdown(true);
}

// force 为 true 时强制重解析；否则内容与上次一致就直接返回
function renderMarkdown(force = false) {
    const note = getActiveNote();
    const noteId = note ? note.id : null;
    const content = note ? (note.content || '') : '';

    if (!force && noteId === lastPreviewNoteId && content === lastPreviewContent) return;
    lastPreviewNoteId = noteId;
    lastPreviewContent = content;

    const container = document.getElementById('preview-content');
    if (!note) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = marked.parse(content || '*空内容*');

    container.querySelectorAll('input[type="checkbox"]').forEach((cb, idx) => {
        cb.removeAttribute('disabled');
        cb.onchange = () => {
            // 重新取回当前笔记，避免闭包引用已被替换的旧对象
            const active = getActiveNote();
            if (!active || isReadOnlyNote(active)) return;
            let curIdx = 0;
            active.content = (active.content || '').replace(/(- \[ ]|- \[x])/gi, (match) => {
                if (curIdx === idx) {
                    curIdx++;
                    return cb.checked ? '- [x]' : '- [ ]';
                }
                curIdx++;
                return match;
            });
            document.getElementById('textarea-note-content').value = active.content;
            autoSaveNote();
        };
    });
}

// 统计信息同样按内容指纹去重：长文档的截词统计开销不低
let lastStatsNoteId = null;
let lastStatsContent = null;
let lastStatsUpdatedAt = null;

function updateStats() {
    const note = getActiveNote();
    if (!note) return;

    const content = note.content || '';
    if (note.id === lastStatsNoteId && content === lastStatsContent && note.updatedAt === lastStatsUpdatedAt) return;
    lastStatsNoteId = note.id;
    lastStatsContent = content;
    lastStatsUpdatedAt = note.updatedAt;

    document.getElementById('stat-char-count').textContent = `字符: ${content.length}`;
    const trimmed = content.trim();
    document.getElementById('stat-word-count').textContent = `字数: ${trimmed ? trimmed.split(/\s+/).length : 0}`;
    document.getElementById('stat-last-edit').textContent = `修改于 ${formatDate(note.updatedAt)}`;
}

// 只读模式：废纸篓中的笔记只能查看与导出，所有编辑入口统一在这里关闭
const READONLY_STATUS_TEXT = '只读 · 位于废纸篓';

function applyEditorReadOnly(note) {
    const readOnly = isReadOnlyNote(note);

    const titleInput = document.getElementById('input-note-title');
    const contentInput = document.getElementById('textarea-note-content');
    const toolbar = document.getElementById('editor-toolbar');
    const folderSelect = document.getElementById('editor-folder-select');
    const addTagBtn = document.getElementById('btn-add-tag');
    const pinBtn = document.getElementById('btn-note-pin');
    const trashBtn = document.getElementById('btn-note-trash');

    titleInput.readOnly = readOnly;
    contentInput.readOnly = readOnly;
    folderSelect.disabled = readOnly;
    addTagBtn.disabled = readOnly;
    pinBtn.disabled = readOnly;

    // 只读时排版工具栏没有意义，直接隐藏（上方已确保非只读时恢复显示）
    toolbar.classList.toggle('hidden', readOnly);

    // 同一个按钮承担两种语义：普通笔记=移入废纸篓，废纸篓中=恢复
    const trashIcon = trashBtn.querySelector('.ms-icon');
    if (trashIcon) trashIcon.textContent = readOnly ? 'restore_from_trash' : 'delete';
    trashBtn.title = readOnly ? '恢复笔记' : '放入废纸篓';

    const saveStatus = document.getElementById('save-status');
    if (readOnly) {
        saveStatus.textContent = READONLY_STATUS_TEXT;
    } else if (saveStatus.textContent === READONLY_STATUS_TEXT) {
        saveStatus.textContent = '就绪';
    }
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
}

// Markdown Formatter Shortcuts
function formatMarkdown(type) {
    const textarea = document.getElementById('textarea-note-content');
    if (textarea.readOnly) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const sel = textarea.value.substring(start, end);
    let ins = '';

    switch (type) {
        case 'bold': ins = `**${sel || '加粗文本'}**`; break;
        case 'italic': ins = `*${sel || '斜体文本'}*`; break;
        case 'h1': ins = `# ${sel || '一级标题'}`; break;
        case 'h2': ins = `## ${sel || '二级标题'}`; break;
        case 'h3': ins = `### ${sel || '三级标题'}`; break;
        case 'ul': ins = `- ${sel || '列表项目'}`; break;
        case 'ol': ins = `1. ${sel || '列表项目'}`; break;
        case 'task': ins = `- [ ] ${sel || '待办项'}`; break;
        case 'quote': ins = `> ${sel || '引用内容'}`; break;
        case 'code': ins = `\`\`\`javascript\n${sel || '// 代码块'}\n\`\`\``; break;
        case 'hr': ins = `\n---\n`; break;
    }

    textarea.value = textarea.value.substring(0, start) + ins + textarea.value.substring(end);
    textarea.focus();
    autoSaveNote();
    flushRenderMarkdown();
}

// 编辑器内 Tab 缩进：按 Tab 不再切换焦点，而是插入缩进
// - 光标处：插入一个缩进单位
// - 选中多行：整块缩进
// - Shift+Tab：减少缩进
const INDENT_UNIT = '    ';

function handleContentTab(e) {
    const textarea = document.getElementById('textarea-note-content');
    if (!textarea || textarea.readOnly) return;
    e.preventDefault();

    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;

    if (e.shiftKey) {
        // 反缩进：去掉选中行（或光标所在行）行首的一个缩进单位
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
        // 光标处直接插入缩进（空行也会插入，方便续写缩进内容）
        textarea.value = value.slice(0, start) + INDENT_UNIT + value.slice(end);
        const caret = start + INDENT_UNIT.length;
        textarea.setSelectionRange(caret, caret);
    } else {
        // 选中内容跨行时整体缩进（行内选中同样按整行处理）
        let lineEnd = value.indexOf('\n', end);
        if (lineEnd === -1) lineEnd = value.length;

        let inserted = 0;
        const newBlock = value.slice(lineStart, lineEnd).split('\n').map(line => {
            if (!line.length) return line; // 空行不缩进，避免产生行尾空白
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
    autoSaveNote();
    scheduleRenderMarkdown();
}
