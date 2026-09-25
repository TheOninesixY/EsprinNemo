/* 数据持久化：数据目录，以及 config.json / notes/{id}.md / todos/{id}.md / ai_chats/{id}.json 的读写。
   笔记与待办的标题、文件夹、标签、置顶与废纸篓状态、创建/修改时间都以内嵌注释（EsprinData）写在
   各自 .md 文件开头（待办仅多一行 isDone 完成状态，文件格式与笔记完全一致）；
   AI 对话同样一份对话一个文件。三者都不再有独立的索引文件。 */

// 数据目录可在设置页中更改，因此路径均为可变变量（切换位置后就地生效，无需重启）
let DATA_DIR = resolveDataDir();
let NOTES_DIR = path.join(DATA_DIR, 'notes');
let TODOS_DIR = path.join(DATA_DIR, 'todos');
let AI_CHATS_DIR = path.join(DATA_DIR, 'ai_chats');
let CONFIG_FILE = path.join(DATA_DIR, 'config.json');
// 旧版单文件记录：仅在启动时读一次用于迁移，完成后归档为同名 .bak
let LEGACY_INDEX_FILE = path.join(DATA_DIR, 'index.json');
let LEGACY_AI_CHATS_FILE = path.join(DATA_DIR, 'ai_chats.json');

// 写入缓存：待写入内容与上次落盘完全一致时直接跳过，避免自动保存产生重复 I/O
const savedNoteFiles = new Map(); // noteId -> 已写入磁盘的完整文件内容（注释 + 正文）
const savedTodoFiles = new Map(); // todoId -> 已写入磁盘的完整文件内容（注释 + 正文）
const savedAiChatFiles = new Map(); // chatId -> 已写入磁盘的对话 JSON
let savedConfigJSON = null;

function resetWriteCache() {
    savedNoteFiles.clear();
    savedTodoFiles.clear();
    savedAiChatFiles.clear();
    savedConfigJSON = null;
}

// 应用新的数据目录（主进程已完成校验/迁移/记录，这里只负责切换本进程使用的路径）
function setDataPaths(dir) {
    DATA_DIR = dir;
    NOTES_DIR = path.join(dir, 'notes');
    TODOS_DIR = path.join(dir, 'todos');
    AI_CHATS_DIR = path.join(dir, 'ai_chats');
    CONFIG_FILE = path.join(dir, 'config.json');
    LEGACY_INDEX_FILE = path.join(dir, 'index.json');
    LEGACY_AI_CHATS_FILE = path.join(dir, 'ai_chats.json');
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

// 这个 id 是不是还有人在用：内存里的条目与磁盘上的 notes/、todos/ 文件都算
// （笔记与待办共用同一套 id 空间，两边的文件都要避开）
function itemIdTaken(id) {
    if (!id) return true;
    if (State.notes.some(n => n.id === id) || State.todos.some(t => t.id === id)) return true;
    return fs.existsSync(path.join(NOTES_DIR, `${id}.md`)) || fs.existsSync(path.join(TODOS_DIR, `${id}.md`));
}

// 生成唯一的条目 id：优先用服务端回收池里腾出来的 ID（被删掉的那一条腾出的 ID
// 会重新落到新建的条目上，池子在 scripts/sync_server.js 里维护），
// 池子空或者候选不巧本机还在用就退回随机 ID。
function generateUniqueItemId(kind) {
    const recycled = typeof takeRecycledItemId === 'function' ? takeRecycledItemId(kind) : '';
    if (recycled && !itemIdTaken(recycled)) return recycled;

    let id = generateNoteId();
    while (itemIdTaken(id)) id = generateNoteId();
    return id;
}

// 目录只需确保一次：自动保存频繁调用，避免每次写入都做一轮同步 stat
let storageDirsReady = false;

function ensureStorageDirs() {
    if (storageDirsReady) return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.mkdirSync(NOTES_DIR, { recursive: true });
        fs.mkdirSync(TODOS_DIR, { recursive: true });
        fs.mkdirSync(AI_CHATS_DIR, { recursive: true });
        storageDirsReady = true;
    } catch (err) {
        console.error('创建数据目录失败:', err);
    }
}

// 原子写入用的临时文件后缀：不会命中笔记 / 待办 / 对话的文件名规则
const TEMP_FILE_SUFFIX = '.tmp';
// rename 失败后的重试等待（毫秒）：仅用于极端情况，正常路径不会走到
const RENAME_RETRY_DELAYS = [15, 40];

// 同步等待：仅在 rename 重试时使用，且发生在保存失败这一罕见路径上
function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (err) {
        // 不支持共享内存时退化为不等待
    }
}

/* Windows 上杀软与索引器可能瞬时占用刚写出的文件，使 rename 短时间失败。
   这里对可重试的错误码等一小会儿再试，避免一次自动保存被误判为失败。 */
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

