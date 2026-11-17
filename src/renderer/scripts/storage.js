let DATA_DIR = resolveDataDir();
let ITEMS_DIR = path.join(DATA_DIR, 'items');
let NOTES_DIR = path.join(DATA_DIR, 'notes');
let TODOS_DIR = path.join(DATA_DIR, 'todos');

let AI_CHATS_DIR = path.join(DATA_DIR, 'ai_chats');
let SHARED_DIR = path.join(DATA_DIR, 'shared');
let CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let LEGACY_INDEX_FILE = path.join(DATA_DIR, 'index.json');
let LEGACY_AI_CHATS_FILE = path.join(DATA_DIR, 'ai_chats.json');

const savedItemFiles = new Map();
const savedNoteFiles = savedItemFiles;
const savedTodoFiles = savedItemFiles;
const savedAiChatFiles = new Map();
let savedConfigJSON = null;

function resetWriteCache() {
    savedItemFiles.clear();
    savedAiChatFiles.clear();
    savedConfigJSON = null;
}

function setDataPaths(dir) {
    DATA_DIR = dir;
    ITEMS_DIR = path.join(dir, 'items');
    NOTES_DIR = path.join(dir, 'notes');
    TODOS_DIR = path.join(dir, 'todos');

    AI_CHATS_DIR = path.join(dir, 'ai_chats');
    SHARED_DIR = path.join(dir, 'shared');
    CONFIG_FILE = path.join(dir, 'config.json');
    LEGACY_INDEX_FILE = path.join(dir, 'index.json');
    LEGACY_AI_CHATS_FILE = path.join(dir, 'ai_chats.json');

    resetWriteCache();
    storageDirsReady = false;
}

function generateNoteId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 10; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function itemIdTaken(id) {
    if (!id) return true;
    if (State.notes.some(n => n.id === id) || State.todos.some(t => t.id === id)) return true;
    return fs.existsSync(path.join(ITEMS_DIR, `${id}.md`))
        || fs.existsSync(path.join(NOTES_DIR, `${id}.md`))
        || fs.existsSync(path.join(TODOS_DIR, `${id}.md`));
}

function generateUniqueItemId(kind) {
    const recycled = typeof takeRecycledItemId === 'function' ? takeRecycledItemId(kind) : '';
    if (recycled && !itemIdTaken(recycled)) return recycled;

    let id = generateNoteId();
    while (itemIdTaken(id)) id = generateNoteId();
    return id;
}

let storageDirsReady = false;

function itemAssetsDir(itemId) {
    const safeName = String(itemId || '').replace(/[\\/:*?"<>|]/g, '_');
    return path.join(ITEMS_DIR, safeName);
}

function ensureItemAssetsDir(itemId) {
    const dir = itemAssetsDir(itemId);
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
        console.error('创建条目附件目录失败:', err);
    }
    return dir;
}

function listItemAssetFiles(itemId) {
    const dir = itemAssetsDir(itemId);
    const result = [];
    try {
        if (!fs.existsSync(dir)) return result;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.forEach((entry) => {
            if (!entry.isFile() || isStaleTempFile(entry.name)) return;
            try {
                const filePath = path.join(dir, entry.name);
                const stat = fs.statSync(filePath);
                result.push({
                    name: entry.name,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs
                });
            } catch (err) {

            }
        });
    } catch (err) {
        console.error('列出条目附件失败:', err);
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
}

function resolveItemAssetPath(itemId, filename) {
    return path.join(itemAssetsDir(itemId), String(filename || ''));
}

function itemAssetRelativePath(itemId, filename) {
    return String(filename || '');
}

function ensureStorageDirs() {
    if (storageDirsReady) return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.mkdirSync(ITEMS_DIR, { recursive: true });

        fs.mkdirSync(AI_CHATS_DIR, { recursive: true });
        storageDirsReady = true;
    } catch (err) {
        console.error('创建数据目录失败:', err);
    }
}

const TEMP_FILE_SUFFIX = '.tmp';

const RENAME_RETRY_DELAYS = [15, 40];

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (err) {

    }
}

function renameWithRetry(from, to) {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (err) {
            const retryable = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
            if (!retryable || attempt >= RENAME_RETRY_DELAYS.length) throw err;
            sleepSync(RENAME_RETRY_DELAYS[attempt]);
        }
    }
}

function writeFileAtomic(filePath, text) {
    const tempPath = `${filePath}${TEMP_FILE_SUFFIX}`;
    try {
        fs.writeFileSync(tempPath, text, 'utf8');
        renameWithRetry(tempPath, filePath);

        notifyRemoteWrite(filePath);
    } catch (err) {

        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (cleanupError) {

        }
        throw err;
    }
}

function isStaleTempFile(fileName) {
    return typeof fileName === 'string' && fileName.endsWith(TEMP_FILE_SUFFIX);
}

function dataRelativePath(filePath) {
    try {
        const relative = path.relative(DATA_DIR, filePath).replace(/\\/g, '/');
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
        return relative;
    } catch (err) {
        return '';
    }
}

