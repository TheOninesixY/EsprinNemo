/* 小本本联动（主窗口侧）：应答主进程转发的便利贴请求——列出笔记、打开、新建与保存。
   笔记数据的读写全部发生在主窗口（State + 磁盘），便利贴只负责显示与输入，
   两个窗口因此不会各存一份内容、互相覆盖。 */

// 便利贴可打开 / 可关联的笔记：废纸篓、隐藏与加密的笔记都不参与选择
function scratchpadNoteList() {
    return State.notes
        .filter(note => !note.isTrashed && !isSecretHidden(note) && note.locked !== true)
        .map(note => ({
            id: note.id,
            title: note.title || '',
            folder: note.folder || '默认',
            isPinned: !!note.isPinned,
            updatedAt: note.updatedAt || 0
        }))
        .sort((a, b) => (b.isPinned - a.isPinned) || (b.updatedAt - a.updatedAt));
}

// 应答主进程：请求带着 id 转发过来，必须原样带回，主进程据此兑现对应的 Promise
function replyToHost(payload) {
    try {
        ipcRenderer.send('scratchpad:reply', payload);
    } catch (err) {
        console.error('回复小本本请求失败:', err);
    }
}

// 小本本标题为空时用正文首个非空行兜底：去掉 Markdown 前缀，过长则截断
const SCRATCHPAD_TITLE_MAX_LENGTH = 30;

function scratchpadFallbackTitle(content) {
    const firstLine = String(content || '').split('\n').map(line => line.trim()).find(line => line.length) || '';
    const cleaned = firstLine.replace(/^#{1,6}\s*/, '').replace(/^[-*+>]\s+/, '').trim();
    return cleaned.length > SCRATCHPAD_TITLE_MAX_LENGTH ? cleaned.slice(0, SCRATCHPAD_TITLE_MAX_LENGTH) : cleaned;
}

// 后台新建笔记：不切换标签页、不抢焦点，只把新笔记并入列表与侧边栏统计
function createNoteFromScratchpad(title, content) {
    const text = typeof content === 'string' ? content : '';
    const defaults = newNoteDefaults();
    const now = Date.now();

    const note = {
        id: generateUniqueItemId('note'),
        title: (typeof title === 'string' ? title.trim() : '') || scratchpadFallbackTitle(text),
        content: text,
        folder: defaults.folder,
        tags: defaults.tags,
        isPinned: false,
        isTrashed: false,
        // 秘密本：小本本建出来的笔记既不隐藏也不加密
        isHidden: false,
        locked: false,
        createdAt: now,
        updatedAt: now
    };

    saveNote(note);
    markItemKind(note, 'note');
    State.notes.unshift(note);
    renderCounts();
    renderListPanel();
    showToast(`小本本已新建笔记：${note.title || '未命名笔记'}`);
    return note.id;
}

// 小本本写回它关联的笔记
function updateNoteFromScratchpad(noteId, title, content) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note) return { ok: false, reason: 'missing' };
    // 加密未解锁的笔记：小本本拿不到也写不了明文
    if (isSecretLocked(note)) return { ok: false, reason: 'locked' };
    if (isReadOnlyItem(note)) return { ok: false, reason: 'readonly' };

    const isActive = State.activeNoteId === noteId;
    // 主窗口可能也开着这篇笔记：先把它自己的改动落盘，避免稍后的自动保存用旧内容覆盖
    if (isActive) flushPendingSave();

    note.title = typeof title === 'string' ? title : note.title;
    note.content = typeof content === 'string' ? content : '';
    note.updatedAt = Date.now();
    saveNote(note);

    // 正在看这篇笔记时连编辑区一起刷新；否则只更新列表与标签页标题，尽量不打扰主窗口
    if (isActive) renderApp();
    else {
        renderListPanel();
        renderTabs();
    }
    return { ok: true };
}

ipcRenderer.on('scratchpad:list-notes', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    replyToHost({ id: data.id, ok: true, notes: scratchpadNoteList() });
});

ipcRenderer.on('scratchpad:get-note', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const note = State.notes.find(n => n.id === data.noteId);
    if (!note) {
        replyToHost({ id: data.id, ok: false, reason: 'missing' });
        return;
    }
    // 加密未解锁的笔记不给正文：取出来的是密文，写回界面没有意义
    if (isSecretLocked(note)) {
        replyToHost({ id: data.id, ok: false, reason: 'locked' });
        return;
    }
    replyToHost({
        id: data.id,
        ok: true,
        note: { id: note.id, title: note.title || '', content: note.content || '' }
    });
});

ipcRenderer.on('scratchpad:create-note', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const noteId = createNoteFromScratchpad(data.title, data.content);
    replyToHost({ id: data.id, ok: true, noteId });
});

ipcRenderer.on('scratchpad:save-note', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const result = updateNoteFromScratchpad(data.noteId, data.title, data.content);
    replyToHost({ id: data.id, ...result });
});