/* 原子写入：先写同目录下的临时文件，再改名替换目标文件。
   直接覆盖写时，若进程被强杀或断电，原文件会被截断成半截内容；
   而笔记的元数据与正文同处一份文件（待办、对话与配置同理），损坏即整条记录报废。
   同一分区内的 rename 是原子操作，因此目标文件要么是旧内容、要么是新内容。 */
function writeFileAtomic(filePath, text) {
    const tempPath = `${filePath}${TEMP_FILE_SUFFIX}`;
    try {
        fs.writeFileSync(tempPath, text, 'utf8');
        renameWithRetry(tempPath, filePath);
        // 告诉主进程「这份文件刚变了」：自建同步会把这次改动变成一条操作推给服务器
        notifyRemoteWrite(filePath);
    } catch (err) {
        // 失败时清掉临时文件，避免在数据目录里留下垃圾
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (cleanupError) {
            // 清理失败不影响错误上报
        }
        throw err;
    }
}

// 上一次原子写入中途被打断时可能留下临时文件：扫描时静默跳过。
// 这里只跳过、不删除——万一它比目标文件更新，内容不至于因为一次扫描就丢掉。
function isStaleTempFile(fileName) {
    return typeof fileName === 'string' && fileName.endsWith(TEMP_FILE_SUFFIX);
}

/* ---------------- 自建同步的写穿通知 ----------------
   同步采用操作日志模型（见 src/main/sync_server.js）：本地每一次写入与删除都要变成一条操作
   （put / del）记进待推送队列，其中「删除」本身就是一条操作——这样别的设备重放时
   只会把本地那份删掉，而不会把「文件不存在」当成「缺文件」又补回来。
   这里只负责发个通知（send，不等回复），要不要同步、什么时候推由主进程决定。 */

// 数据目录内的相对路径（正斜杠）：数据目录外的路径一律不参与同步
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
        // 临时文件不是数据的一部分，不推
        if (!relative || isStaleTempFile(relative)) return;
        ipcRenderer.send('sync:push', { path: relative });
    } catch (err) {
        // 通知失败不影响本地保存
    }
}

function notifyRemoteDelete(filePath) {
    try {
        const relative = dataRelativePath(filePath);
        if (!relative || isStaleTempFile(relative) || relative.endsWith('.bak')) return;
        // 删除同样是一条操作：它会被记进待推送队列，而不是让别的设备把文件补回来
        ipcRenderer.send('sync:remove', { path: relative });
        // 彻底删除之后，这个 ID 本地立刻就能再用：下一次新建的条目会直接用它
        if (typeof releaseRecycledItemId === 'function') releaseRecycledItemId(relative);
    } catch (err) {
        // 同上
    }
}

/* ---------------- 笔记文件：内嵌元数据注释 + Markdown 正文 ----------------
   文件形如：
   <!--EsprinData
       title: "课堂记录"
       folder:
       tags: []
       isPinned: false
       isTrashed: false
       createdAt: 1789837475335
       updatedAt: 1789840300633
   -->

   正文…（这里的空行分隔注释与正文） */

const NOTE_META_HEADER = 'EsprinData';
// 元数据注释必须位于文件开头；--> 需独占行尾，避免正文里出现的 --> 被误当成注释结束
const NOTE_META_BLOCK_PATTERN = /^<!--[ \t]*EsprinData[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*-->[ \t]*(?=\r?\n|$)/;
// 文件名即笔记 id（随机 10 位大小写字母+数字）
const NOTE_FILE_PATTERN = /^([A-Za-z0-9_-]{1,64})\.md$/i;
// 没有标题时用正文首个非空行兜底的长度上限
const NOTE_TITLE_MAX_LENGTH = 60;

// 解析 .md 文件：返回 { meta, content }；
// 没有注释（例如手工放进 notes/ 的 Markdown）时 meta 为 null，整份文件都算正文
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

    // 注释与正文之间空一行：最多吃掉两个换行，正文自身的首行空行仍然保留
    let content = text.slice(matched[0].length);
    const gap = content.match(/^(?:\r?\n){1,2}/);
    if (gap) content = content.slice(gap[0].length);
    // 正文全为空白时统一存为空字符串，避免来回写入时凭空多出空行
    if (!content.trim()) content = '';
    return { meta, content };
}

// 元数据写入规则：空字符串写成空值（如 folder:），其余字符串加双引号转义，数组按 JSON 写
function formatNoteMetaValue(value) {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    const text = typeof value === 'string' ? value : '';
    return text ? JSON.stringify(text) : '';
}

// 一行元数据：键后紧跟冒号，有值时以单个空格分隔（与空值形式 folder: 保持一致）
function formatNoteMetaLine(key, value) {
    const text = formatNoteMetaValue(value);
    return text ? `    ${key}: ${text}` : `    ${key}:`;
}