function notifyRemoteWrite(filePath) {
    try {
        const relative = dataRelativePath(filePath);

        if (!relative || isStaleTempFile(relative)) return;
        ipcRenderer.send('sync:push', { path: relative });
    } catch (err) {

    }
}

function notifyRemoteDelete(filePath) {
    try {
        const relative = dataRelativePath(filePath);
        if (!relative || isStaleTempFile(relative) || relative.endsWith('.bak')) return;

        ipcRenderer.send('sync:remove', { path: relative });

        if (typeof releaseRecycledItemId === 'function') releaseRecycledItemId(relative);
    } catch (err) {

    }
}

const NOTE_META_HEADER = 'EsprinData';

const NOTE_META_BLOCK_PATTERN = /^<!--[ \t]*EsprinData[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*-->[ \t]*(?=\r?\n|$)/;

const NOTE_FILE_PATTERN = /^([A-Za-z0-9_-]{1,64})\.md$/i;

const NOTE_TITLE_MAX_LENGTH = 60;

function parseNoteFile(raw) {
    const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
    const matched = text.match(NOTE_META_BLOCK_PATTERN);
    if (!matched) return { meta: null, content: text };

    const meta = {};
    matched[1].split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        const separator = trimmed.indexOf(':');
        if (separator <= 0) return;
        meta[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    });

let content = text.slice(matched[0].length);
    const gap = content.match(/^(?:\r?\n){1,2}/);
    if (gap) content = content.slice(gap[0].length);

    if (!content.trim()) content = '';
    return { meta, content };
}

function formatNoteMetaValue(value) {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    const text = typeof value === 'string' ? value : '';
    return text ? JSON.stringify(text) : '';
}

function formatNoteMetaLine(key, value) {
    const text = formatNoteMetaValue(value);
    return text ? `    ${key}: ${text}` : `    ${key}:`;
}

function serializeItemFile(item, kind = 'note', extraLines = []) {
    const folder = item.folder && item.folder !== '默认' ? item.folder : '';
    const itemType = kind || (item && item.isDone !== undefined ? 'todo' : 'note');
    const header = [
        `<!--${NOTE_META_HEADER}`,
        formatNoteMetaLine('type', itemType),
        formatNoteMetaLine('title', item.title || ''),
        formatNoteMetaLine('folder', folder),
        formatNoteMetaLine('tags', Array.isArray(item.tags) ? item.tags : []),
        formatNoteMetaLine('isPinned', !!item.isPinned),
        formatNoteMetaLine('isTrashed', !!item.isTrashed),

        ...(item.isHidden === true ? [formatNoteMetaLine('isHidden', true)] : []),
        ...(item.locked === true ? [formatNoteMetaLine('isLocked', true)] : []),
        ...extraLines,
        formatNoteMetaLine('createdAt', Number(item.createdAt) || Date.now()),
        formatNoteMetaLine('updatedAt', Number(item.updatedAt) || Date.now()),
        '-->'
    ].join('\n');

const content = typeof serializeSecretBody === 'function'
        ? serializeSecretBody(item)
        : String(item.content || '');
    return content ? `${header}\n\n${content}` : `${header}\n`;
}

function serializeNoteFile(note) {
    return serializeItemFile(note, 'note');
}

function serializeTodoFile(todo) {
    return serializeItemFile(todo, 'todo', [formatNoteMetaLine('isDone', !!todo.isDone)]);
}

function readNoteMetaString(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return '';
    if (value.startsWith('"')) {
        try {
            const parsed = JSON.parse(value);
            return typeof parsed === 'string' ? parsed : '';
        } catch (err) {

            return value.replace(/^"+|"+$/g, '');
        }
    }
    return value;
}

function readNoteMetaNumber(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(typeof raw === 'string' ? raw.trim() : raw);
    return Number.isFinite(value) ? Math.round(value) : fallback;
}

function readNoteMetaBoolean(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return !!fallback;
    const value = String(raw).trim().toLowerCase();
    if (value === 'true' || value === '1' || value === 'yes') return true;
    if (value === 'false' || value === '0' || value === 'no') return false;
    return !!fallback;
}

function normalizeNoteTags(raw) {
    const tags = [];
    (Array.isArray(raw) ? raw : []).forEach((item) => {
        const tag = typeof item === 'string' ? item.trim().replace(/^#+/, '').trim() : '';
        if (tag && !tags.includes(tag)) tags.push(tag);
    });
    return tags;
}

function readNoteMetaTags(raw) {
    if (Array.isArray(raw)) return normalizeNoteTags(raw);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return [];
    if (value.startsWith('[')) {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return normalizeNoteTags(parsed);
        } catch (err) {

        }
    }
    return normalizeNoteTags(value.split(/[,，\s]+/));
}

