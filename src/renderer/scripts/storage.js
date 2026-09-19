/* 数据持久化：数据目录，以及 config.json / index.json / notes/{id}.md / ai_chats.json 的读写 */

// 数据目录可在设置页中更改，因此路径均为可变变量（切换位置后就地生效，无需重启）
let DATA_DIR = resolveDataDir();
let NOTES_DIR = path.join(DATA_DIR, 'notes');
let CONFIG_FILE = path.join(DATA_DIR, 'config.json');
let INDEX_FILE = path.join(DATA_DIR, 'index.json');
let AI_CHATS_FILE = path.join(DATA_DIR, 'ai_chats.json');

// 写入缓存：待写入内容与上次落盘完全一致时直接跳过，避免自动保存产生重复 I/O
const savedNoteContent = new Map(); // noteId -> 已写入磁盘的正文
let savedConfigJSON = null;
let savedIndexJSON = null;
let savedAiChatsJSON = null;

function resetWriteCache() {
    savedNoteContent.clear();
    savedConfigJSON = null;
    savedIndexJSON = null;
    savedAiChatsJSON = null;
}

// 应用新的数据目录（主进程已完成校验/迁移/记录，这里只负责切换本进程使用的路径）
function setDataPaths(dir) {
    DATA_DIR = dir;
    NOTES_DIR = path.join(dir, 'notes');
    CONFIG_FILE = path.join(dir, 'config.json');
    INDEX_FILE = path.join(dir, 'index.json');
    AI_CHATS_FILE = path.join(dir, 'ai_chats.json');
    // 换目录后旧缓存全部失效，否则会把新位置的首次写入误判为“无需写入”
    resetWriteCache();
    storageDirsReady = false;
}

// 生成10位的大小写英语+数字的随机ID
function generateNoteId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 10; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 目录只需确保一次：自动保存频繁调用，避免每次写入都做一轮同步 stat
let storageDirsReady = false;

function ensureStorageDirs() {
    if (storageDirsReady) return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.mkdirSync(NOTES_DIR, { recursive: true });
        storageDirsReady = true;
    } catch (err) {
        console.error('创建数据目录失败:', err);
    }
}

// AI 对话记录：单条对话保留的消息数上限，超出后丢弃最早的（避免文件无限膨胀）
const AI_CHAT_MESSAGE_LIMIT = 120;
// 最多保留的对话数，超出后清理最久未使用的
const AI_CHAT_LIMIT = 50;

// 单条消息规范化：既没有正文也没有错误提示的空消息没有保存价值
function normalizeAiToolCall(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return null;
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : `call_${name}`,
        name,
        arguments: typeof raw.arguments === 'string' ? raw.arguments : ''
    };
}

// 消息附件的规范化：文本附件带内联内容，图片附件只带 ai_files/ 下的文件名
function normalizeAiAttachments(raw) {
    if (!Array.isArray(raw)) return [];
    const attachments = [];
    raw.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const kind = item.kind === 'image' ? 'image' : (item.kind === 'text' ? 'text' : '');
        if (!kind) return;

        const file = typeof item.file === 'string' ? item.file.trim() : '';
        const content = typeof item.content === 'string' ? item.content : '';
        // 图片必须有文件名、文本必须有内容，否则这条附件已经不可用
        if (kind === 'image' && !/^[A-Za-z0-9_.-]{1,80}$/.test(file)) return;
        if (kind === 'text' && !content) return;

        const attachment = {
            id: typeof item.id === 'string' && item.id ? item.id : `att${attachments.length}`,
            kind,
            name: typeof item.name === 'string' ? item.name : '',
            size: Number.isFinite(item.size) ? item.size : 0
        };
        if (kind === 'image') {
            attachment.file = file;
            attachment.mime = typeof item.mime === 'string' ? item.mime : '';
        } else {
            attachment.content = content;
        }
        attachments.push(attachment);
    });
    return attachments;
}

function normalizeAiChatMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();

    // 工具执行结果：与 assistant 的 toolCalls 成对出现，必须保住 toolCallId
    if (raw.role === 'tool') {
        const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId.trim() : '';
        if (!toolCallId) return null;
        const message = {
            role: 'tool',
            toolCallId,
            name: typeof raw.name === 'string' ? raw.name : '',
            content: typeof raw.content === 'string' ? raw.content : '',
            ok: raw.ok !== false,
            createdAt
        };
        if (typeof raw.summary === 'string' && raw.summary) message.summary = raw.summary;
        if (typeof raw.detail === 'string' && raw.detail) message.detail = raw.detail;
        // stepId 仅用于在本次运行内找到撤销快照
        if (typeof raw.stepId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.stepId)) message.stepId = raw.stepId;
        return message;
    }

    const role = raw.role === 'assistant' ? 'assistant' : (raw.role === 'user' ? 'user' : '');
    if (!role) return null;

    const content = typeof raw.content === 'string' ? raw.content : '';
    const error = typeof raw.error === 'string' ? raw.error.trim() : '';
    const toolCalls = Array.isArray(raw.toolCalls)
        ? raw.toolCalls.map(normalizeAiToolCall).filter(Boolean)
        : [];
    const attachments = normalizeAiAttachments(raw.attachments);
    // 只带附件不带文字的消息也算有效内容
    if (!content && !error && !toolCalls.length && !attachments.length) return null;

    const message = { role, content, createdAt };
    if (toolCalls.length) message.toolCalls = toolCalls;
    if (error) {
        message.content = '';
        message.error = error;
        if (raw.canceled) message.canceled = true;
    }
    if (typeof raw.contextLabel === 'string' && raw.contextLabel) message.contextLabel = raw.contextLabel;
    if (attachments.length) message.attachments = attachments;
    return message;
}

// 单个对话规范化：ID 非法或重复的直接丢弃，消息超限时只保留最近的一批
function normalizeAiConversation(raw, seenIds) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seenIds.has(id)) return null;
    seenIds.add(id);

    const messages = (Array.isArray(raw.messages) ? raw.messages : [])
        .map(normalizeAiChatMessage)
        .filter(Boolean)
        .slice(-AI_CHAT_MESSAGE_LIMIT);

    return {
        id,
        title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 60) : '',
        messages,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()
    };
}

function normalizeAiChats(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    const seenIds = new Set();
    const conversations = (Array.isArray(source.conversations) ? source.conversations : [])
        .map(item => normalizeAiConversation(item, seenIds))
        .filter(Boolean)
        // 最近使用的排在前面，新建对话时 unshift 即可保持同一顺序
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, AI_CHAT_LIMIT);

    const activeId = conversations.some(item => item.id === source.activeId)
        ? source.activeId
        : (conversations[0] ? conversations[0].id : '');
    return { conversations, activeId };
}

function loadAiChats() {
    try {
        if (!fs.existsSync(AI_CHATS_FILE)) return normalizeAiChats(null);
        const raw = fs.readFileSync(AI_CHATS_FILE, 'utf8').trim();
        if (!raw) return normalizeAiChats(null);
        return normalizeAiChats(JSON.parse(raw));
    } catch (err) {
        console.error('读取 ai_chats.json 失败:', err);
        return normalizeAiChats(null);
    }
}

// 保存对话记录到 data/ai_chats.json（内容未变时直接跳过写入）
function saveAiChats() {
    ensureStorageDirs();
    try {
        const chats = Array.isArray(State.aiConversations) ? State.aiConversations : [];
        const payload = {
            activeId: State.aiActiveConversationId || '',
            conversations: chats.map(chat => ({
                id: chat.id,
                title: chat.title || '',
                createdAt: chat.createdAt || Date.now(),
                updatedAt: chat.updatedAt || Date.now(),
                messages: Array.isArray(chat.messages) ? chat.messages.slice(-AI_CHAT_MESSAGE_LIMIT) : []
            }))
        };
        const json = JSON.stringify(payload, null, 2);
        if (json === savedAiChatsJSON) return;
        fs.writeFileSync(AI_CHATS_FILE, json, 'utf8');
        savedAiChatsJSON = json;
    } catch (err) {
        console.error('保存 ai_chats.json 失败:', err);
    }
}

// 字体配置规范化：容忍缺失/脏数据，统一为四个字符串字段
function normalizeFonts(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    const pick = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
    return {
        uiLatin: pick('uiLatin'),
        uiCjk: pick('uiCjk'),
        docLatin: pick('docLatin'),
        docCjk: pick('docCjk')
    };
}