// 生成条目文件内容：元数据注释 + 空行 + 正文（正文为空时只留注释）。
// extraLines 用于笔记之外的附加字段（待办的 isDone），写法与其余元数据行保持一致。
function serializeItemFile(item, extraLines = []) {
    const folder = item.folder && item.folder !== '默认' ? item.folder : '';
    const header = [
        `<!--${NOTE_META_HEADER}`,
        formatNoteMetaLine('title', item.title || ''),
        formatNoteMetaLine('folder', folder),
        formatNoteMetaLine('tags', Array.isArray(item.tags) ? item.tags : []),
        formatNoteMetaLine('isPinned', !!item.isPinned),
        formatNoteMetaLine('isTrashed', !!item.isTrashed),
        // 秘密本：隐藏与加密状态。只在这两项确实成立时才写出对应行——
        // 没用过秘密本的条目因此保持原有文件内容（省掉一次全量重写与随之而来的同步推送）；
        // 解密用的盐与 IV 跟在密文里（见 scripts/secret.js 的信封），
        // 元数据里只记「有没有加密」，文件一开头就能判断要不要先问密码
        ...(item.isHidden === true ? [formatNoteMetaLine('isHidden', true)] : []),
        ...(item.locked === true ? [formatNoteMetaLine('isLocked', true)] : []),
        ...extraLines,
        formatNoteMetaLine('createdAt', Number(item.createdAt) || Date.now()),
        formatNoteMetaLine('updatedAt', Number(item.updatedAt) || Date.now()),
        '-->'
    ].join('\n');
    // 正文：带密码的条目在这里现做密文（见 scripts/secret.js 的 serializeSecretBody）。
    // 任何保存路径都经这里取正文，明文因此不会落到磁盘上
    const content = typeof serializeSecretBody === 'function'
        ? serializeSecretBody(item)
        : String(item.content || '');
    return content ? `${header}\n\n${content}` : `${header}\n`;
}

// 笔记文件：只有上面那几个通用字段
function serializeNoteFile(note) {
    return serializeItemFile(note);
}

// 待办文件：与笔记完全同一套格式，仅多一行完成状态
function serializeTodoFile(todo) {
    return serializeItemFile(todo, [formatNoteMetaLine('isDone', !!todo.isDone)]);
}

// 注释里的字符串：优先按 JSON 字符串解析（写入时即为该格式），其次按原文，空值返回空字符串
function readNoteMetaString(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return '';
    if (value.startsWith('"')) {
        try {
            const parsed = JSON.parse(value);
            return typeof parsed === 'string' ? parsed : '';
        } catch (err) {
            // 引号不成对时按去掉首尾引号的原文处理
            return value.replace(/^"+|"+$/g, '');
        }
    }
    return value;
}

// 注释里的数字：非法值一律回退到 fallback
function readNoteMetaNumber(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(typeof raw === 'string' ? raw.trim() : raw);
    return Number.isFinite(value) ? Math.round(value) : fallback;
}

// 注释里的布尔值：只有明确的真值才算真，其余回退到 fallback
function readNoteMetaBoolean(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return !!fallback;
    const value = String(raw).trim().toLowerCase();
    if (value === 'true' || value === '1' || value === 'yes') return true;
    if (value === 'false' || value === '0' || value === 'no') return false;
    return !!fallback;
}

// 标签去空白、去 # 前缀、去重
function normalizeNoteTags(raw) {
    const tags = [];
    (Array.isArray(raw) ? raw : []).forEach((item) => {
        const tag = typeof item === 'string' ? item.trim().replace(/^#+/, '').trim() : '';
        if (tag && !tags.includes(tag)) tags.push(tag);
    });
    return tags;
}

// 注释里的标签：写入时为 JSON 数组（旧索引里已是数组），同时兼容 "a, b"、"a b" 这类手写形式
function readNoteMetaTags(raw) {
    if (Array.isArray(raw)) return normalizeNoteTags(raw);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return [];
    if (value.startsWith('[')) {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return normalizeNoteTags(parsed);
        } catch (err) {
            // 落到下面的分隔符形式
        }
    }
    return normalizeNoteTags(value.split(/[,，\s]+/));
}

