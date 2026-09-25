/* AI Agent 模式：让模型调用工具直接读写笔记（正文、标题、文件夹、标签、置顶、废纸篓）。
   所有写操作都在渲染进程内完成，与手动操作走同一套 State + 落盘逻辑，
   因此列表、标签栏、编辑器与磁盘上的笔记文件都能即时保持一致；每次写操作都登记一份撤销快照。 */

// 一次提问内最多允许执行的工具步数，避免模型陷入循环
const AI_AGENT_MAX_STEPS = 6;
// 工具结果的字符上限（read_note 摘要、list_notes 条数）
const AI_AGENT_READ_CHAR_LIMIT = 20000;
const AI_AGENT_LIST_LIMIT = 100;

// 会话内的撤销快照：stepId -> { label, apply() }
const aiAgentUndoEntries = new Map();

// ---------- 工具定义 ----------

const AI_AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'list_notes',
            description: '列出笔记（可按文件夹、标签或关键词过滤），返回每篇笔记的 id、标题、文件夹、标签与修改时间。修改笔记前先用它找到目标笔记。',
            parameters: {
                type: 'object',
                properties: {
                    folder: { type: 'string', description: '只看该文件夹下的笔记，留空表示不限' },
                    tag: { type: 'string', description: '只看带该标签的笔记，不要带 # 前缀' },
                    keyword: { type: 'string', description: '标题或正文中包含该关键词' },
                    limit: { type: 'integer', description: '最多返回多少篇，默认 20，最大 100' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_note',
            description: '读取指定笔记的完整正文（正文过长时会被截断）。',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '笔记 id，也可用笔记标题代替' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_note',
            description: '新建一篇笔记，返回新笔记的 id。',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: '笔记标题' },
                    content: { type: 'string', description: '笔记正文（Markdown）' },
                    folder: { type: 'string', description: '所属文件夹，必须是已存在的文件夹，默认“默认”' },
                    tags: { type: 'array', items: { type: 'string' }, description: '标签列表，不要带 # 前缀' },
                    pinned: { type: 'boolean', description: '是否置顶' }
                },
                required: ['content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_note_content',
            description: '修改笔记正文：mode 为 replace 时整体替换，为 append 时追加到正文末尾。',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '笔记 id，也可用笔记标题代替' },
                    content: { type: 'string', description: '新的正文内容（Markdown）' },
                    mode: { type: 'string', enum: ['replace', 'append'], description: '默认为 replace' }
                },
                required: ['id', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_note_meta',
            description: '修改笔记的标题、文件夹、标签或置顶状态，只传需要改动的字段。标签可用 tags 整体替换，或用 add_tags / remove_tags 增删。',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '笔记 id，也可用笔记标题代替' },
                    title: { type: 'string', description: '新的标题' },
                    folder: { type: 'string', description: '新的文件夹，必须是已存在的文件夹' },
                    tags: { type: 'array', items: { type: 'string' }, description: '整体替换标签列表，不要带 # 前缀' },
                    add_tags: { type: 'array', items: { type: 'string' }, description: '要添加的标签' },
                    remove_tags: { type: 'array', items: { type: 'string' }, description: '要移除的标签' },
                    pinned: { type: 'boolean', description: '是否置顶' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_folder',
            description: '新建一个文件夹，已存在同名文件夹时不会重复创建。',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: '文件夹名称' }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'trash_note',
            description: '把笔记移入废纸篓（用户可在废纸篓中恢复）。仅在用户明确要求删除笔记时使用，执行前会向用户确认。',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '笔记 id，也可用笔记标题代替' }
                },
                required: ['id']
            }
        }
    }
];

// ---------- 开关 ----------

function isAiAgentMode() {
    return !!State.ai && !!State.ai.agentMode;
}

// Agent 模式下才把工具定义下发给模型
function buildAiAgentToolPayload() {
    return isAiAgentMode() ? AI_AGENT_TOOLS : [];
}

