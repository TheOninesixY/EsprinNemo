/* 数据持久化：数据目录，以及 config.json / index.json / notes/{id}.md 的读写 */

// 数据目录可在设置页中更改，因此路径均为可变变量（切换位置后就地生效，无需重启）
let DATA_DIR = resolveDataDir();
let NOTES_DIR = path.join(DATA_DIR, 'notes');
let CONFIG_FILE = path.join(DATA_DIR, 'config.json');
let INDEX_FILE = path.join(DATA_DIR, 'index.json');

// 写入缓存：待写入内容与上次落盘完全一致时直接跳过，避免自动保存产生重复 I/O
const savedNoteContent = new Map(); // noteId -> 已写入磁盘的正文
let savedConfigJSON = null;
let savedIndexJSON = null;

function resetWriteCache() {
    savedNoteContent.clear();
    savedConfigJSON = null;
    savedIndexJSON = null;
}

// 应用新的数据目录（主进程已完成校验/迁移/记录，这里只负责切换本进程使用的路径）
function setDataPaths(dir) {
    DATA_DIR = dir;
    NOTES_DIR = path.join(dir, 'notes');
    CONFIG_FILE = path.join(dir, 'config.json');
    INDEX_FILE = path.join(dir, 'index.json');
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

function loadData() {
    ensureStorageDirs();
    let config = { theme: 'system', accentColor: '', spellcheck: false, sidebarCollapsed: false, trashRetentionDays: 0, fonts: {} };
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
            fonts: normalizeFonts(State.fonts)
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
