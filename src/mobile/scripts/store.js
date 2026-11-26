const DB_NAME = 'esprin-nemo-mobile';
const DB_VERSION = 1;
const FILE_STORE = 'files';
const LOCAL_STORE = 'local';

const LS_PREFIX_FILE = 'enm.file:';
const LS_PREFIX_LOCAL = 'enm.local:';

const changes = new Set();

let backend = null;
let opening = null;

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function createIdbBackend(db) {
    const read = (storeName, key) => new Promise((resolve, reject) => {
        let request;
        try {
            request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        } catch (err) {
            reject(err);
            return;
        }
        request.onsuccess = () => resolve(request.result === undefined ? null : request.result);
        request.onerror = () => reject(request.error);
    });

    const write = (storeName, key, value) => new Promise((resolve, reject) => {
        let request;
        try {
            request = db.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key);
        } catch (err) {
            reject(err);
            return;
        }
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });

    const remove = (storeName, key) => new Promise((resolve, reject) => {
        let request;
        try {
            request = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key);
        } catch (err) {
            reject(err);
            return;
        }
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });

    return {
        name: 'indexeddb',
        getFile: (path) => read(FILE_STORE, path),
        setFile: (path, record) => write(FILE_STORE, path, record),
        deleteFile: (path) => remove(FILE_STORE, path),
        allFiles: async () => {
            const keys = await requestToPromise(db.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).getAllKeys());
            const entries = [];
            for (const key of keys) {
                const record = await read(FILE_STORE, key);
                if (record) entries.push([key, record]);
            }
            return entries;
        },
        clearFiles: () => new Promise((resolve, reject) => {
            const request = db.transaction(FILE_STORE, 'readwrite').objectStore(FILE_STORE).clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        }),
        getLocal: (key) => read(LOCAL_STORE, key),
        setLocal: (key, value) => write(LOCAL_STORE, key, value),
        deleteLocal: (key) => remove(LOCAL_STORE, key)
    };
}

function createLocalStorageBackend() {
    const storage = window.localStorage;
    return {
        name: 'localstorage',
        getFile: async (path) => {
            const raw = storage.getItem(LS_PREFIX_FILE + path);
            if (!raw) return null;
            try {
                return JSON.parse(raw);
            } catch (err) {
                return null;
            }
        },
        setFile: async (path, record) => {
            storage.setItem(LS_PREFIX_FILE + path, JSON.stringify(record));
        },
        deleteFile: async (path) => {
            storage.removeItem(LS_PREFIX_FILE + path);
        },
        allFiles: async () => {
            const entries = [];
            for (let i = 0; i < storage.length; i += 1) {
                const key = storage.key(i);
                if (!key || !key.startsWith(LS_PREFIX_FILE)) continue;
                try {
                    entries.push([key.slice(LS_PREFIX_FILE.length), JSON.parse(storage.getItem(key))]);
                } catch (err) {
                }
            }
            return entries;
        },
        clearFiles: async () => {
            const keys = [];
            for (let i = 0; i < storage.length; i += 1) {
                const key = storage.key(i);
                if (key && key.startsWith(LS_PREFIX_FILE)) keys.push(key);
            }
            keys.forEach((key) => storage.removeItem(key));
        },
        getLocal: async (key) => {
            const raw = storage.getItem(LS_PREFIX_LOCAL + key);
            if (!raw) return null;
            try {
                return JSON.parse(raw);
            } catch (err) {
                return null;
            }
        },
        setLocal: async (key, value) => {
            storage.setItem(LS_PREFIX_LOCAL + key, JSON.stringify(value));
        },
        deleteLocal: async (key) => {
            storage.removeItem(LS_PREFIX_LOCAL + key);
        }
    };
}

function openIndexedDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined' || !indexedDB) {
            reject(new Error('IndexedDB 不可用'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE);
            if (!db.objectStoreNames.contains(LOCAL_STORE)) db.createObjectStore(LOCAL_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
        request.onblocked = () => reject(new Error('IndexedDB 被占用'));
    });
}

export async function openStore() {
    if (backend) return backend;
    if (opening) return opening;

    opening = (async () => {
        try {
            const db = await openIndexedDb();
            backend = createIdbBackend(db);
        } catch (err) {
            console.warn('[Mobile:WARN] IndexedDB 不可用，改用 localStorage：', err && err.message);
            backend = createLocalStorageBackend();
        }
        return backend;
    })();

    await opening;
    return backend;
}

export function storageBackendName() {
    return backend ? backend.name : '';
}

export async function readRecord(path) {
    await openStore();
    return backend.getFile(path);
}

export async function writeRecord(path, record) {
    await openStore();
    await backend.setFile(path, record);
}

export async function deleteRecord(path) {
    await openStore();
    await backend.deleteFile(path);
}

export async function listRecords() {
    await openStore();
    return backend.allFiles();
}

export async function clearFiles() {
    await openStore();
    await backend.clearFiles();
}

export async function readText(path) {
    const record = await readRecord(path);
    if (!record || record.enc !== 'utf8') return null;
    return record.data;
}
export async function writeText(path, text) {
    const record = { enc: 'utf8', data: String(text == null ? '' : text), time: Date.now() };
    await writeRecord(path, record);
    notify(path);
    return record;
}

export async function removeFile(path) {
    await deleteRecord(path);
    notify(path);
}

function notify(path) {
    changes.forEach((listener) => {
        try {
            listener(path);
        } catch (err) {
            console.warn('[Mobile:WARN] 文件变更回调失败：', err && err.message);
        }
    });
}

export function onFileChange(listener) {
    changes.add(listener);
    return () => changes.delete(listener);
}

const SETTINGS_KEY = 'settings';

export const defaultSettings = {
    theme: 'system',
    sortBy: 'updated-desc',
    sync: {
        url: '',
        token: '',
        tokenName: '',
        account: '',
        deviceId: '',
        journalId: '',
        lastSeq: 0,
        selfPushed: [],
        lastSyncAt: 0,
        summary: ''
    }
};

function mergeSettings(stored) {
    const source = stored && typeof stored === 'object' ? stored : {};
    return {
        ...defaultSettings,
        ...source,
        sync: { ...defaultSettings.sync, ...(source.sync && typeof source.sync === 'object' ? source.sync : {}) }
    };
}

export async function readSettings() {
    await openStore();
    return mergeSettings(await backend.getLocal(SETTINGS_KEY));
}

export async function writeSettings(settings) {
    await openStore();
    await backend.setLocal(SETTINGS_KEY, settings);
    return settings;
}

export async function patchSettings(patch) {
    const current = await readSettings();
    const next = { ...current, ...patch };
    if (patch && patch.sync) next.sync = { ...current.sync, ...patch.sync };
    await writeSettings(next);
    return next;
}

const OUTBOX_KEY = 'outbox';

export async function readOutbox() {
    await openStore();
    const list = await backend.getLocal(OUTBOX_KEY);
    return Array.isArray(list) ? list : [];
}

export async function writeOutbox(list) {
    await openStore();
    await backend.setLocal(OUTBOX_KEY, Array.isArray(list) ? list : []);
}

export function mergeOutboxOp(list, op) {
    const others = list.filter((item) => item.path !== op.path);
    others.push(op);
    return others;
}
