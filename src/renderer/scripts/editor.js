/* 编辑器：Markdown 预览刷新、字数统计、只读态与视图模式，以及格式化与 Tab 缩进。
   编辑器同时服务于笔记与待办，取用当前条目一律走 getActiveItem()。 */

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

// 是否处于「必须解析预览」的场景：编辑视图下预览区整块隐藏，
// 解析出来的 HTML 没有任何人看（见 updateViewModeUI）
function isPreviewVisible() {
    return State.viewMode !== 'edit';
}

// force 为 true 时强制重解析；否则内容与上次一致就直接返回
function renderMarkdown(force = false) {
    // 预览区不可见（默认的编辑视图）时整个跳过：既不解析 Markdown，也不给隐藏的容器写 innerHTML。
    // 切换视图模式的按钮会先把 viewMode 改成分屏 / 预览再调用 flushRenderMarkdown，
    // 因此真正要看预览时这里一定放行；编辑过程中的延时刷新与切换条目则一路省掉。
    // 跳过后指纹不更新，等预览可见时自然会完整解析一次，看到的始终是最新内容。
    if (!isPreviewVisible()) return;

    const item = getActiveItem();
    const itemId = item ? item.id : null;
    // 加密且未解锁的条目：正文还是密文，解析出来没有意义，预览直接留空
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

    container.querySelectorAll('input[type="checkbox"]').forEach((cb, idx) => {
        cb.removeAttribute('disabled');
        cb.onchange = () => {
            // 重新取回当前条目，避免闭包引用已被替换的旧对象
            const active = getActiveItem();
            if (!active || isReadOnlyItem(active)) return;
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
            autoSaveActiveItem();
        };
    });
}

// 统计信息同样按内容指纹去重：长文档的截词统计开销不低
let lastStatsNoteId = null;
let lastStatsContent = null;
let lastStatsUpdatedAt = null;

/* 中英混排的字数统计：CJK / 谚文按「字」计，其余按空白分词计。
   旧实现一律按空白分词，一整段中文会被算成 1 个字，与「字数」的直觉完全不符。

   这里用一次 split 同时得到两件事：分隔符的出现次数就是 CJK 字数，
   切出来的各段则正好是需要按空白分词的西文部分。
   相比「match 出全部 CJK 字符 + 把整篇正文 replace 成一个去掉汉字的新字符串」，
   少了一次与正文等长的字符串分配——自动保存每 300ms 就会走一遍这里，
   长篇中文文档下这一步省下的内存与时间都很可观。 */
const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\u{20000}-\u{3ffff}]/gu;

function countWords(text) {
    if (!text) return 0;
    const segments = text.split(CJK_CHAR_PATTERN);
    // split 的分段数比分隔符数多 1，因此 CJK 字数就是 segments.length - 1
    let words = 0;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i].trim();
        // 去掉 CJK 字符后按空白分词，标点与英文单词因此不会被并入中文字数
        if (segment) words += segment.split(/\s+/).length;
    }
    return (segments.length - 1) + words;
}

function updateStats() {
    const item = getActiveItem();
    if (!item) return;

    const locked = isSecretLocked(item);
    // 加密且未解锁的条目正文是密文：字数与字符数无从统计，用占位符代替
    const content = locked ? '' : (item.content || '');
    if (item.id === lastStatsNoteId && content === lastStatsContent && item.updatedAt === lastStatsUpdatedAt) return;
    lastStatsNoteId = item.id;
    lastStatsContent = content;
    lastStatsUpdatedAt = item.updatedAt;

    document.getElementById('stat-char-count').textContent = locked ? '字符: —' : `字符: ${content.length}`;
    document.getElementById('stat-word-count').textContent = locked ? '字数: —' : `字数: ${countWords(content)}`;
    document.getElementById('stat-last-edit').textContent = `修改于 ${formatDate(item.updatedAt)}`;
}

// 只读模式：废纸篓中的条目与还差一道密码的加密条目只能查看与导出，所有编辑入口统一在这里关闭
const READONLY_STATUS_TEXT = '只读 · 位于废纸篓';
const LOCKED_STATUS_TEXT = '只读 · 正文已加密';

function applyEditorReadOnly(item) {
    const readOnly = isReadOnlyItem(item);
    const locked = isSecretLocked(item);

    const titleInput = document.getElementById('input-note-title');
    const contentInput = document.getElementById('textarea-note-content');
    const toolbar = document.getElementById('editor-toolbar');
    const folderSelect = document.getElementById('editor-folder-select');
    const addTagBtn = document.getElementById('btn-add-tag');
    const doneBtn = document.getElementById('btn-todo-done');

    titleInput.readOnly = readOnly;
    contentInput.readOnly = readOnly;
    folderSelect.disabled = readOnly;
    addTagBtn.disabled = readOnly;
    if (doneBtn) doneBtn.disabled = readOnly;

    // 只读时排版工具栏没有意义，直接隐藏（上方已确保非只读时恢复显示）
    toolbar.classList.toggle('hidden', readOnly);

    const saveStatus = document.getElementById('save-status');
    if (readOnly) {
        saveStatus.textContent = locked ? LOCKED_STATUS_TEXT : READONLY_STATUS_TEXT;
    } else if (saveStatus.textContent === READONLY_STATUS_TEXT || saveStatus.textContent === LOCKED_STATUS_TEXT) {
        saveStatus.textContent = '就绪';
    }
}

/* 加密且未解锁的条目：编辑区盖上锁面板，正文与统计一并让位给「输入密码」这一个动作。
   其余情况（没设密码，或本轮已经解开）把面板收起，编辑区照常可用 */
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
    autoSaveActiveItem();
    flushRenderMarkdown();
}

// 编辑器内 Tab 缩进：按 Tab 不再切换焦点，而是插入缩进
// - 光标处：插入一个缩进单位
// - 选中多行：整块缩进
// - Shift+Tab：减少缩进
// 缩进单位是真正的制表符（\t），不是空格：源文件里存的就是缩进符号本身，
// 显示宽度由样式里的 tab-size 决定（见 styles/editor.css 的 .editor-textarea）
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
    autoSaveActiveItem();
    scheduleRenderMarkdown();
}