function syncAiAgentToggle() {
    const toggle = document.getElementById('ai-agent-toggle');
    if (!toggle) return;
    // 外观沿用标题栏 AI 助手按钮那一套：开启时挂 .active，颜色与底色由 .btn-action-icon.active 给
    const on = isAiAgentMode();
    toggle.classList.toggle('active', on);
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// 直接切换开关，不再弹确认框；开启后的风险提示由输入区上方的说明与每次操作的「撤销」按钮承担
function toggleAiAgentMode(enabled) {
    State.ai = normalizeAiConfig({ ...State.ai, agentMode: !!enabled });
    flushAiConfigSave();
    syncAiAgentToggle();
    showToast(enabled ? 'Agent 模式已开启：AI 可以修改笔记' : 'Agent 模式已关闭');
}

// ---------- 撤销 ----------

function registerAiAgentUndo(stepId, entry) {
    if (!stepId || !entry) return;
    aiAgentUndoEntries.set(stepId, entry);
}

function canUndoAiAgentStep(stepId) {
    return !!stepId && aiAgentUndoEntries.has(stepId);
}

function undoAiAgentStep(stepId) {
    const entry = aiAgentUndoEntries.get(stepId);
    if (!entry) {
        showToast('这一步已无法撤销（可能已重启应用）');
        return;
    }
    try {
        entry.apply();
        aiAgentUndoEntries.delete(stepId);
        showToast(`已撤销：${entry.label}`);
    } catch (err) {
        console.error('撤销 Agent 操作失败:', err);
        showToast('撤销失败');
    }
}

// ---------- 查笔记的小工具 ----------

function findNoteById(id) {
    const value = typeof id === 'string' ? id.trim() : '';
    if (!value) return null;
    return State.notes.find(note => note.id === value) || null;
}

// 模型经常直接给标题，这里按 id 找不到时再按标题唯一匹配一次。
// 隐藏与加了密码的条目不进这个兜底匹配（它们同样不在列表工具的结果里）
function resolveAiAgentNote(rawId) {
    const direct = findNoteById(rawId);
    if (direct) return direct;

    const keyword = String(rawId || '').trim();
    if (!keyword) return null;
    const matches = State.notes.filter(note => !note.isTrashed
        && !isSecretHidden(note)
        && note.locked !== true
        && (note.title || '').trim() === keyword);
    return matches.length === 1 ? matches[0] : null;
}

function normalizeTagList(raw) {
    if (!Array.isArray(raw)) return [];
    const tags = [];
    raw.forEach((item) => {
        const tag = typeof item === 'string' ? item.trim().replace(/^#+/, '').trim() : '';
        if (tag && !tags.includes(tag)) tags.push(tag);
    });
    return tags;
}

function folderExists(name) {
    return State.folders.includes(name);
}

// 写操作前的统一准备：先落盘编辑器里未提交的改动，保证读到的是最新正文
function prepareNoteWrite() {
    flushPendingSave();
}

// 写操作完成后把该笔记写回文件（无笔记改动时传空）并刷新界面
function commitNoteWrite(note) {
    if (note) saveNote(note);
    renderApp();
}

function noteSummary(note) {
    return {
        id: note.id,
        title: note.title || '',
        folder: note.folder || '默认',
        tags: Array.isArray(note.tags) ? note.tags : [],
        pinned: !!note.isPinned,
        trashed: !!note.isTrashed,
        updatedAt: new Date(note.updatedAt || Date.now()).toISOString()
    };
}

// ---------- 工具执行 ----------

function toolOk(summary, detail, payload) {
    return { ok: true, summary, detail: detail || '', content: JSON.stringify(payload == null ? { ok: true } : payload) };
}

function toolFail(message) {
    return { ok: false, summary: message, detail: '', content: JSON.stringify({ error: message }) };
}

function runListNotes(args) {
    const folder = typeof args.folder === 'string' ? args.folder.trim() : '';
    const tag = typeof args.tag === 'string' ? args.tag.trim().replace(/^#+/, '') : '';
    const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), AI_AGENT_LIST_LIMIT);

    // 秘密本：隐藏的条目不对模型可见，设了密码的条目同样不进列表工具的结果
    let notes = State.notes.filter(note => !note.isTrashed && !isSecretHidden(note) && note.locked !== true);
    if (folder) notes = notes.filter(note => (note.folder || '默认') === folder);
    if (tag) notes = notes.filter(note => Array.isArray(note.tags) && note.tags.includes(tag));
    if (keyword) {
        notes = notes.filter(note => `${note.title || ''}\n${note.content || ''}`.toLowerCase().includes(keyword));
    }

    const total = notes.length;
    const picked = notes
        .slice()
        .sort((a, b) => (b.isPinned - a.isPinned) || ((b.updatedAt || 0) - (a.updatedAt || 0)))
        .slice(0, limit);

    const detail = [
        folder ? `文件夹：${folder}` : '',
        tag ? `标签：#${tag}` : '',
        keyword ? `关键词：${args.keyword}` : ''
    ].filter(Boolean).join(' · ');

    return toolOk(`查看笔记列表（命中 ${total} 篇${total > picked.length ? `，返回前 ${picked.length} 篇` : ''}）`, detail, {
        total,
        folders: State.folders,
        notes: picked.map(noteSummary)
    });
}

function runReadNote(args) {
    const note = resolveAiAgentNote(args.id);
    if (!note) return toolFail(`没有找到笔记：${String(args.id || '').trim() || '（未提供 id）'}`);
    // 加密码的条目正文在解锁前是密文，读出来只会是一串 base64
    if (isSecretLocked(note)) return toolFail(`《${note.title || '未命名笔记'}》正文已加密，需要先在应用里解锁`);

    const content = String(note.content || '');
    const truncated = content.length > AI_AGENT_READ_CHAR_LIMIT;
    return toolOk(`阅读《${note.title || '未命名笔记'}》`, truncated ? '正文过长，已截断' : `共 ${content.length} 字`, {
        note: noteSummary(note),
        content: truncated ? `${content.slice(0, AI_AGENT_READ_CHAR_LIMIT)}\n…（已截断）` : content
    });
}

function runCreateNote(args) {
    prepareNoteWrite();

    const content = typeof args.content === 'string' ? args.content : '';
    if (!content.trim()) return toolFail('新建笔记需要提供正文内容');

    const folder = typeof args.folder === 'string' && args.folder.trim() ? args.folder.trim() : '默认';
    if (!folderExists(folder)) {
        return toolFail(`文件夹「${folder}」不存在，可用文件夹：${State.folders.join('、')}（可先用 create_folder 创建）`);
    }

    const now = Date.now();
    const note = {
        id: generateUniqueItemId('note'),
        title: typeof args.title === 'string' ? args.title.trim() : '',
        content,
        folder,
        tags: normalizeTagList(args.tags),
        isPinned: !!args.pinned,
        isTrashed: false,
        // 秘密本：AI 新建的笔记既不隐藏也不加密
        isHidden: false,
        locked: false,
        createdAt: now,
        updatedAt: now
    };

    State.notes.unshift(note);
    markItemKind(note, 'note');
    commitNoteWrite(note);

    return {
        ...toolOk(`新建笔记《${note.title || '未命名笔记'}》`, `文件夹：${folder}${note.tags.length ? ` · 标签：${note.tags.map(t => `#${t}`).join(' ')}` : ''}`, {
            ok: true,
            id: note.id,
            title: note.title,
            folder
        }),
        undo: {
            label: `新建笔记《${note.title || '未命名笔记'}》`,
            apply() {
                deleteNoteFile(note.id);
                State.notes = State.notes.filter(item => item.id !== note.id);
                closeTab(note.id);
                commitNoteWrite();
            }
        }
    };
}

function runUpdateNoteContent(args) {
    prepareNoteWrite();

    const note = resolveAiAgentNote(args.id);
    if (!note) return toolFail(`没有找到笔记：${String(args.id || '').trim() || '（未提供 id）'}`);
    if (note.isTrashed) return toolFail(`《${note.title || '未命名笔记'}》在废纸篓中，请先恢复后再修改`);
    if (isSecretLocked(note)) return toolFail(`《${note.title || '未命名笔记'}》正文已加密，需要先在应用里解锁`);

    const nextContent = typeof args.content === 'string' ? args.content : '';
    const mode = args.mode === 'append' ? 'append' : 'replace';
    const previousContent = String(note.content || '');
    const base = previousContent.replace(/\s+$/, '');
    note.content = mode === 'append' && base ? `${base}\n\n${nextContent}` : nextContent;
    note.updatedAt = Date.now();

    commitNoteWrite(note);

    const detail = mode === 'append'
        ? `追加 ${nextContent.length} 字（共 ${note.content.length} 字）`
        : `整体替换（${previousContent.length} → ${note.content.length} 字）`;

    return {
        ...toolOk(`${mode === 'append' ? '追加' : '重写'}《${note.title || '未命名笔记'}》正文`, detail, {
            ok: true,
            id: note.id,
            mode,
            length: note.content.length
        }),
        undo: {
            label: `修改《${note.title || '未命名笔记'}》正文`,
            apply() {
                const target = findNoteById(note.id);
                if (!target) return;
                target.content = previousContent;
                target.updatedAt = Date.now();
                commitNoteWrite(target);
            }
        }
    };
}

function runUpdateNoteMeta(args) {
    prepareNoteWrite();

    const note = resolveAiAgentNote(args.id);
    if (!note) return toolFail(`没有找到笔记：${String(args.id || '').trim() || '（未提供 id）'}`);
    if (note.isTrashed) return toolFail(`《${note.title || '未命名笔记'}》在废纸篓中，请先恢复后再修改`);
    if (isSecretLocked(note)) return toolFail(`《${note.title || '未命名笔记'}》正文已加密，需要先在应用里解锁`);

    const before = {
        title: note.title || '',
        folder: note.folder || '默认',
        tags: Array.isArray(note.tags) ? [...note.tags] : [],
        isPinned: !!note.isPinned
    };

    const changes = [];

    if (typeof args.title === 'string') {
        note.title = args.title.trim();
        changes.push(`标题改为「${note.title || '未命名笔记'}」`);
    }

    if (typeof args.folder === 'string' && args.folder.trim()) {
        const folder = args.folder.trim();
        if (!folderExists(folder)) {
            return toolFail(`文件夹「${folder}」不存在，可用文件夹：${State.folders.join('、')}（可先用 create_folder 创建）`);
        }
        note.folder = folder;
        changes.push(`文件夹改为「${folder}」`);
    }

    const hasTagChange = Array.isArray(args.tags) || Array.isArray(args.add_tags) || Array.isArray(args.remove_tags);
    if (hasTagChange) {
        let tags = Array.isArray(args.tags) ? normalizeTagList(args.tags) : [...before.tags];
        if (Array.isArray(args.add_tags)) {
            normalizeTagList(args.add_tags).forEach((tag) => {
                if (!tags.includes(tag)) tags.push(tag);
            });
        }
        if (Array.isArray(args.remove_tags)) {
            const removals = normalizeTagList(args.remove_tags);
            tags = tags.filter(tag => !removals.includes(tag));
        }
        note.tags = tags;
        changes.push(tags.length ? `标签改为 ${tags.map(t => `#${t}`).join(' ')}` : '已清空标签');
    }

    if (typeof args.pinned === 'boolean') {
        note.isPinned = args.pinned;
        changes.push(args.pinned ? '已置顶' : '已取消置顶');
    }

    if (!changes.length) return toolFail('没有指定要修改的字段');

    note.updatedAt = Date.now();
    commitNoteWrite(note);

    return {
        ...toolOk(`更新《${before.title || '未命名笔记'}》`, changes.join(' · '), {
            ok: true,
            note: noteSummary(note)
        }),
        undo: {
            label: `更新《${before.title || '未命名笔记'}》`,
            apply() {
                const target = findNoteById(note.id);
                if (!target) return;
                target.title = before.title;
                target.folder = before.folder;
                target.tags = [...before.tags];
                target.isPinned = before.isPinned;
                target.updatedAt = Date.now();
                commitNoteWrite(target);
            }
        }
    };
}

function runCreateFolder(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return toolFail('文件夹名称不能为空');
    if (name === '默认' || folderExists(name)) {
        return toolOk(`文件夹「${name}」已存在`, '', { ok: true, name, existed: true });
    }

    State.folders.push(name);
    // 文件夹列表属于偏好配置，随 config.json 保存
    saveConfig();
    renderApp();

    return {
        ...toolOk(`新建文件夹「${name}」`, `共 ${State.folders.length} 个文件夹`, { ok: true, name, existed: false }),
        undo: {
            label: `新建文件夹「${name}」`,
            apply() {
                State.folders = State.folders.filter(folder => folder !== name);
                saveConfig();
                renderApp();
            }
        }
    };
}

async function runTrashNote(args) {
    prepareNoteWrite();

    const note = resolveAiAgentNote(args.id);
    if (!note) return toolFail(`没有找到笔记：${String(args.id || '').trim() || '（未提供 id）'}`);
    if (note.isTrashed) return toolOk(`《${note.title || '未命名笔记'}》已在废纸篓中`, '', { ok: true, id: note.id, trashed: true });

    // 删除类操作即使由 AI 发起也必须经过用户确认
    const confirmed = await showConfirm(`将《${note.title || '未命名笔记'}》移入废纸篓？`, {
        title: 'AI 请求移入废纸篓',
        detail: '这是 AI 发起的操作。移入废纸篓后仍可在废纸篓中恢复。',
        type: 'question',
        icon: 'delete',
        confirmLabel: '移入废纸篓'
    });
    if (!confirmed) return toolFail('用户取消了移入废纸篓的操作');

    const noteId = note.id;
    const title = note.title || '未命名笔记';
    moveToTrash(noteId);

    return {
        ...toolOk(`将《${title}》移入废纸篓`, '可在废纸篓中恢复', { ok: true, id: noteId, trashed: true }),
        undo: {
            label: `将《${title}》移入废纸篓`,
            apply() {
                restoreFromTrash(noteId);
            }
        }
    };
}

// 执行一次工具调用：参数为模型给的 JSON 字符串，结果回传给模型
async function executeAiAgentTool(name, rawArguments) {
    let args = {};
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
        try {
            args = JSON.parse(rawArguments);
        } catch (err) {
            return toolFail('工具参数不是合法的 JSON，请重新调用并给出合法参数');
        }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return toolFail('工具参数必须是 JSON 对象');
    }

    try {
        switch (name) {
            case 'list_notes': return runListNotes(args);
            case 'read_note': return runReadNote(args);
            case 'create_note': return runCreateNote(args);
            case 'update_note_content': return runUpdateNoteContent(args);
            case 'update_note_meta': return runUpdateNoteMeta(args);
            case 'create_folder': return runCreateFolder(args);
            case 'trash_note': return await runTrashNote(args);
            default: return toolFail(`不支持的工具：${name}`);
        }
    } catch (err) {
        console.error(`执行工具 ${name} 失败:`, err);
        return toolFail(`执行失败：${err && err.message ? err.message : '未知错误'}`);
    }
}

// ---------- 初始化 ----------

function initAiAgent() {
    const toggle = document.getElementById('ai-agent-toggle');
    if (!toggle) return;

    toggle.onclick = () => toggleAiAgentMode(!isAiAgentMode());
    syncAiAgentToggle();
}