function deriveNoteTitle(content) {
    const line = String(content || '').split('\n').map(item => item.trim()).find(item => item.length) || '';
    const cleaned = line.replace(/^#{1,6}\s*/, '').replace(/^[-*+>]\s+/, '').trim();
    return cleaned.length > NOTE_TITLE_MAX_LENGTH ? cleaned.slice(0, NOTE_TITLE_MAX_LENGTH) : cleaned;
}

function normalizeCustomFolders(raw) {
    const folders = [];
    (Array.isArray(raw) ? raw : []).forEach((item) => {
        const name = typeof item === 'string' ? item.trim() : '';
        if (!name || name === '默认' || folders.includes(name)) return;
        folders.push(name);
    });
    return folders;
}

function readItemFiles(dir, label) {
    const files = [];
    let skipped = 0;
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {

        if (!err || err.code !== 'ENOENT') console.error(`读取${label}目录失败:`, err);
        return { files, skipped };
    }

    entries.forEach((entry) => {
        if (!entry.isFile()) return;

        if (isStaleTempFile(entry.name)) return;
        const matched = entry.name.match(NOTE_FILE_PATTERN);
        if (!matched) {
            console.warn(`${label}目录中已忽略非${label}文件：${entry.name}`);
            skipped++;
            return;
        }
        try {
            const filePath = path.join(dir, entry.name);
            const stat = fs.statSync(filePath);
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = parseNoteFile(raw);
            files.push({
                id: matched[1],
                raw,
                stat,
                hasMeta: !!parsed.meta,
                meta: parsed.meta || {},
                content: parsed.content
            });
        } catch (err) {
            console.error(`读取${label}文件 ${entry.name} 失败:`, err);
            skipped++;
        }
    });

    return { files, skipped };
}

function readNoteFiles() {
    return readItemFiles(NOTES_DIR, '笔记');
}

function readTodoFiles() {
    return readItemFiles(TODOS_DIR, '待办');
}

function readAllItemFiles() {
    return readItemFiles(ITEMS_DIR, '条目');
}

function itemFilePath(item) {
    if (item && item.shared) return sharedItemPath(item.shared.owner, item.shared.noteId);
    const id = typeof item === 'string' ? item : (item && item.id);
    return path.join(ITEMS_DIR, `${id}.md`);
}

function noteFilePath(note) {
    return itemFilePath(note);
}
function buildNoteFromFile(file, legacy) {
    const meta = file.meta || {};
    const fallback = legacy || {};
    const statTime = file.stat && Number.isFinite(file.stat.mtimeMs) ? Math.round(file.stat.mtimeMs) : Date.now();

    const pick = (key) => (meta[key] !== undefined ? meta[key] : fallback[key]);

    const createdAt = readNoteMetaNumber(meta.createdAt, readNoteMetaNumber(fallback.createdAt, statTime));

    return {
        id: file.id,

        title: readNoteMetaString(pick('title')) || (file.hasMeta ? '' : deriveNoteTitle(file.content)),
        folder: readNoteMetaString(pick('folder')),
        tags: readNoteMetaTags(pick('tags')),
        isPinned: readNoteMetaBoolean(pick('isPinned'), false),
        isTrashed: readNoteMetaBoolean(pick('isTrashed'), false),

isHidden: readNoteMetaBoolean(pick('isHidden'), false),
        locked: readNoteMetaBoolean(meta.isLocked, false) && isSecretEnvelope(file.content),

        unlocked: false,
        createdAt,
        updatedAt: readNoteMetaNumber(meta.updatedAt, readNoteMetaNumber(fallback.updatedAt, Math.max(createdAt, statTime))),
        content: file.content
    };
}

function sharedItemId(owner, noteId) {
    return `shared:${owner}:${noteId}`;
}

function parseSharedItemId(itemId) {
    const matched = /^shared:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,64})$/.exec(String(itemId || ''));
    return matched ? { owner: matched[1], noteId: matched[2] } : null;
}

function sharedItemPath(owner, noteId) {
    return path.join(SHARED_DIR, owner, `${noteId}.md`);
}

const SHARED_OWNER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function readSharedNoteFiles() {
    const files = [];
    let skipped = 0;

    let owners = [];
    try {
        owners = fs.readdirSync(SHARED_DIR, { withFileTypes: true });
    } catch (err) {

        return { files, skipped };
    }

    owners.forEach((ownerEntry) => {
        if (!ownerEntry.isDirectory() || !SHARED_OWNER_PATTERN.test(ownerEntry.name)) return;
        const ownerDir = path.join(SHARED_DIR, ownerEntry.name);

        let entries = [];
        try {
            entries = fs.readdirSync(ownerDir, { withFileTypes: true });
        } catch (err) {
            return;
        }

        entries.forEach((entry) => {
            if (!entry.isFile() || isStaleTempFile(entry.name)) return;
            const matched = entry.name.match(NOTE_FILE_PATTERN);
            if (!matched) {
                skipped++;
                return;
            }
            try {
                const filePath = path.join(ownerDir, entry.name);
                const stat = fs.statSync(filePath);
                const raw = fs.readFileSync(filePath, 'utf8');
                const parsed = parseNoteFile(raw);
                files.push({
                    id: matched[1],
                    owner: ownerEntry.name,
                    raw,
                    stat,
                    hasMeta: !!parsed.meta,
                    meta: parsed.meta || {},
                    content: parsed.content
                });
            } catch (err) {
                console.error(`读取共享笔记 ${entry.name} 失败:`, err);
                skipped++;
            }
        });
    });

    return { files, skipped };
}