// AI 配置规范化：容忍缺失/脏数据，范围与数量都夹在合理区间内
function normalizeAiConfig(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    const pick = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
    const maxNotes = Number(source.maxNotes);
    return {
        // 总开关：旧配置里还没有该字段时视为开启，保证升级前后的行为一致
        enabled: source.enabled === undefined ? true : !!source.enabled,
        // Agent 模式：允许模型调用工具改写笔记，默认关闭
        agentMode: !!source.agentMode,
        baseUrl: pick('baseUrl'),
        // 密钥不 trim 之外的任何改写：原样保存，避免用户粘贴的内容被破坏
        apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
        model: pick('model'),
        scope: normalizeAiScope(source.scope),
        maxNotes: Number.isFinite(maxNotes) ? Math.min(Math.max(Math.round(maxNotes), 1), 100) : 10,
        systemPrompt: typeof source.systemPrompt === 'string' ? source.systemPrompt : ''
    };
}

function loadData() {
    ensureStorageDirs();
    let config = { theme: 'system', accentColor: '', spellcheck: false, sidebarCollapsed: false, trashRetentionDays: 0, fonts: {}, ai: {} };
    let indexData = { folders: [], notes: [] };
    let indexCorrupted = false; // index.json 解析失败时标记，启动后会用清理后的索引覆盖

    // 1. 读取应用配置 config.json
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawConfig = fs.readFileSync(CONFIG_FILE, 'utf8');
            if (rawConfig) config = { ...config, ...JSON.parse(rawConfig) };
        } else {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        }
    } catch (err) {
        console.error('读取 config.json 失败:', err);
    }

    // 2. 读取文档信息索引 index.json
    try {
        if (fs.existsSync(INDEX_FILE)) {
            const rawIndex = fs.readFileSync(INDEX_FILE, 'utf8').trim();
            const parsedIndex = rawIndex ? JSON.parse(rawIndex) : null;
            if (parsedIndex && typeof parsedIndex === 'object' && !Array.isArray(parsedIndex)) {
                indexData = { ...indexData, ...parsedIndex };
            } else {
                // 空文件或结构异常（非对象），视为无效索引，启动后按清理结果重建
                indexCorrupted = true;
            }
        } else {
            fs.writeFileSync(INDEX_FILE, JSON.stringify(indexData, null, 2), 'utf8');
        }
    } catch (err) {
        console.error('读取 index.json 失败:', err);
        indexCorrupted = true;
    }

    // 3. 规范化自定义文件夹列表（去空白、去重、剔除空名与"默认"），运行时保证包含"默认"
    const rawFolders = Array.isArray(indexData.folders) ? indexData.folders : [];
    const customFolders = [];
    rawFolders.forEach(folder => {
        if (typeof folder !== 'string') return;
        const name = folder.trim();
        if (!name || name === '默认' || customFolders.includes(name)) return;
        customFolders.push(name);
    });
    const foldersChanged = JSON.stringify(rawFolders) !== JSON.stringify(customFolders);
    const folders = ['默认', ...customFolders];

    // 4. 载入正文并校验索引项：剔除 ID 非法、ID 重复、缺少 data/notes/{id}.md 正文文件的无效条目
    const rawNotes = Array.isArray(indexData.notes) ? indexData.notes : [];
    const notes = [];
    const seenIds = new Set();
    let removedNotes = 0;
    let repairedNotes = 0;

    rawNotes.forEach(entry => {
        // ID 必须是安全的文件名字符串（现有生成规则为 10 位大小写字母+数字）
        const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seenIds.has(id)) {
            removedNotes++;
            return;
        }

        const notePath = path.join(NOTES_DIR, `${id}.md`);
        if (!fs.existsSync(notePath)) {
            // 正文文件缺失，索引项无效，直接清理
            removedNotes++;
            return;
        }

        let content = '';
        try {
            content = fs.readFileSync(notePath, 'utf8');
        } catch (err) {
            console.error(`读取笔记内容失败 ${id}:`, err);
            removedNotes++;
            return;
        }

        seenIds.add(id);

        const rawFolder = typeof entry.folder === 'string' ? entry.folder.trim() : '';
        const note = {
            id,
            title: typeof entry.title === 'string' ? entry.title : '',
            folder: (rawFolder && rawFolder !== '默认' && folders.includes(rawFolder)) ? rawFolder : '默认',
            tags: Array.isArray(entry.tags)
                ? [...new Set(entry.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()))]
                : [],
            isPinned: !!entry.isPinned,
            isTrashed: !!entry.isTrashed,
            createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
            updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
            content
        };

        // 与 index.json 的存储形式逐字段比对（"默认"文件夹存储为空字符串），判断是否发生了修正
        const before = [entry.title, rawFolder, entry.tags, !!entry.isPinned, !!entry.isTrashed, entry.createdAt, entry.updatedAt];
        const after = [note.title, note.folder === '默认' ? '' : note.folder, note.tags, note.isPinned, note.isTrashed, note.createdAt, note.updatedAt];
        if (JSON.stringify(before) !== JSON.stringify(after)) repairedNotes++;

        notes.push(note);
    });

    // 磁盘内容已全部读入内存，让写入缓存与之一致，避免紧接着的保存重复写盘
    resetWriteCache();
    notes.forEach(note => savedNoteContent.set(note.id, note.content));

    return {
        theme: config.theme || 'system',
        accentColor: normalizeAccentColor(config.accentColor),
        spellcheck: !!config.spellcheck,
        sidebarCollapsed: !!config.sidebarCollapsed,
        trashRetentionDays: normalizeTrashRetentionDays(config.trashRetentionDays),
        fonts: normalizeFonts(config.fonts),
        ai: normalizeAiConfig(config.ai),
        aiChats: loadAiChats(),
        folders,
        notes,
        indexCleanup: {
            removedNotes,
            repairedNotes,
            foldersChanged,
            indexCorrupted
        }
    };
}

