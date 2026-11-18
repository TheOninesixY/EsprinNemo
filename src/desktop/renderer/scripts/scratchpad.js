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

function replyToHost(payload) {
    try {
        ipcRenderer.send('scratchpad:reply', payload);
    } catch (err) {
        console.error('回复小本本请求失败:', err);
    }
}

const SCRATCHPAD_TITLE_MAX_LENGTH = 30;

function scratchpadFallbackTitle(content) {
    const firstLine = String(content || '').split('\n').map(line => line.trim()).find(line => line.length) || '';
    const cleaned = firstLine.replace(/^#{1,6}\s*/, '').replace(/^[-*+>]\s+/, '').trim();
    return cleaned.length > SCRATCHPAD_TITLE_MAX_LENGTH ? cleaned.slice(0, SCRATCHPAD_TITLE_MAX_LENGTH) : cleaned;
}

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

function updateNoteFromScratchpad(noteId, title, content) {
    const note = State.notes.find(n => n.id === noteId);
    if (!note) return { ok: false, reason: 'missing' };

    if (isSecretLocked(note)) return { ok: false, reason: 'locked' };
    if (isReadOnlyItem(note)) return { ok: false, reason: 'readonly' };

    const isActive = State.activeNoteId === noteId;

    if (isActive) flushPendingSave();

    note.title = typeof title === 'string' ? title : note.title;
    note.content = typeof content === 'string' ? content : '';
    note.updatedAt = Date.now();
    saveNote(note);

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