function buildSharedNoteFromFile(file) {
    const note = buildNoteFromFile(file, null);
    note.id = sharedItemId(file.owner, file.id);
    note.shared = { owner: file.owner, noteId: file.id };
    return note;
}

function noteFilePath(note) {
    return itemFilePath(note);
}

function buildTodoFromFile(file) {
    const meta = file.meta || {};
    const statTime = file.stat && Number.isFinite(file.stat.mtimeMs) ? Math.round(file.stat.mtimeMs) : Date.now();
    const createdAt = readNoteMetaNumber(meta.createdAt, statTime);

    return {
        id: file.id,

        title: readNoteMetaString(meta.title) || (file.hasMeta ? '' : deriveNoteTitle(file.content)),
        folder: readNoteMetaString(meta.folder),
        tags: readNoteMetaTags(meta.tags),
        isPinned: readNoteMetaBoolean(meta.isPinned, false),
        isTrashed: readNoteMetaBoolean(meta.isTrashed, false),
        isDone: readNoteMetaBoolean(meta.isDone, false),

        isHidden: readNoteMetaBoolean(meta.isHidden, false),
        locked: readNoteMetaBoolean(meta.isLocked, false) && isSecretEnvelope(file.content),
        unlocked: false,
        createdAt,
        updatedAt: readNoteMetaNumber(meta.updatedAt, Math.max(createdAt, statTime)),
        content: file.content
    };
}

function readLegacyIndex() {
    const result = { found: false, folders: [], notes: [] };
    try {
        if (!fs.existsSync(LEGACY_INDEX_FILE)) return result;
        result.found = true;
        const raw = fs.readFileSync(LEGACY_INDEX_FILE, 'utf8').trim();
        if (!raw) return result;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
        result.folders = Array.isArray(parsed.folders) ? parsed.folders : [];

        const seenIds = new Set();
        (Array.isArray(parsed.notes) ? parsed.notes : []).forEach((entry) => {
            if (!entry || typeof entry !== 'object') return;
            const id = typeof entry.id === 'string' ? entry.id.trim() : '';
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seenIds.has(id)) return;
            seenIds.add(id);
            result.notes.push(entry);
        });
    } catch (err) {
        console.error('读取旧索引 index.json 失败:', err);
    }
    return result;
}

function archiveLegacyFile(file, note) {
    try {
        const backup = `${file}.bak`;
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        fs.renameSync(file, backup);
        console.warn(`${note}，原文件保留为 ${path.basename(backup)}`);
        return true;
    } catch (err) {
        console.error(`归档 ${path.basename(file)} 失败:`, err);
        return false;
    }
}

const AI_CHAT_MESSAGE_LIMIT = 120;

const AI_CHAT_LIMIT = 50;

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

function normalizeAiAttachments(raw) {
    if (!Array.isArray(raw)) return [];
    const attachments = [];
    raw.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const kind = item.kind === 'image' ? 'image' : (item.kind === 'text' ? 'text' : '');
        if (!kind) return;

        const file = typeof item.file === 'string' ? item.file.trim() : '';
        const content = typeof item.content === 'string' ? item.content : '';

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

        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, AI_CHAT_LIMIT);

    const activeId = conversations.some(item => item.id === source.activeId)
        ? source.activeId
        : (conversations[0] ? conversations[0].id : '');
    return { conversations, activeId };
}

const AI_CHAT_FILE_PATTERN = /^([A-Za-z0-9_-]{1,64})\.json$/;

function readAiChatFiles() {
    const conversations = [];
    const raws = new Map();
    const seenIds = new Set();
    let entries = [];
    try {
        if (fs.existsSync(AI_CHATS_DIR)) entries = fs.readdirSync(AI_CHATS_DIR, { withFileTypes: true });
    } catch (err) {
        console.error('读取 ai_chats 目录失败:', err);
        return { conversations, raws };
    }

    entries.forEach((entry) => {
        if (!entry.isFile()) return;

        if (isStaleTempFile(entry.name)) return;
        const matched = entry.name.match(AI_CHAT_FILE_PATTERN);
        if (!matched) {
            console.warn(`ai_chats 目录中已忽略非对话文件：${entry.name}`);
            return;
        }
        const filePath = path.join(AI_CHATS_DIR, entry.name);
        try {
            const raw = fs.readFileSync(filePath, 'utf8');

            const chat = normalizeAiConversation({ ...JSON.parse(raw.trim() || '{}'), id: matched[1] }, seenIds);
            if (!chat) return;
            conversations.push(chat);
            raws.set(chat.id, raw);
        } catch (err) {
            console.error(`读取对话文件 ${entry.name} 失败:`, err);
        }
    });

    return { conversations, raws };
}