// 保存配置到 config.json
function saveConfig() {
    ensureStorageDirs();
    try {
        const config = {
            theme: State.theme,
            accentColor: normalizeAccentColor(State.accentColor),
            spellcheck: State.spellcheck,
            sidebarCollapsed: !!State.sidebarCollapsed,
            trashRetentionDays: normalizeTrashRetentionDays(State.trashRetentionDays),
            fonts: normalizeFonts(State.fonts),
            ai: normalizeAiConfig(State.ai)
        };
        const json = JSON.stringify(config, null, 2);
        if (json === savedConfigJSON) return;
        fs.writeFileSync(CONFIG_FILE, json, 'utf8');
        savedConfigJSON = json;
    } catch (err) {
        console.error('保存 config.json 失败:', err);
    }
}

// 保存单个笔记的正文到 data/notes/{id}.md
function saveNoteContent(note) {
    if (!note || !note.id) return;
    const content = note.content || '';
    if (savedNoteContent.get(note.id) === content) return;
    ensureStorageDirs();
    try {
        const notePath = path.join(NOTES_DIR, `${note.id}.md`);
        fs.writeFileSync(notePath, content, 'utf8');
        savedNoteContent.set(note.id, content);
    } catch (err) {
        console.error(`保存笔记 ${note.id} 内容失败:`, err);
    }
}

// 删除笔记正文文件，并同步丢弃对应的写入缓存
function deleteNoteFile(noteId) {
    savedNoteContent.delete(noteId);
    try {
        const notePath = path.join(NOTES_DIR, `${noteId}.md`);
        if (fs.existsSync(notePath)) fs.unlinkSync(notePath);
    } catch (err) {
        console.error(`删除笔记文件 ${noteId}.md 失败:`, err);
    }
}

// 保存索引元数据到 index.json（文档信息不包含正文大文本，保证轻量快速；folders只记录自定义文件夹）
function saveIndex() {
    ensureStorageDirs();
    try {
        const notesMetadata = State.notes.map(n => ({
            id: n.id,
            title: n.title || '',
            folder: (n.folder === '默认' || !n.folder) ? '' : n.folder,
            tags: Array.isArray(n.tags) ? n.tags : [],
            isPinned: !!n.isPinned,
            isTrashed: !!n.isTrashed,
            createdAt: n.createdAt || Date.now(),
            updatedAt: n.updatedAt || Date.now()
        }));

        const customFolders = State.folders.filter(f => f && f !== '默认');

        const indexData = {
            folders: customFolders,
            notes: notesMetadata
        };
        const json = JSON.stringify(indexData, null, 2);
        if (json === savedIndexJSON) return;
        fs.writeFileSync(INDEX_FILE, json, 'utf8');
        savedIndexJSON = json;
    } catch (err) {
        console.error('保存 index.json 失败:', err);
    }
}

function saveData() {
    saveIndex();
    saveConfig();
}