// 没有标题时用正文首个非空行兜底：去掉 Markdown 前缀，过长则截断
function deriveNoteTitle(content) {
    const line = String(content || '').split('\n').map(item => item.trim()).find(item => item.length) || '';
    const cleaned = line.replace(/^#{1,6}\s*/, '').replace(/^[-*+>]\s+/, '').trim();
    return cleaned.length > NOTE_TITLE_MAX_LENGTH ? cleaned.slice(0, NOTE_TITLE_MAX_LENGTH) : cleaned;
}

// 自定义文件夹列表规范化：去空白、去重、剔除空名与“默认”
function normalizeCustomFolders(raw) {
    const folders = [];
    (Array.isArray(raw) ? raw : []).forEach((item) => {
        const name = typeof item === 'string' ? item.trim() : '';
        if (!name || name === '默认' || folders.includes(name)) return;
        folders.push(name);
    });
    return folders;
}

// 扫描 notes/ 或 todos/ 目录，逐份读出原始文本并解析内嵌元数据；返回 { files, skipped }
function readItemFiles(dir, label) {
    const files = [];
    let skipped = 0;
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        console.error(`读取${label}目录失败:`, err);
        return { files, skipped };
    }

    entries.forEach((entry) => {
        if (!entry.isFile()) return;
        // 原子写入中途被打断留下的临时文件：静默跳过，不当成“异常文件”报警
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

// 以文件内容为主、旧索引记录为辅，拼出一篇完整的笔记
function buildNoteFromFile(file, legacy) {
    const meta = file.meta || {};
    const fallback = legacy || {};
    const statTime = file.stat && Number.isFinite(file.stat.mtimeMs) ? Math.round(file.stat.mtimeMs) : Date.now();
    // 取值优先级：文件注释 > 旧索引记录 > 兜底；注释里写了但为空即按空处理，不回头找旧索引
    const pick = (key) => (meta[key] !== undefined ? meta[key] : fallback[key]);

    const createdAt = readNoteMetaNumber(meta.createdAt, readNoteMetaNumber(fallback.createdAt, statTime));

    return {
        id: file.id,
        // 完全没有注释的文件（例如手工放进 notes/ 的 Markdown）用正文首个非空行当标题
        title: readNoteMetaString(pick('title')) || (file.hasMeta ? '' : deriveNoteTitle(file.content)),
        folder: readNoteMetaString(pick('folder')),
        tags: readNoteMetaTags(pick('tags')),
        isPinned: readNoteMetaBoolean(pick('isPinned'), false),
        isTrashed: readNoteMetaBoolean(pick('isTrashed'), false),
        // 秘密本：隐藏状态按元数据取值；加密状态还要正文确实是一份信封才算数
        // （元数据写着加密、正文却是明文的脏数据按未加密处理，免得把明文当成密文解不开）
        isHidden: readNoteMetaBoolean(pick('isHidden'), false),
        locked: readNoteMetaBoolean(meta.isLocked, false) && isSecretEnvelope(file.content),
        // 会话内的解锁标记：从磁盘读到的条目一律是未解锁的
        unlocked: false,
        createdAt,
        updatedAt: readNoteMetaNumber(meta.updatedAt, readNoteMetaNumber(fallback.updatedAt, Math.max(createdAt, statTime))),
        content: file.content
    };
}

// 拼出一份完整的待办：文件格式与笔记一致，仅多一个 isDone 完成状态
function buildTodoFromFile(file) {
    const meta = file.meta || {};
    const statTime = file.stat && Number.isFinite(file.stat.mtimeMs) ? Math.round(file.stat.mtimeMs) : Date.now();
    const createdAt = readNoteMetaNumber(meta.createdAt, statTime);

    return {
        id: file.id,
        // 完全没有注释的文件（例如手工放进 todos/ 的 Markdown）用正文首个非空行当标题
        title: readNoteMetaString(meta.title) || (file.hasMeta ? '' : deriveNoteTitle(file.content)),
        folder: readNoteMetaString(meta.folder),
        tags: readNoteMetaTags(meta.tags),
        isPinned: readNoteMetaBoolean(meta.isPinned, false),
        isTrashed: readNoteMetaBoolean(meta.isTrashed, false),
        isDone: readNoteMetaBoolean(meta.isDone, false),
        // 秘密本：与笔记同一套判定（见 buildNoteFromFile）
        isHidden: readNoteMetaBoolean(meta.isHidden, false),
        locked: readNoteMetaBoolean(meta.isLocked, false) && isSecretEnvelope(file.content),
        unlocked: false,
        createdAt,
        updatedAt: readNoteMetaNumber(meta.updatedAt, Math.max(createdAt, statTime)),
        content: file.content
    };
}

// 读取旧版索引 index.json：只用于把元数据并入各笔记文件，读完即归档
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

// 旧格式文件在迁移完成后改名保留（不直接删除，便于万一回退）
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

// 文件名即对话 id（新建时为随机 10 位；兼容旧版带 chat 前缀的 id）
const AI_CHAT_FILE_PATTERN = /^([A-Za-z0-9_-]{1,64})\.json$/;

// 读取 ai_chats/ 下的全部对话文件；返回 { conversations, raws }，raws 用于判断文件是否需要写回
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
        // 原子写入中途被打断留下的临时文件：静默跳过
        if (isStaleTempFile(entry.name)) return;
        const matched = entry.name.match(AI_CHAT_FILE_PATTERN);
        if (!matched) {
            console.warn(`ai_chats 目录中已忽略非对话文件：${entry.name}`);
            return;
        }
        const filePath = path.join(AI_CHATS_DIR, entry.name);
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            // 文件名即 id：文件被改名后以文件名为准
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

// 对话文件内容：对话本体（id 与文件名一致，消息保留最近的一批）
function serializeAiChat(chat) {
    return `${JSON.stringify({
        id: chat.id,
        title: chat.title || '',
        createdAt: chat.createdAt || Date.now(),
        updatedAt: chat.updatedAt || Date.now(),
        messages: Array.isArray(chat.messages) ? chat.messages.slice(-AI_CHAT_MESSAGE_LIMIT) : []
    }, null, 2)}\n`;
}

// 保存单份对话到 data/ai_chats/{id}.json（内容未变时直接跳过写入）
function saveAiChat(chat) {
    if (!chat || !chat.id) return;
    // 生成期间被删掉的对话不再写回磁盘，否则会凭空多出一份
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

// 删除对话文件，并同步丢弃写入缓存
function deleteAiChatFile(chatId) {
    savedAiChatFiles.delete(chatId);
    try {
        const filePath = path.join(AI_CHATS_DIR, `${chatId}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            // 使用模式：本地删了，服务器上那份也要跟着删
            notifyRemoteDelete(filePath);
        }
    } catch (err) {
        console.error(`删除对话文件 ${chatId}.json 失败:`, err);
    }
}

// 读取旧版单文件记录（ai_chats.json）：仅在拆分到 ai_chats/ 时用一次
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

// 载入全部对话：先读 ai_chats/，再把旧版单文件里的记录拆成一份份文件
// activeIdFromConfig 来自 config.json（当前选中的对话），旧文件里的记录作为兼容兑底
function loadAiChats(activeIdFromConfig) {
    const legacy = readLegacyAiChats();
    const scanned = readAiChatFiles();
    const conversations = scanned.conversations;
    const raws = scanned.raws;

    // 旧记录已有对应文件的以文件为准，其余补进内存并写成独立文件
    const existingIds = new Set(conversations.map(chat => chat.id));
    let merged = 0;
    legacy.conversations.forEach((chat) => {
        if (existingIds.has(chat.id)) return;
        existingIds.add(chat.id);
        conversations.push(chat);
        merged++;
    });
    conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // 超出上限时丢弃最久未使用的对话（与旧版一致的策略），磁盘上的文件一并删除
    const dropped = conversations.splice(AI_CHAT_LIMIT);
    dropped.forEach((chat) => {
        console.warn(`对话记录超出 ${AI_CHAT_LIMIT} 份上限，已清理《${chat.title || '未命名对话'}》`);
        deleteAiChatFile(chat.id);
    });

    // 与磁盘原文比对后写回：新并入的、格式过时的对话在这里落盘
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

    // 对话都已落到各自的文件，旧单文件即可归档
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

// AI 配置规范化：容忍缺失/脏数据，范围与数量都夹在合理区间内。
// 注意这里没有 apiKey：密钥由主进程存进系统密钥链，不随 config.json 落盘，也不会进入渲染进程。
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
        model: pick('model'),
        scope: normalizeAiScope(source.scope),
        maxNotes: Number.isFinite(maxNotes) ? Math.min(Math.max(Math.round(maxNotes), 1), 100) : 10,
        systemPrompt: typeof source.systemPrompt === 'string' ? source.systemPrompt : ''
    };
}

/* 随口记（语音转文本）配置规范化：入口开关与识别语言。
   识别只有一条通道——Windows 自带的桌面识别引擎，在本机完成，音频不出本机 */
function normalizeVoiceConfig(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    return {
        enabled: source.enabled === undefined ? true : !!source.enabled,
        lang: normalizeVoiceLanguage(source.lang)
    };
}

/* 自建同步的自动同步间隔：预设（秒）与自定义秒数的范围，
   取值与 src/main/sync_server.js 的 AUTO_SYNC_* 保持一致。
   没有「每次启动应用时」这一项：只要同步开着，每次启动都会同步一次，与自动同步的设置无关。 */
const SYNC_AUTO_SYNC_PRESETS = { off: 0, '5s': 5, '1m': 60, '5m': 300 };
const SYNC_AUTO_SYNC_VALUES = Object.keys(SYNC_AUTO_SYNC_PRESETS).concat('custom');
const SYNC_AUTO_SYNC_MIN_SECONDS = 5;
const SYNC_AUTO_SYNC_MAX_SECONDS = 24 * 60 * 60;
const SYNC_AUTO_SYNC_DEFAULT_SECONDS = 60;

// 自定义间隔的取值整理：非数字回落到 1 分钟，夹在 5 秒 ~ 24 小时之间
function normalizeAutoSyncSeconds(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return SYNC_AUTO_SYNC_DEFAULT_SECONDS;
    return Math.min(Math.max(Math.round(num), SYNC_AUTO_SYNC_MIN_SECONDS), SYNC_AUTO_SYNC_MAX_SECONDS);
}

/* 自建同步配置规范化：容忍缺失/脏数据。
   注意这里没有令牌：令牌由主进程存进系统密钥链，不随 config.json 落盘、也不进入渲染进程；
   设备 id（deviceId）同样不在配置里——它由主进程生成并保存在配置目录的 sync_state.json，可在设置页「自建同步 → 设备 ID」里查看与复制。
   lastSyncAt / lastSyncSummary 是上一次同步留下的记录，供设置页展示。 */
function normalizeSyncServerConfig(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    const pick = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
    const lastSyncAt = Number(source.lastSyncAt);
    return {
        // 总开关：默认关闭，填好地址后再由用户打开
        enabled: source.enabled === true,
        url: pick('url').replace(/\/+$/, ''),
        // 设备名：只用于在日志里分辨是哪台机器改的
        device: pick('device'),
        // 自动同步：off / 5s / 1m / 5m / custom（off 只是不定时，启动时仍会同步一次）
        autoSync: SYNC_AUTO_SYNC_VALUES.includes(source.autoSync) ? source.autoSync : 'off',
        autoSyncSeconds: normalizeAutoSyncSeconds(source.autoSyncSeconds),
        lastSyncAt: Number.isFinite(lastSyncAt) && lastSyncAt > 0 ? lastSyncAt : 0,
        lastSyncSummary: typeof source.lastSyncSummary === 'string' ? source.lastSyncSummary : ''
    };
}

/* 旧版把 API Key 明文写在 config.json 的 ai.apiKey 里。主进程在启动时已经做过一次迁移，
   这里再兜一次底：万一配置文件里仍有明文（例如数据目录刚从别处拷来），载入时立即交给主进程
   存进系统密钥链，并把明文从内存里的配置抹掉，避免这一轮的任何保存又把它写回磁盘。 */
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

// 密钥保管状态（是否有密钥、怎么保管）由主进程给出，渲染进程拿不到明文
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
    let config = { theme: 'system', themeStyle: 'default', accentColor: '', brandColor: 'brand', cornerRadius: 'default', uiScale: 1, spellcheck: false, uiMode: 'modern', tabsDisabled: false, sidebarCollapsed: false, trashRetentionDays: 0, autoUpdate: true, ghProxyEnabled: false, folders: [], aiActiveChat: '', fonts: {}, ai: {}, voice: {}, syncServer: {} };

    // 1. 读取应用配置 config.json（自定义文件夹列表也存在这里）
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawConfig = fs.readFileSync(CONFIG_FILE, 'utf8');
            if (rawConfig) {
                const parsed = JSON.parse(rawConfig);
                // 旧键迁移：「禁用标签页」这一项原先叫 lineHideTabs（Line 模式专属），
                // 新键缺席时按旧键取值，免得改名后老用户的偏好丢回默认（标签页开启）
                if (parsed && typeof parsed === 'object'
                    && parsed.tabsDisabled === undefined && parsed.lineHideTabs !== undefined) {
                    parsed.tabsDisabled = parsed.lineHideTabs === true;
                }
                config = { ...config, ...parsed };
            }
        } else {
            writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
        }
    } catch (err) {
        console.error('读取 config.json 失败:', err);
    }

    // API Key 不再随配置落盘：收编旧配置里的明文密钥，并同步取一次保管状态
    adoptLegacyApiKey(config);
    const aiKeyStatus = readAiKeyStatus();

    // 2. 旧版数据兼容：index.json 中的元数据只作为兜底来源，稍后并入各笔记文件并归档
    const legacyIndex = readLegacyIndex();

    // 3. 扫描 notes/，逐篇解析文件内嵌的元数据（文件缺失的旧索引记录等于已删除，自然消失）
    const scanned = readNoteFiles();
    const legacyEntries = new Map(legacyIndex.notes.map(entry => [entry.id, entry]));
    const notes = scanned.files.map((file) => {
        const legacy = legacyEntries.get(file.id) || null;
        if (legacy) legacyEntries.delete(file.id);
        return buildNoteFromFile(file, legacy);
    });
    // 旧索引里仍有记录、但文件已不在：说明该笔记早已被删除，不再保留任何痕迹
    const vanishedLegacyNotes = legacyEntries.size;

    // 4. 扫描 todos/：与笔记同一套格式（内嵌注释 + 正文，多一行 isDone）
    const scannedTodos = readTodoFiles();
    const todos = scannedTodos.files.map(file => buildTodoFromFile(file));

    // 5. 文件夹列表 = config.json 中记录的 + 各笔记/待办实际用到的 + 旧索引里出现过的
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

    // 6. 文件夹落到实际存在的名字上（与旧行为一致：已不存在的文件夹回退到“默认”）
    notes.forEach((note) => {
        if (!note.folder || !customFolders.includes(note.folder)) note.folder = '默认';
    });
    todos.forEach((todo) => {
        if (!todo.folder || !customFolders.includes(todo.folder)) todo.folder = '默认';
    });

    // 7. 与磁盘原文逐字节比对：缺少注释、格式过时或字段脏的笔记就地写回，磁盘因此始终与内存一致
    const fileById = new Map(scanned.files.map(file => [file.id, file]));
    const serialized = new Map();
    let repairedNotes = 0;
    let rewriteFailed = 0;
    notes.forEach((note) => {
        const text = serializeNoteFile(note);
        serialized.set(note.id, text);
        const file = fileById.get(note.id);
        if (file && file.raw === text) return;
        try {
            writeFileAtomic(path.join(NOTES_DIR, `${note.id}.md`), text);
            repairedNotes++;
        } catch (err) {
            console.error(`写入笔记 ${note.id} 失败:`, err);
            rewriteFailed++;
        }
    });

    // 8. 元数据都已落到各自的笔记文件，旧索引即可归档（保留 .bak 以便万一回退）
    const legacyArchived = (legacyIndex.found && !rewriteFailed)
        ? archiveLegacyFile(LEGACY_INDEX_FILE, '索引迁移：元数据已写入各笔记文件')
        : false;

    // 9. 待办同样与磁盘原文逐字节比对，格式不一致（缺少 isDone 等）就写回
    const todoFileById = new Map(scannedTodos.files.map(file => [file.id, file]));
    const serializedTodos = new Map();
    let repairedTodos = 0;
    todos.forEach((todo) => {
        const text = serializeTodoFile(todo);
        serializedTodos.set(todo.id, text);
        const file = todoFileById.get(todo.id);
        if (file && file.raw === text) return;
        try {
            writeFileAtomic(path.join(TODOS_DIR, `${todo.id}.md`), text);
            repairedTodos++;
        } catch (err) {
            console.error(`写入待办 ${todo.id} 失败:`, err);
        }
    });

    // 写入缓存与磁盘内容对齐，避免紧接着的首次保存重复写盘
    resetWriteCache();
    notes.forEach(note => savedNoteFiles.set(note.id, serialized.get(note.id)));
    todos.forEach(todo => savedTodoFiles.set(todo.id, serializedTodos.get(todo.id)));

    // 最近修改的排在前面，与列表默认排序一致
    notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    todos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // 10. 载入 AI 对话记录：一份对话一个文件，当前选中的对话记在 config.json 里
    const aiChats = loadAiChats(config.aiActiveChat);

    return {
        theme: config.theme || 'system',
        themeStyle: normalizeThemeStyle(config.themeStyle),
        accentColor: normalizeAccentColor(config.accentColor),
        brandColor: normalizeBrandColor(config.brandColor),
        cornerRadius: normalizeCornerRadius(config.cornerRadius),
        // 界面尺寸（缩放比例）：非法值回落到 100%，与设置页滑块同一套取值
        uiScale: normalizeUiScale(config.uiScale),
        spellcheck: !!config.spellcheck,
        // 界面布局：旧配置里没有该字段（或存着旧值）时即为现代布局
        uiMode: normalizeUiMode(config.uiMode),
        // 现代布局下是否禁用标签页：只有显式写成 true 才算禁用，默认标签页开启
        tabsDisabled: config.tabsDisabled === true,
        sidebarCollapsed: !!config.sidebarCollapsed,
        trashRetentionDays: normalizeTrashRetentionDays(config.trashRetentionDays),
        // 自动更新默认开启：只有显式写成 false 才视为关闭
        autoUpdate: config.autoUpdate !== false,
        // gh-proxy 加速默认关闭：只有显式写成 true 才视为开启
        ghProxyEnabled: config.ghProxyEnabled === true,
        // 开机自启默认关闭：只有显式写成 true 才视为开启
        autoLaunch: config.autoLaunch === true,
        // 系统托盘默认显示：同样只有显式写成 false 才视为关闭
        trayEnabled: config.trayEnabled !== false,
        fonts: normalizeFonts(config.fonts),
        ai: normalizeAiConfig(config.ai),
        // 随口记（语音转文本）：入口、识别语言与联网兜底开关
        voice: normalizeVoiceConfig(config.voice),
        // 自建同步：服务器地址与自动同步设置随数据目录走，令牌在系统密钥链里（不在这份配置中）
        syncServer: normalizeSyncServerConfig(config.syncServer),
        aiKeyStatus,
        aiChats: { conversations: aiChats.conversations, activeId: aiChats.activeId },
        folders: ['默认', ...customFolders],
        notes,
        todos,
        dataCleanup: {
            repairedNotes,
            repairedTodos,
            skippedFiles: scanned.skipped,
            skippedTodoFiles: scannedTodos.skipped,
            // 自定义文件夹列表需要写回 config.json 时标记
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

// 保存配置到 config.json（自定义文件夹列表与当前选中的 AI 对话也随配置一起保存）
function saveConfig() {
    ensureStorageDirs();
    try {
        const config = {
            theme: State.theme,
            themeStyle: normalizeThemeStyle(State.themeStyle),
            accentColor: normalizeAccentColor(State.accentColor),
            brandColor: normalizeBrandColor(State.brandColor),
            cornerRadius: normalizeCornerRadius(State.cornerRadius),
            // 界面尺寸（缩放比例，默认 100%）：渲染进程启动时据它调 Chromium 缩放
            uiScale: normalizeUiScale(State.uiScale),
            spellcheck: State.spellcheck,
            // 界面布局（默认现代）：只接受 classic / modern，脏数据回退为现代布局
            // （normalizeUiMode 还认旧值 line / notab / minimal 与 standard，见 scripts/state.js）
            uiMode: normalizeUiMode(State.uiMode),
            // 现代布局下是否禁用标签页（经典布局下无效，但偏好照旧留着）
            tabsDisabled: State.tabsDisabled === true,
            sidebarCollapsed: !!State.sidebarCollapsed,
            trashRetentionDays: normalizeTrashRetentionDays(State.trashRetentionDays),
            // 自动更新（默认开启）：主进程读取这一项决定是否在启动后自动检查
            autoUpdate: State.autoUpdate !== false,
            // gh-proxy 加速（默认关闭）：主进程读取这一项决定检查更新与下载安装包时是否先走代理
            ghProxyEnabled: State.ghProxyEnabled === true,
            // 开机自启（默认关闭）：主进程读取这一项决定是否登记系统启动项
            autoLaunch: State.autoLaunch === true,
            // 系统托盘（默认显示）：主进程读取这一项决定是否创建托盘图标
            trayEnabled: State.trayEnabled !== false,
            // 当前选中的 AI 对话：对话本体在 ai_chats/ 下，这里只记一个 id
            aiActiveChat: typeof State.aiActiveConversationId === 'string' ? State.aiActiveConversationId : '',
            folders: normalizeCustomFolders(State.folders),
            fonts: normalizeFonts(State.fonts),
            ai: normalizeAiConfig(State.ai),
            // 随口记（语音转文本）：默认只走本机离线识别
            voice: normalizeVoiceConfig(State.voice)
        };

        // 自建同步配置只在从磁盘载入过之后才写回（载入点见 app.js 与 data_location.js）：
        // 漏一个字段只是这次的同步配置不落盘，直接写却会把用户填好的地址静默抹成默认值
        if (State.syncServerLoaded) config.syncServer = normalizeSyncServerConfig(State.syncServer);

        const json = JSON.stringify(config, null, 2);
        if (json === savedConfigJSON) return;
        writeFileAtomic(CONFIG_FILE, json);
        savedConfigJSON = json;
    } catch (err) {
        console.error('保存 config.json 失败:', err);
    }
}

// 保存单篇笔记：元数据注释与正文一起写回 data/notes/{id}.md（内容未变时跳过写入）
function saveNote(note) {
    if (!note || !note.id) return;
    ensureStorageDirs();
    try {
        const text = serializeNoteFile(note);
        if (savedNoteFiles.get(note.id) === text) return;
        writeFileAtomic(path.join(NOTES_DIR, `${note.id}.md`), text);
        savedNoteFiles.set(note.id, text);
    } catch (err) {
        console.error(`保存笔记 ${note.id} 失败:`, err);
    }
}

// 删除笔记文件（元数据与正文同在一份文件，删掉即彻底移除），并同步丢弃写入缓存
function deleteNoteFile(noteId) {
    savedNoteFiles.delete(noteId);
    // 会话里若还留着这一条的密钥，随文件一起丢掉
    if (typeof forgetSecretKey === 'function') forgetSecretKey(noteId);
    try {
        const notePath = path.join(NOTES_DIR, `${noteId}.md`);
        if (fs.existsSync(notePath)) {
            fs.unlinkSync(notePath);
            // 使用模式：本地删了，服务器上那份也要跟着删
            notifyRemoteDelete(notePath);
        }
    } catch (err) {
        console.error(`删除笔记文件 ${noteId}.md 失败:`, err);
    }
}

// 保存单份待办：写回 data/todos/{id}.md，格式与笔记一致（内容未变时跳过写入）
function saveTodo(todo) {
    if (!todo || !todo.id) return;
    ensureStorageDirs();
    try {
        const text = serializeTodoFile(todo);
        if (savedTodoFiles.get(todo.id) === text) return;
        writeFileAtomic(path.join(TODOS_DIR, `${todo.id}.md`), text);
        savedTodoFiles.set(todo.id, text);
    } catch (err) {
        console.error(`保存待办 ${todo.id} 失败:`, err);
    }
}

// 删除待办文件（元数据与正文同在一份文件，删掉即彻底移除），并同步丢弃写入缓存
function deleteTodoFile(todoId) {
    savedTodoFiles.delete(todoId);
    // 会话里若还留着这一条的密钥，随文件一起丢掉
    if (typeof forgetSecretKey === 'function') forgetSecretKey(todoId);
    try {
        const todoPath = path.join(TODOS_DIR, `${todoId}.md`);
        if (fs.existsSync(todoPath)) {
            fs.unlinkSync(todoPath);
            // 使用模式：本地删了，服务器上那份也要跟着删
            notifyRemoteDelete(todoPath);
        }
    } catch (err) {
        console.error(`删除待办文件 ${todoId}.md 失败:`, err);
    }
}

// 按条目类型分发读写：笔记与待办共用编辑器与标签页，保存/删除时按归属选目标目录
function saveItem(item) {
    if (isTodoItem(item)) saveTodo(item);
    else saveNote(item);
}

function deleteItemFile(itemId) {
    // 会话里若还留着这一条的密钥，随文件一起丢掉
    if (typeof forgetSecretKey === 'function') forgetSecretKey(itemId);
    if (State.todos.some(todo => todo.id === itemId)) deleteTodoFile(itemId);
    else deleteNoteFile(itemId);
}