function serializeAiChat(chat) {
    return `${JSON.stringify({
        id: chat.id,
        title: chat.title || '',
        createdAt: chat.createdAt || Date.now(),
        updatedAt: chat.updatedAt || Date.now(),
        messages: Array.isArray(chat.messages) ? chat.messages.slice(-AI_CHAT_MESSAGE_LIMIT) : []
    }, null, 2)}\n`;
}

function saveAiChat(chat) {
    if (!chat || !chat.id) return;

    if (Array.isArray(State.aiConversations) && !State.aiConversations.includes(chat)) return;
    ensureStorageDirs();
    try {
        const json = serializeAiChat(chat);
        if (savedAiChatFiles.get(chat.id) === json) return;
        writeFileAtomic(path.join(AI_CHATS_DIR, `${chat.id}.json`), json);
        savedAiChatFiles.set(chat.id, json);
    } catch (err) {
        console.error(`保存对话 ${chat.id} 失败:`, err);
    }
}

function deleteAiChatFile(chatId) {
    savedAiChatFiles.delete(chatId);
    try {
        const filePath = path.join(AI_CHATS_DIR, `${chatId}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);

            notifyRemoteDelete(filePath);
        }
    } catch (err) {
        console.error(`删除对话文件 ${chatId}.json 失败:`, err);
    }
}

function readLegacyAiChats() {
    const result = { found: false, conversations: [], activeId: '' };
    try {
        if (!fs.existsSync(LEGACY_AI_CHATS_FILE)) return result;
        result.found = true;
        const raw = fs.readFileSync(LEGACY_AI_CHATS_FILE, 'utf8').trim();
        if (!raw) return result;
        const parsed = normalizeAiChats(JSON.parse(raw));
        result.conversations = parsed.conversations;
        result.activeId = parsed.activeId;
    } catch (err) {
        console.error('读取旧版 ai_chats.json 失败:', err);
    }
    return result;
}

function loadAiChats(activeIdFromConfig) {
    const legacy = readLegacyAiChats();
    const scanned = readAiChatFiles();
    const conversations = scanned.conversations;
    const raws = scanned.raws;

const existingIds = new Set(conversations.map(chat => chat.id));
    let merged = 0;
    legacy.conversations.forEach((chat) => {
        if (existingIds.has(chat.id)) return;
        existingIds.add(chat.id);
        conversations.push(chat);
        merged++;
    });
    conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

const dropped = conversations.splice(AI_CHAT_LIMIT);
    dropped.forEach((chat) => {
        console.warn(`对话记录超出 ${AI_CHAT_LIMIT} 份上限，已清理《${chat.title || '未命名对话'}》`);
        deleteAiChatFile(chat.id);
    });

let rewriteFailed = 0;
    conversations.forEach((chat) => {
        const json = serializeAiChat(chat);
        savedAiChatFiles.set(chat.id, json);
        if (raws.get(chat.id) === json) return;
        try {
            writeFileAtomic(path.join(AI_CHATS_DIR, `${chat.id}.json`), json);
        } catch (err) {
            console.error(`写入对话 ${chat.id} 失败:`, err);
            rewriteFailed++;
        }
    });

const legacyArchived = (legacy.found && !rewriteFailed) ? archiveLegacyFile(LEGACY_AI_CHATS_FILE, '对话迁移：已把 ai_chats.json 中的对话拆分为 ai_chats/ 下的一份份文件') : false;

    const candidates = [activeIdFromConfig, legacy.activeId];
    const activeId = candidates.find(id => conversations.some(chat => chat.id === id))
        || (conversations[0] ? conversations[0].id : '');

    return {
        conversations,
        activeId,
        cleanup: {
            found: legacy.found,
            archived: legacyArchived,
            merged,
            dropped: dropped.length
        }
    };
}

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

function normalizeAiConfig(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    const pick = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
    const maxNotes = Number(source.maxNotes);
    return {

        enabled: source.enabled === undefined ? true : !!source.enabled,

        agentMode: !!source.agentMode,
        baseUrl: pick('baseUrl'),
        model: pick('model'),
        scope: normalizeAiScope(source.scope),
        maxNotes: Number.isFinite(maxNotes) ? Math.min(Math.max(Math.round(maxNotes), 1), 100) : 10,
        systemPrompt: typeof source.systemPrompt === 'string' ? source.systemPrompt : ''
    };
}

function normalizeVoiceConfig(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    return {
        enabled: source.enabled === undefined ? true : !!source.enabled,
        lang: normalizeVoiceLanguage(source.lang)
    };
}

const SYNC_AUTO_SYNC_PRESETS = { off: 0, '5s': 5, '1m': 60, '5m': 300 };
const SYNC_AUTO_SYNC_VALUES = Object.keys(SYNC_AUTO_SYNC_PRESETS).concat('custom');
const SYNC_AUTO_SYNC_MIN_SECONDS = 5;
const SYNC_AUTO_SYNC_MAX_SECONDS = 24 * 60 * 60;
const SYNC_AUTO_SYNC_DEFAULT_SECONDS = 60;

function normalizeAutoSyncSeconds(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return SYNC_AUTO_SYNC_DEFAULT_SECONDS;
    return Math.min(Math.max(Math.round(num), SYNC_AUTO_SYNC_MIN_SECONDS), SYNC_AUTO_SYNC_MAX_SECONDS);
}

function normalizeSyncServerConfig(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    const pick = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
    const lastSyncAt = Number(source.lastSyncAt);
    return {

        enabled: source.enabled === true,
        url: pick('url').replace(/\/+$/, ''),

        account: pick('account'),

        device: pick('device'),

        autoSync: SYNC_AUTO_SYNC_VALUES.includes(source.autoSync) ? source.autoSync : 'off',
        autoSyncSeconds: normalizeAutoSyncSeconds(source.autoSyncSeconds),
        lastSyncAt: Number.isFinite(lastSyncAt) && lastSyncAt > 0 ? lastSyncAt : 0,
        lastSyncSummary: typeof source.lastSyncSummary === 'string' ? source.lastSyncSummary : ''
    };
}

function adoptLegacyApiKey(config) {
    const ai = config && typeof config === 'object' && config.ai && typeof config.ai === 'object' ? config.ai : null;
    const legacyKey = ai && typeof ai.apiKey === 'string' ? ai.apiKey.trim() : '';
    if (ai) delete ai.apiKey;
    if (!legacyKey) return;
    try {
        const result = ipcRenderer.sendSync('ai:set-key-sync', { apiKey: legacyKey });
        if (result && result.ok) {
            console.warn('API Key 迁移：config.json 中的明文密钥已收进本机安全存储');
        } else {
            console.warn('API Key 迁移失败：', (result && result.error) || '未知原因');
        }
    } catch (err) {
        console.error('API Key 迁移失败:', err);
    }
}

function readAiKeyStatus() {
    const empty = { hasKey: false, encrypted: false, strong: false, migrated: false, path: '' };
    try {
        return ipcRenderer.sendSync('ai:key-status-sync') || empty;
    } catch (err) {
        console.error('读取 API Key 状态失败:', err);
        return empty;
    }
}

function loadData() {
    ensureStorageDirs();
    let config = { theme: 'system', themeStyle: 'default', accentColor: 'system', cornerRadius: 'default', uiScale: 1, spellcheck: false, sidebarBlur: true, glassTransparent: false, sidebarCollapsed: false, trashRetentionDays: 0, autoUpdate: true, ghProxyEnabled: false, folders: [], aiActiveChat: '', fonts: {}, ai: {}, voice: {}, syncServer: {} };

try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawConfig = fs.readFileSync(CONFIG_FILE, 'utf8');
            if (rawConfig) {
                const parsed = JSON.parse(rawConfig);

                config = { ...config, ...parsed };
            }
        } else {
            writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
        }
    } catch (err) {
        console.error('读取 config.json 失败:', err);
    }

adoptLegacyApiKey(config);
    const aiKeyStatus = readAiKeyStatus();

const legacyIndex = readLegacyIndex();
    const legacyEntries = new Map(legacyIndex.notes.map(entry => [entry.id, entry]));

const scannedItems = readAllItemFiles();
    const scannedLegacyNotes = readNoteFiles();
    const scannedLegacyTodos = readTodoFiles();

const allScannedFiles = new Map();
    scannedItems.files.forEach(f => allScannedFiles.set(f.id, { ...f, legacySource: null }));
    scannedLegacyNotes.files.forEach(f => {
        if (!allScannedFiles.has(f.id)) {
            allScannedFiles.set(f.id, { ...f, legacySource: 'notes' });
        }
    });
    scannedLegacyTodos.files.forEach(f => {
        if (!allScannedFiles.has(f.id)) {
            allScannedFiles.set(f.id, { ...f, legacySource: 'todos' });
        }
    });

    const notes = [];
    const todos = [];

    allScannedFiles.forEach((file) => {
        const legacy = legacyEntries.get(file.id) || null;
        if (legacy) legacyEntries.delete(file.id);

const metaType = file.meta && typeof file.meta.type === 'string' ? file.meta.type.trim().toLowerCase() : '';
        const isTodo = metaType === 'todo' || file.legacySource === 'todos' || (file.meta && file.meta.isDone !== undefined);

        if (isTodo) {
            todos.push(buildTodoFromFile(file));
        } else {
            notes.push(buildNoteFromFile(file, legacy));
        }
    });

const vanishedLegacyNotes = legacyEntries.size;

const scannedShared = readSharedNoteFiles();
    const sharedNotes = scannedShared.files.map(file => buildSharedNoteFromFile(file));
    const allNotes = notes.concat(sharedNotes);

const customFolders = [];
    const addFolder = (name) => {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed || trimmed === '默认' || customFolders.includes(trimmed)) return;
        customFolders.push(trimmed);
    };
    normalizeCustomFolders(config.folders).forEach(addFolder);
    normalizeCustomFolders(legacyIndex.folders).forEach(addFolder);
    notes.forEach(note => addFolder(note.folder));
    todos.forEach(todo => addFolder(todo.folder));

    sharedNotes.forEach(note => addFolder(note.folder));

notes.forEach((note) => {
        if (!note.folder || !customFolders.includes(note.folder)) note.folder = '默认';
    });
    todos.forEach((todo) => {
        if (!todo.folder || !customFolders.includes(todo.folder)) todo.folder = '默认';
    });

const serialized = new Map();
    let repairedNotes = 0;
    let rewriteFailed = 0;
    notes.forEach((note) => {

        if (note.shared) return;
        const text = serializeNoteFile(note);
        serialized.set(note.id, text);
        const targetPath = itemFilePath(note);
        let currentRaw = null;
        try {
            if (fs.existsSync(targetPath)) currentRaw = fs.readFileSync(targetPath, 'utf8');
        } catch (e) {}

        if (currentRaw !== text) {
            try {
                writeFileAtomic(targetPath, text);
                repairedNotes++;
            } catch (err) {
                console.error(`写入笔记 ${note.id} 失败:`, err);
                rewriteFailed++;
            }
        }

const legacyPath = path.join(NOTES_DIR, `${note.id}.md`);
        if (fs.existsSync(legacyPath) && fs.existsSync(targetPath)) {
            try {
                fs.unlinkSync(legacyPath);
            } catch (e) {}
        }
    });

const legacyArchived = (legacyIndex.found && !rewriteFailed)
        ? archiveLegacyFile(LEGACY_INDEX_FILE, '索引迁移：元数据已写入各笔记文件')
        : false;

const serializedTodos = new Map();
    let repairedTodos = 0;
    todos.forEach((todo) => {
        const text = serializeTodoFile(todo);
        serializedTodos.set(todo.id, text);
        const targetPath = itemFilePath(todo);
        let currentRaw = null;
        try {
            if (fs.existsSync(targetPath)) currentRaw = fs.readFileSync(targetPath, 'utf8');
        } catch (e) {}

        if (currentRaw !== text) {
            try {
                writeFileAtomic(targetPath, text);
                repairedTodos++;
            } catch (err) {
                console.error(`写入待办 ${todo.id} 失败:`, err);
            }
        }

const legacyPath = path.join(TODOS_DIR, `${todo.id}.md`);
        if (fs.existsSync(legacyPath) && fs.existsSync(targetPath)) {
            try {
                fs.unlinkSync(legacyPath);
            } catch (e) {}
        }
    });

resetWriteCache();
    notes.forEach(note => savedItemFiles.set(note.id, serialized.get(note.id)));
    todos.forEach(todo => savedItemFiles.set(todo.id, serializedTodos.get(todo.id)));

    sharedNotes.forEach(note => savedItemFiles.set(note.id, serializeNoteFile(note)));

allNotes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    todos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

const aiChats = loadAiChats(config.aiActiveChat);

    return {
        theme: config.theme || 'system',
        themeStyle: normalizeThemeStyle(config.themeStyle),
        accentColor: normalizeAccentColor(config.accentColor),
        cornerRadius: normalizeCornerRadius(config.cornerRadius),

        uiScale: normalizeUiScale(config.uiScale),
        spellcheck: !!config.spellcheck,

        sidebarBlur: config.sidebarBlur !== false,
    glassTransparent: config.glassTransparent === true,
        sidebarCollapsed: !!config.sidebarCollapsed,
        trashRetentionDays: normalizeTrashRetentionDays(config.trashRetentionDays),

        autoUpdate: config.autoUpdate !== false,

        ghProxyEnabled: config.ghProxyEnabled === true,

        autoLaunch: config.autoLaunch === true,

        trayEnabled: config.trayEnabled !== false,

        stickyNotes: normalizeStickyConfig(config.stickyNotes),
        fonts: normalizeFonts(config.fonts),
        ai: normalizeAiConfig(config.ai),

        voice: normalizeVoiceConfig(config.voice),

        syncServer: normalizeSyncServerConfig(config.syncServer),
        aiKeyStatus,
        aiChats: { conversations: aiChats.conversations, activeId: aiChats.activeId },
        folders: ['默认', ...customFolders],
        notes: allNotes,
        todos,
        dataCleanup: {
            repairedNotes,
            repairedTodos,

            skippedFiles: scannedItems.skipped + scannedLegacyNotes.skipped,

            skippedTodoFiles: scannedLegacyTodos.skipped,

            skippedSharedFiles: scannedShared.skipped,

            foldersChanged: JSON.stringify(normalizeCustomFolders(config.folders)) !== JSON.stringify(customFolders),
            legacyIndex: {
                found: legacyIndex.found,
                archived: legacyArchived,
                merged: legacyIndex.notes.length - vanishedLegacyNotes,
                vanished: vanishedLegacyNotes
            },
            legacyAiChats: aiChats.cleanup
        }
    };
}

function saveConfig() {
    ensureStorageDirs();
    try {
        const config = {
            theme: State.theme,
            themeStyle: normalizeThemeStyle(State.themeStyle),
            accentColor: normalizeAccentColor(State.accentColor),
            cornerRadius: normalizeCornerRadius(State.cornerRadius),

            uiScale: normalizeUiScale(State.uiScale),
            spellcheck: State.spellcheck,

            sidebarBlur: State.sidebarBlur !== false,
            glassTransparent: State.glassTransparent === true,
            sidebarCollapsed: !!State.sidebarCollapsed,
            trashRetentionDays: normalizeTrashRetentionDays(State.trashRetentionDays),

            autoUpdate: State.autoUpdate !== false,

            ghProxyEnabled: State.ghProxyEnabled === true,

            autoLaunch: State.autoLaunch === true,

            trayEnabled: State.trayEnabled !== false,

            stickyNotes: normalizeStickyConfig(State.stickyNotes),

            aiActiveChat: typeof State.aiActiveConversationId === 'string' ? State.aiActiveConversationId : '',
            folders: normalizeCustomFolders(State.folders),
            fonts: normalizeFonts(State.fonts),
            ai: normalizeAiConfig(State.ai),

            voice: normalizeVoiceConfig(State.voice)
        };

if (State.syncServerLoaded) config.syncServer = normalizeSyncServerConfig(State.syncServer);

        const json = JSON.stringify(config, null, 2);
        if (json === savedConfigJSON) return;
        writeFileAtomic(CONFIG_FILE, json);
        savedConfigJSON = json;
    } catch (err) {
        console.error('保存 config.json 失败:', err);
    }
}

function saveNote(note) {
    if (!note || !note.id) return;
    ensureStorageDirs();
    try {
        const text = serializeNoteFile(note);
        if (savedItemFiles.get(note.id) === text) return;
        const file = noteFilePath(note);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomic(file, text);
        savedItemFiles.set(note.id, text);
    } catch (err) {
        console.error(`保存笔记 ${note.id} 失败:`, err);
    }
}

function deleteNoteFile(noteId) {
    savedItemFiles.delete(noteId);

    if (typeof forgetSecretKey === 'function') forgetSecretKey(noteId);
    const shared = parseSharedItemId(noteId);
    try {
        const notePath = shared ? sharedItemPath(shared.owner, shared.noteId) : path.join(ITEMS_DIR, `${noteId}.md`);
        if (fs.existsSync(notePath)) {
            fs.unlinkSync(notePath);
            if (!shared) notifyRemoteDelete(notePath);
        }

        const legacyNotePath = path.join(NOTES_DIR, `${noteId}.md`);
        if (fs.existsSync(legacyNotePath)) {
            fs.unlinkSync(legacyNotePath);
            if (!shared) notifyRemoteDelete(legacyNotePath);
        }
    } catch (err) {
        console.error(`删除笔记文件 ${noteId}.md 失败:`, err);
    }

    if (typeof notifyStickyItemRemoved === 'function') notifyStickyItemRemoved(noteId);
}

function saveTodo(todo) {
    if (!todo || !todo.id) return;
    ensureStorageDirs();
    try {
        const text = serializeTodoFile(todo);
        if (savedItemFiles.get(todo.id) === text) return;
        const file = itemFilePath(todo);
        writeFileAtomic(file, text);
        savedItemFiles.set(todo.id, text);
    } catch (err) {
        console.error(`保存待办 ${todo.id} 失败:`, err);
    }
}

function deleteTodoFile(todoId) {
    savedItemFiles.delete(todoId);

    if (typeof forgetSecretKey === 'function') forgetSecretKey(todoId);
    try {
        const todoPath = path.join(ITEMS_DIR, `${todoId}.md`);
        if (fs.existsSync(todoPath)) {
            fs.unlinkSync(todoPath);
            notifyRemoteDelete(todoPath);
        }
        const legacyTodoPath = path.join(TODOS_DIR, `${todoId}.md`);
        if (fs.existsSync(legacyTodoPath)) {
            fs.unlinkSync(legacyTodoPath);
            notifyRemoteDelete(legacyTodoPath);
        }
    } catch (err) {
        console.error(`删除待办文件 ${todoId}.md 失败:`, err);
    }

    if (typeof notifyStickyItemRemoved === 'function') notifyStickyItemRemoved(todoId);
}

function saveItem(item) {
    if (isTodoItem(item)) saveTodo(item);
    else saveNote(item);

    if (typeof notifyStickyItemSaved === 'function') notifyStickyItemSaved(item);
}

function deleteItemFile(itemId) {

    if (typeof forgetSecretKey === 'function') forgetSecretKey(itemId);
    if (State.todos.some(todo => todo.id === itemId)) deleteTodoFile(itemId);
    else deleteNoteFile(itemId);
}
