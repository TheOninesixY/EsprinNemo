(function () {
    'use strict';

    if (typeof window.require === 'function') return;

    const WEB_MODE_CLASS = 'web-mode';
    const DATA_DIR = '/esprin/data';
    const APP_DATA_DIR = '/esprin/appdata';
    const CONFIG_DIR = '/esprin/appdata/esprin_nemo';
    const PICKED_DIR = '/esprin/picked';
    const MIRROR_KEY = 'esprin.nemo.web_fs.v1';
    const MIRROR_BUDGET_BYTES = 3 * 1024 * 1024;
    const DB_NAME = 'esprin-nemo-web';
    const DB_VERSION = 1;
    const DB_FILES = 'files';
    const DB_META = 'meta';
    const WRITE_DEBOUNCE_MS = 200;

    function log(level, message) {
        const line = `[${level}] [WebHost] ${message}`;
        if (level === 'ERROR') console.error(line);
        else if (level === 'WARN') console.warn(line);
        else console.log(line);
    }

    function appVersion() {
        return String(window.__esprinVersion || '');
    }

    function appReleaseNotes() {
        const payload = window.__esprinReleaseNotes;
        if (!payload || typeof payload.notes !== 'string' || !payload.notes.trim()) return null;
        return {
            version: String(payload.version || appVersion()),
            notes: payload.notes,
            publishedAt: String(payload.publishedAt || ''),
            releaseUrl: ''
        };
    }

    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder('utf-8');

    function bytesFromBase64(text) {
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function base64FromBytes(bytes) {
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }

    class BufferPolyfill extends Uint8Array {
        static from(value, encoding) {
            if (typeof value === 'string') {
                if (encoding === 'base64') return new BufferPolyfill(bytesFromBase64(value));
                return new BufferPolyfill(textEncoder.encode(value));
            }
            if (value instanceof ArrayBuffer) return new BufferPolyfill(new Uint8Array(value));
            if (value instanceof Uint8Array) return new BufferPolyfill(value);
            if (Array.isArray(value)) return new BufferPolyfill(Uint8Array.from(value));
            if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
                return new BufferPolyfill(Uint8Array.from(value.data));
            }
            throw new TypeError('Buffer.from: 参数不支持');
        }

        static alloc(size) {
            return new BufferPolyfill(size);
        }

        static concat(list) {
            let total = 0;
            list.forEach((item) => { total += item.length; });
            const merged = new BufferPolyfill(total);
            let offset = 0;
            list.forEach((item) => {
                merged.set(item, offset);
                offset += item.length;
            });
            return merged;
        }

        static isBuffer(value) {
            return value instanceof BufferPolyfill;
        }

        static byteLength(value) {
            return BufferPolyfill.from(value).length;
        }

        toString(encoding) {
            if (encoding === 'base64') return base64FromBytes(this);
            if (encoding === 'hex') {
                let out = '';
                for (let i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, '0');
                return out;
            }
            return textDecoder.decode(this);
        }
    }

    const path = (() => {
        function normalize(input) {
            const absolute = String(input || '').startsWith('/');
            const parts = [];
            String(input || '').split('/').forEach((segment) => {
                if (!segment || segment === '.') return;
                if (segment === '..') parts.pop();
                else parts.push(segment);
            });
            const joined = (absolute ? '/' : '') + parts.join('/');
            return joined || (absolute ? '/' : '');
        }

        return {
            sep: '/',
            delimiter: ':',
            normalize,
            isAbsolute(target) {
                return String(target || '').startsWith('/');
            },
            join(...parts) {
                return normalize(parts.filter((part) => part !== undefined && part !== null && part !== '').join('/'));
            },
            resolve(...parts) {
                let result = '';
                parts.forEach((part) => {
                    if (!part) return;
                    result = String(part).startsWith('/') ? String(part) : `${result}/${part}`;
                });
                return normalize(result || '/');
            },
            dirname(target) {
                const value = normalize(target);
                if (value === '/') return '/';
                const cut = value.lastIndexOf('/');
                return cut <= 0 ? '/' : value.slice(0, cut);
            },
            basename(target, extension) {
                const value = normalize(target);
                const name = value.slice(value.lastIndexOf('/') + 1);
                if (extension && name.endsWith(extension)) return name.slice(0, -extension.length);
                return name;
            },
            extname(target) {
                const value = normalize(target);
                const name = value.slice(value.lastIndexOf('/') + 1);
                const dot = name.lastIndexOf('.');
                return dot <= 0 ? '' : name.slice(dot);
            },
            relative(from, to) {
                const fromParts = normalize(from).split('/').filter(Boolean);
                const toParts = normalize(to).split('/').filter(Boolean);
                let shared = 0;
                while (shared < fromParts.length && fromParts[shared] === toParts[shared]) shared += 1;
                const up = new Array(fromParts.length - shared).fill('..');
                return up.concat(toParts.slice(shared)).join('/');
            }
        };
    })();

    const vfs = (() => {
        const dirs = new Set(['/']);
        const files = new Map();
        const written = new Map();
        let persistTimer = null;
        let mirrorAvailable = true;
        let mirrorTruncated = false;
        let database = null;
        let databasePromise = null;

        function ensureDir(target) {
            const parts = normalizePath(target).split('/').filter(Boolean);
            let current = '';
            parts.forEach((segment) => {
                current += `/${segment}`;
                dirs.add(current);
            });
        }

        function normalizePath(target) {
            return path.resolve(String(target || ''));
        }

        function isDir(target) {
            const value = normalizePath(target);
            if (dirs.has(value)) return true;
            const prefix = value === '/' ? '/' : `${value}/`;
            for (const item of files.keys()) {
                if (item.startsWith(prefix)) return true;
            }
            return false;
        }

        function isFile(target) {
            return files.has(normalizePath(target));
        }

        function notFound(target) {
            const error = new Error(`ENOENT: no such file or directory, open '${target}'`);
            error.code = 'ENOENT';
            return error;
        }

        function openDatabase() {
            if (databasePromise) return databasePromise;
            databasePromise = new Promise((resolve, reject) => {
                if (!window.indexedDB) {
                    reject(new Error('IndexedDB 不可用'));
                    return;
                }
                const request = window.indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = () => {
                    const opened = request.result;
                    if (!opened.objectStoreNames.contains(DB_FILES)) opened.createObjectStore(DB_FILES);
                    if (!opened.objectStoreNames.contains(DB_META)) opened.createObjectStore(DB_META);
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error || new Error('打开失败'));
                request.onblocked = () => reject(new Error('被其它标签页占用'));
            });
            return databasePromise;
        }

        function collectDelta() {
            const batch = [];
            files.forEach((entry, key) => {
                if (written.get(key) !== entry) batch.push([key, entry]);
            });
            written.forEach((entry, key) => {
                if (!files.has(key)) batch.push([key, null]);
            });
            return batch;
        }

        async function readDatabase() {
            const opened = await openDatabase();
            database = opened;

            const loaded = await new Promise((resolve, reject) => {
                const tx = opened.transaction([DB_FILES, DB_META], 'readonly');
                const entriesRequest = tx.objectStore(DB_FILES).getAll();
                const keysRequest = tx.objectStore(DB_FILES).getAllKeys();
                const dirsRequest = tx.objectStore(DB_META).get('dirs');
                tx.oncomplete = () => resolve({
                    entries: entriesRequest.result || [],
                    keys: keysRequest.result || [],
                    dirs: dirsRequest.result || []
                });
                tx.onerror = () => reject(tx.error || new Error('读取失败'));
                tx.onabort = () => reject(tx.error || new Error('读取中止'));
            });

            const keep = new Set(collectDelta().map(([key]) => key));
            let changed = false;

            loaded.dirs.forEach((item) => {
                const value = normalizePath(item);
                if (dirs.has(value)) return;
                dirs.add(value);
                changed = true;
            });

            const known = new Set();
            loaded.keys.forEach((key, index) => {
                const value = normalizePath(key);
                known.add(value);
                const entry = loaded.entries[index];
                if (!entry || keep.has(value)) return;
                const current = files.get(value);
                if (current && current.mtime === entry.mtime && !!current.binary === !!entry.binary) return;
                files.set(value, entry.binary
                    ? { binary: true, data: toBytes(entry.data), mtime: entry.mtime }
                    : { binary: false, text: String(entry.text), mtime: entry.mtime });
                changed = true;
            });

            return { changed, known };
        }

        async function flush() {
            const batch = collectDelta();
            if (!batch.length || !database) return;
            await new Promise((resolve, reject) => {
                const tx = database.transaction([DB_FILES, DB_META], 'readwrite');
                const store = tx.objectStore(DB_FILES);
                batch.forEach(([key, entry]) => {
                    if (entry) store.put(entry, key);
                    else store.delete(key);
                });
                tx.objectStore(DB_META).put(Array.from(dirs), 'dirs');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('写入失败'));
                tx.onabort = () => reject(tx.error || new Error('写入中止'));
            });
            batch.forEach(([key, entry]) => {
                if (entry) written.set(key, entry);
                else written.delete(key);
            });
        }

        function buildMirror(includeBinary) {
            const payload = { v: 2, dirs: Array.from(dirs), files: {}, truncated: mirrorTruncated };
            let size = 0;
            files.forEach((entry, key) => {
                if (entry.binary && !includeBinary) {
                    payload.truncated = true;
                    return;
                }
                const record = entry.binary
                    ? { b: 1, d: base64FromBytes(entry.data), m: entry.mtime || 0 }
                    : { b: 0, d: entry.text, m: entry.mtime || 0 };
                size += key.length + record.d.length;
                if (size > MIRROR_BUDGET_BYTES) {
                    payload.truncated = true;
                    return;
                }
                payload.files[key] = record;
            });
            return payload;
        }

        function writeMirror() {
            if (!mirrorAvailable) return;
            try {
                const payload = buildMirror(true);
                mirrorTruncated = payload.truncated;
                window.localStorage.setItem(MIRROR_KEY, JSON.stringify(payload));
                return;
            } catch (error) {
                try {
                    const payload = buildMirror(false);
                    mirrorTruncated = true;
                    window.localStorage.setItem(MIRROR_KEY, JSON.stringify(payload));
                    log('WARN', `启动镜像超出配额，已跳过二进制文件 (detail=${error && error.message})`);
                    return;
                } catch (retryError) {
                    mirrorAvailable = false;
                    log('ERROR', `启动镜像写入失败，下次启动改由浏览器数据库载入 (detail=${retryError && retryError.message})`);
                }
            }
        }

        function persist() {
            clearTimeout(persistTimer);
            persistTimer = setTimeout(() => {
                persistTimer = null;
                flush()
                    .then(() => writeMirror())
                    .catch((error) => log('ERROR', `浏览器数据库写入失败 (detail=${error && error.message})`));
            }, WRITE_DEBOUNCE_MS);
        }

        function loadMirror() {
            let raw = '';
            try {
                raw = window.localStorage.getItem(MIRROR_KEY) || '';
            } catch (error) {
                mirrorAvailable = false;
                log('WARN', `启动镜像不可用，数据改由浏览器数据库载入 (detail=${error && error.message})`);
                return;
            }
            if (!raw) return;
            try {
                const payload = JSON.parse(raw);
                (payload.dirs || []).forEach((item) => dirs.add(normalizePath(item)));
                Object.keys(payload.files || {}).forEach((key) => {
                    const entry = payload.files[key];
                    const mtime = Number(entry.m) || 0;
                    if (entry.b) files.set(normalizePath(key), { binary: true, data: bytesFromBase64(entry.d), mtime });
                    else files.set(normalizePath(key), { binary: false, text: String(entry.d), mtime });
                });
                mirrorTruncated = !!payload.truncated;
            } catch (error) {
                log('ERROR', `启动镜像无法解析，数据改由浏览器数据库载入 (detail=${error && error.message})`);
            }
        }

        async function open() {
            let result;
            try {
                result = await readDatabase();
            } catch (error) {
                log('WARN', `浏览器数据库不可用，仅使用启动镜像 (detail=${error && error.message})`);
                return false;
            }
            try {
                await flush();
            } catch (error) {
                log('ERROR', `浏览器数据库写入失败 (detail=${error && error.message})`);
            }
            writeMirror();
            return result.changed;
        }

        function backend() {
            return database ? 'IndexedDB' : '启动镜像';
        }

        function toBytes(value) {
            if (value instanceof Uint8Array) return new Uint8Array(value);
            if (value instanceof ArrayBuffer) return new Uint8Array(value);
            if (typeof value === 'string') return textEncoder.encode(value);
            return new Uint8Array(value || 0);
        }

        function snapshot() {
            const names = [];
            const prefix = '/';
            files.forEach((entry, key) => {
                if (key.startsWith(prefix)) names.push(key);
            });
            return names;
        }

        loadMirror();

        return {
            open,
            flush,
            backend,
            normalizePath,
            ensureDir,
            isDir,
            isFile,
            existsSync(target) {
                return isDir(target) || isFile(target);
            },
            mkdirSync(target) {
                ensureDir(target);
                persist();
            },
            readdirSync(target, options) {
                const value = normalizePath(target);
                if (!isDir(value)) throw notFound(value);
                const prefix = value === '/' ? '/' : `${value}/`;
                const result = new Set();
                dirs.forEach((item) => {
                    if (item !== value && item.startsWith(prefix)) {
                        const rest = item.slice(prefix.length);
                        if (rest && !rest.includes('/')) result.add(rest);
                    }
                });
                files.forEach((entry, key) => {
                    if (key.startsWith(prefix)) {
                        const rest = key.slice(prefix.length);
                        if (rest && !rest.includes('/')) result.add(rest);
                    }
                });
                const names = Array.from(result).sort();
                if (!options || !options.withFileTypes) return names;
                return names.map((name) => ({
                    name,
                    isDirectory: () => isDir(`${value}/${name}`),
                    isFile: () => isFile(`${value}/${name}`)
                }));
            },
            statSync(target) {
                const value = normalizePath(target);
                if (isFile(value)) {
                    const entry = files.get(value);
                    const size = entry.binary ? entry.data.length : textEncoder.encode(entry.text).length;
                    return { size, isDirectory: () => false, isFile: () => true, mtimeMs: entry.mtime || 0 };
                }
                if (isDir(value)) {
                    return { size: 0, isDirectory: () => true, isFile: () => false, mtimeMs: 0 };
                }
                throw notFound(value);
            },
            readFileSync(target, encoding) {
                const value = normalizePath(target);
                const entry = files.get(value);
                if (!entry) throw notFound(value);
                if (encoding === 'utf8' || encoding === 'utf-8') {
                    return entry.binary ? textDecoder.decode(entry.data) : entry.text;
                }
                if (encoding === 'base64') {
                    return entry.binary ? base64FromBytes(entry.data) : base64FromBytes(textEncoder.encode(entry.text));
                }
                return BufferPolyfill.from(entry.binary ? entry.data : textEncoder.encode(entry.text));
            },
            writeFileSync(target, data) {
                const value = normalizePath(target);
                ensureDir(path.dirname(value));
                if (typeof data === 'string') {
                    files.set(value, { binary: false, text: data, mtime: Date.now() });
                } else {
                    files.set(value, { binary: true, data: toBytes(data), mtime: Date.now() });
                }
                persist();
            },
            copyFileSync(from, to) {
                const source = normalizePath(from);
                const target = normalizePath(to);
                const entry = files.get(source);
                if (!entry) throw notFound(source);
                ensureDir(path.dirname(target));
                files.set(target, { ...entry });
                persist();
            },
            renameSync(from, to) {
                const source = normalizePath(from);
                const target = normalizePath(to);
                if (files.has(source)) {
                    const entry = files.get(source);
                    files.delete(source);
                    ensureDir(path.dirname(target));
                    files.set(target, entry);
                    persist();
                    return;
                }
                if (isDir(source)) {
                    const prefix = `${source}/`;
                    files.forEach((entry, key) => {
                        if (!key.startsWith(prefix)) return;
                        files.delete(key);
                        files.set(`${target}/${key.slice(prefix.length)}`, entry);
                    });
                    persist();
                    return;
                }
                throw notFound(source);
            },
            unlinkSync(target) {
                const value = normalizePath(target);
                if (files.delete(value)) {
                    persist();
                    return;
                }
                if (!isDir(value)) throw notFound(value);
                const prefix = `${value}/`;
                Array.from(files.keys()).forEach((key) => {
                    if (key.startsWith(prefix)) files.delete(key);
                });
                Array.from(dirs).forEach((item) => {
                    if (item === value || item.startsWith(prefix)) dirs.delete(item);
                });
                persist();
            },
            listKeys: snapshot
        };
    })();

    const cryptoShim = (() => {
        const K = new Uint32Array([
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ]);
        const INIT = new Uint32Array([
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        ]);

        function rotateRight(value, bits) {
            return ((value >>> bits) | (value << (32 - bits))) >>> 0;
        }

        function sha256(bytes) {
            const length = bytes.length;
            const padded = length + 1 + ((56 - (length + 1) % 64) + 64) % 64 + 8;
            const buffer = new Uint8Array(padded);
            buffer.set(bytes);
            buffer[length] = 0x80;
            const view = new DataView(buffer.buffer);
            view.setUint32(padded - 8, Math.floor(length / 0x20000000) >>> 0, false);
            view.setUint32(padded - 4, (length << 3) >>> 0, false);

            const hash = INIT.slice();
            const w = new Uint32Array(64);

            for (let offset = 0; offset < padded; offset += 64) {
                for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
                for (let i = 16; i < 64; i++) {
                    const x = w[i - 15];
                    const y = w[i - 2];
                    const s0 = (rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)) >>> 0;
                    const s1 = (rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)) >>> 0;
                    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
                }

                let [a, b, c, d, e, f, g, h] = hash;
                for (let i = 0; i < 64; i++) {
                    const s1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
                    const ch = ((e & f) ^ (~e & g)) >>> 0;
                    const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
                    const s0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
                    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
                    const temp2 = (s0 + maj) >>> 0;
                    h = g; g = f; f = e;
                    e = (d + temp1) >>> 0;
                    d = c; c = b; b = a;
                    a = (temp1 + temp2) >>> 0;
                }

                hash[0] = (hash[0] + a) >>> 0;
                hash[1] = (hash[1] + b) >>> 0;
                hash[2] = (hash[2] + c) >>> 0;
                hash[3] = (hash[3] + d) >>> 0;
                hash[4] = (hash[4] + e) >>> 0;
                hash[5] = (hash[5] + f) >>> 0;
                hash[6] = (hash[6] + g) >>> 0;
                hash[7] = (hash[7] + h) >>> 0;
            }

            const out = new Uint8Array(32);
            const outView = new DataView(out.buffer);
            hash.forEach((value, index) => outView.setUint32(index * 4, value, false));
            return out;
        }

        function toBytes(value) {
            if (typeof value === 'string') return textEncoder.encode(value);
            if (value instanceof Uint8Array) return value;
            if (value instanceof ArrayBuffer) return new Uint8Array(value);
            return textEncoder.encode(String(value));
        }

        return {
            randomBytes(size) {
                const bytes = new Uint8Array(size);
                if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
                else for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256);
                return BufferPolyfill.from(bytes);
            },
            createHash(algorithm) {
                if (String(algorithm).toLowerCase().replace('-', '') !== 'sha256') {
                    throw new Error(`网页宿主只提供 sha256 (algorithm=${algorithm})`);
                }
                const chunks = [];
                return {
                    update(chunk) {
                        chunks.push(toBytes(chunk));
                        return this;
                    },
                    digest(encoding) {
                        let total = 0;
                        chunks.forEach((chunk) => { total += chunk.length; });
                        const merged = new Uint8Array(total);
                        let offset = 0;
                        chunks.forEach((chunk) => {
                            merged.set(chunk, offset);
                            offset += chunk.length;
                        });
                        const out = BufferPolyfill.from(sha256(merged));
                        return encoding ? out.toString(encoding) : out;
                    }
                };
            },
            createCipheriv() {
                throw new Error('网页模式不提供对称加密（加密笔记不可用）');
            },
            createDecipheriv() {
                throw new Error('网页模式不提供对称加密（加密笔记不可用）');
            },
            pbkdf2Sync() {
                throw new Error('网页模式不提供密钥派生（加密笔记不可用）');
            }
        };
    })();

    let pickedCounter = 0;

    function pickFiles({ multiple = false, accept = '' } = {}) {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = multiple;
            if (accept) input.accept = accept;
            input.style.display = 'none';
            document.body.appendChild(input);
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                input.remove();
                resolve(result);
            };
            input.addEventListener('change', async () => {
                const list = Array.from(input.files || []);
                if (!list.length) {
                    finish({ canceled: true, paths: [] });
                    return;
                }
                vfs.ensureDir(PICKED_DIR);
                const paths = [];
                for (const file of list) {
                    pickedCounter += 1;
                    const target = path.join(PICKED_DIR, `${Date.now()}_${pickedCounter}_${file.name}`);
                    const buffer = await file.arrayBuffer();
                    vfs.writeFileSync(target, new Uint8Array(buffer));
                    paths.push(target);
                }
                finish({ canceled: false, paths });
            });
            window.addEventListener('focus', () => {
                setTimeout(() => {
                    if (!input.files || !input.files.length) finish({ canceled: true, paths: [] });
                }, 500);
            }, { once: true });
            input.click();
        });
    }

    function virtualPathFor(file) {
        if (!file || !file.name) return '';
        pickedCounter += 1;
        vfs.ensureDir(PICKED_DIR);
        const target = path.join(PICKED_DIR, `${Date.now()}_${pickedCounter}_${file.name}`);
        return target;
    }

    function downloadFile(name, bytes, mime) {
        const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    const DESKTOP_ONLY = '浏览器不支持该能力';

    function noopIcon() {
        return { enabled: false, items: [] };
    }

    const syncStatusStub = {
        enabled: false,
        url: '',
        device: '',
        deviceId: '',
        autoSync: 'off',
        autoSyncSeconds: 0,
        intervalMs: 0,
        startupSync: false,
        active: false,
        lastSeq: 0,
        lastSyncAt: 0,
        lastSyncSummary: '',
        pending: 0,
        hasToken: false,
        strong: false,
        lastError: ''
    };

    const updateSnapshotStub = {
        status: 'unsupported',
        get currentVersion() {
            return appVersion();
        },
        repoUrl: 'https://github.com/EsprinProject/Nemo',
        autoUpdate: false,
        ghProxyEnabled: false,
        canAutoInstall: false,
        packaged: false,
        checking: false,
        downloading: false,
        downloaded: false,
        progress: null,
        lastCheckAt: 0,
        error: '',
        get currentRelease() {
            return appReleaseNotes();
        },
        get currentReleaseStatus() {
            return appReleaseNotes() ? 'ready' : 'error';
        },
        currentReleaseError: '.github/releases.md 中没有本版说明',
        update: null
    };

    const handlers = {
        'data:get-dir-sync': { sync: true, run: () => DATA_DIR },
        'data:get-dir': {
            run: () => ({
                dataDir: DATA_DIR,
                defaultDir: DATA_DIR,
                isCustom: false,
                isDefault: true,
                isDevRun: true,
                isPortableRun: false,
                locationFile: ''
            })
        },
        'data:choose-dir': { run: () => ({ canceled: true }) },
        'data:reset-dir': { run: () => ({ canceled: true }) },
        'data:open-dir': { run: () => WEB_ONLY_MESSAGE },
        'system:get-accent-color-sync': { sync: true, run: () => '' },
        'app:open-external': {
            run: (payload) => {
                const links = { serverRepo: 'https://github.com/EsprinProject/Sync' };
                const target = links[String(payload || '')] || '';
                if (target) window.open(target, '_blank', 'noopener');
                return !!target;
            }
        },
        'app:get-auto-launch': { run: () => ({ supported: false, enabled: false, error: DESKTOP_ONLY }) },
        'app:set-auto-launch': { run: () => ({ supported: false, enabled: false, error: DESKTOP_ONLY }) },
        'fonts:list': {
            run: async () => {
                if (typeof window.queryLocalFonts !== 'function') return [];
                try {
                    const fonts = await window.queryLocalFonts();
                    return Array.from(new Set(fonts.map((font) => font.family))).sort();
                } catch (error) {
                    log('WARN', `本机字体枚举失败 (detail=${error && error.message})`);
                    return [];
                }
            }
        },
        'dialog:message': { run: (payload) => showBrowserDialog(payload) },
        'notes:pick-import': { run: () => pickFiles({ multiple: true, accept: '.md,.markdown,.txt' }) },
        'assets:pick-files': { run: () => pickFiles({ multiple: true, accept: 'image/*' }) },
        'assets:open-file': {
            run: (payload) => {
                const target = payload && payload.path ? vfs.normalizePath(payload.path) : '';
                if (!target || !vfs.existsSync(target)) return { ok: false, error: '文件不存在' };
                const bytes = vfs.readFileSync(target);
                const url = URL.createObjectURL(new Blob([bytes]));
                window.open(url, '_blank', 'noopener');
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                return { ok: true };
            }
        },
        'fm:save-file': {
            run: (payload) => {
                const itemId = String((payload && payload.itemId) || '');
                const name = String((payload && payload.filename) || `${itemId}.md`);
                const candidates = ['notes', 'todos', 'items'].map((kind) => path.join(DATA_DIR, kind, `${itemId}.md`));
                const target = candidates.find((item) => vfs.existsSync(item));
                if (!target) return { ok: false, error: '未找到条目文件' };
                downloadFile(name, vfs.readFileSync(target), 'text/markdown;charset=utf-8');
                return { ok: true };
            }
        },
        'fm:open-folder': { run: () => ({ ok: false, error: DESKTOP_ONLY }) },
        'window:toggle-fullscreen': {
            run: () => {
                if (document.fullscreenElement) document.exitFullscreen();
                else document.documentElement.requestFullscreen().catch(() => {});
                return !!document.fullscreenElement;
            }
        },
        'window:minimize': { run: () => undefined },
        'window:maximize': { run: () => undefined },
        'window:close': { run: () => undefined },
        'window:ui-scale': {
            run: (payload) => {
                const scale = Number(payload && payload.scale);
                if (Number.isFinite(scale) && scale > 0) document.documentElement.style.zoom = String(scale);
                return undefined;
            }
        },
        'tray:get-state': { run: () => ({ enabled: false }) },
        'tray:set-enabled': { run: () => ({ enabled: false, error: DESKTOP_ONLY }) },
        'scratchpad:toggle': { run: () => false },
        'scratchpad:load': { run: () => ({}) },
        'scratchpad:persist': { run: () => ({ ok: false, error: DESKTOP_ONLY }) },
        'sticky:list': { run: () => noopIcon() },
        'sticky:create': { run: () => ({ ok: false, reason: 'disabled' }) },
        'sticky:set-enabled': { run: () => ({ ok: true, enabled: false, count: 0 }) },
        'sticky:hide-all': { run: () => ({ ok: true, count: 0 }) },
        'sticky:show-all': { run: () => ({ ok: true, count: 0 }) },
        'sticky:clear-all': { run: () => ({ ok: true, count: 0 }) },
        'speech:status': { run: () => ({ supported: false, reason: DESKTOP_ONLY, languages: [] }) },
        'speech:start': { run: () => ({ ok: false, code: 'Unsupported', message: DESKTOP_ONLY }) },
        'speech:stop': { run: () => ({ ok: true, stopped: false }) },
        'update:get-info': { run: () => ({ ...updateSnapshotStub }) },
        'update:set-auto': { run: () => ({ ...updateSnapshotStub }) },
        'update:check': { run: () => ({ ...updateSnapshotStub }) },
        'update:download': { run: () => ({ ok: false, error: DESKTOP_ONLY }) },
        'update:cancel-download': { run: () => ({ ...updateSnapshotStub }) },
        'update:install': { run: () => ({ ok: false, error: DESKTOP_ONLY }) },
        'update:set-gh-proxy': { run: () => ({ ...updateSnapshotStub }) },
        'update:open-release': {
            run: () => {
                window.open('https://github.com/EsprinProject/Nemo/releases', '_blank', 'noopener');
                return true;
            }
        },
        'update:open-repo': {
            run: () => {
                window.open('https://github.com/EsprinProject/Nemo', '_blank', 'noopener');
                return true;
            }
        },
        'update:open-file': { run: () => false },
        'sync:status': { run: () => ({ ...syncStatusStub, lastError: '网页模式暂未接入同步' }) },
        'sync:test': { run: () => ({ ok: false, error: '网页模式暂未接入同步' }) },
        'sync:login': { run: () => ({ ok: false, error: '网页模式暂未接入同步' }) },
        'sync:set-token': { run: () => ({ ok: false, error: '网页模式暂未接入同步' }) },
        'sync:token-status': { run: () => ({ hasToken: false, strong: false, encrypted: false }) },
        'sync:clear-token': { run: () => ({ ok: true, hasToken: false, strong: false, encrypted: false }) },
        'sync:now': { run: () => ({ ok: false, error: '网页模式暂未接入同步' }) },
        'sync:claim-ids': { run: () => ({ ok: true, ids: [], pending: 0 }) },
        'sync:import-local': { run: () => ({ ok: false, error: '网页模式暂未接入同步' }) },
        'sync:diagnose': { run: () => ({ ok: true, path: '', text: '网页模式暂未接入同步' }) },
        'sync:shares': { run: () => ({ ok: true, user: null, incoming: [], received: [], outgoing: [] }) },
        'sync:apply-auto-sync': { run: () => ({ ...syncStatusStub }) },
        'sync:share-request': { run: () => ({ ok: false, error: '网页模式暂未接入同步' }) },
        'sync:share-respond': { run: () => ({ ok: false, error: '网页模式暂未接入同步' }) },
        'sync:share-revoke': { run: () => ({ ok: false, error: '网页模式暂未接入同步' }) },
        'sync:share-leave': { run: () => ({ ok: false, error: '网页模式暂未接入同步' }) },
        'ai:key-status-sync': {
            sync: true,
            run: () => ({ hasKey: false, encrypted: false, strong: false, path: '', migrated: false })
        },
        'ai:set-key-sync': { sync: true, run: () => ({ ok: false, error: '网页模式暂未接入 AI 助手' }) },
        'ai:key-status': {
            run: () => ({ hasKey: false, encrypted: false, strong: false, path: '', migrated: false })
        },
        'ai:set-key': { run: () => ({ ok: false, error: '网页模式暂未接入 AI 助手' }) },
        'ai:test': { run: () => ({ ok: false, error: '网页模式暂未接入 AI 助手' }) },
        'ai:models': { run: () => ({ ok: false, error: '网页模式暂未接入 AI 助手' }) },
        'ai:chat': { run: () => ({ ok: false, error: '网页模式暂未接入 AI 助手' }) },
        'ai:abort': { run: () => ({ ok: false }) },
        'ai:pick-attachments': { run: () => pickFiles({ multiple: true, accept: 'image/*,.txt,.md,.json,.csv' }) },
        'ai:import-attachments': { run: () => ({ attachments: [], errors: ['网页模式暂未接入 AI 助手'] }) },
        'ai:delete-attachments': {
            run: (payload) => {
                const files = (payload && payload.files) || [];
                let deleted = 0;
                files.forEach((name) => {
                    const target = path.join(DATA_DIR, 'ai_files', String(name));
                    if (!vfs.existsSync(target)) return;
                    try {
                        vfs.unlinkSync(target);
                        deleted += 1;
                    } catch (error) {
                        log('WARN', `附件删除失败 (path=${target})`);
                    }
                });
                return { deleted };
            }
        }
    };

    const WEB_ONLY_MESSAGE = '网页模式下数据保存在浏览器本地存储中，没有可打开的文件夹';

    const journalUnsupported = '网页模式暂未接入日志导入导出';
    ['journal:pick-folder', 'journal:inspect', 'journal:import-file', 'journal:export-folder'].forEach((channel) => {
        handlers[channel] = { run: () => ({ ok: false, error: journalUnsupported }) };
    });
    handlers['journal:pick-file'] = { run: () => ({ ...(pickFiles({ multiple: false, accept: '.json,.txt,.log' })), ok: false, error: journalUnsupported }) };

    const stickyNoop = ['sticky:save', 'sticky:set-color', 'sticky:close', 'sticky:resolve', 'sticky:toggle-done'];
    stickyNoop.forEach((channel) => {
        handlers[channel] = { run: () => ({ ok: false, reason: 'disabled' }) };
    });

    const silentSend = [
        'sync:push', 'sync:remove', 'scratchpad:appearance', 'scratchpad:reply', 'scratchpad:flush',
        'scratchpad:bind', 'scratchpad:unbind', 'scratchpad:drag-move', 'scratchpad:drag-end',
        'sticky:flush', 'sticky:keep-bottom', 'sticky:raise', 'sticky:item-changed', 'sticky:appearance'
    ];
    silentSend.forEach((channel) => {
        handlers[channel] = { send: true, run: () => undefined };
    });

    const MAIN_CHANNELS = [
        'sync:status', 'sync:test', 'sync:login', 'sync:set-token', 'sync:token-status', 'sync:clear-token',
        'sync:now', 'sync:claim-ids', 'sync:import-local', 'sync:diagnose', 'sync:shares', 'sync:apply-auto-sync',
        'sync:share-request', 'sync:share-respond', 'sync:share-revoke', 'sync:share-leave',
        'sync:push', 'sync:remove',
        'journal:pick-file', 'journal:pick-folder', 'journal:inspect', 'journal:import-file', 'journal:export-folder'
    ];

    MAIN_CHANNELS.forEach((channel) => {
        const previous = handlers[channel];
        handlers[channel] = {
            ...(previous || {}),
            run: (payload) => dispatchMain(channel, payload, previous && previous.run)
        };
    });

    function showBrowserDialog(options) {
        const config = options && typeof options === 'object' ? options : {};
        const buttons = Array.isArray(config.buttons) ? config.buttons : [];
        const okButton = buttons.find((button) => !button.cancel) || buttons[0] || { id: 'ok', index: 0 };
        const cancelButton = buttons.find((button) => button.cancel) || null;
        const lines = [config.message || '', config.detail || ''].filter(Boolean).join('\n\n');

        const result = { id: '', index: 0, value: '', selected: [], checked: false, dismissed: false };

        if (config.input && (config.input.value !== undefined || (config.input.choices || []).length === 0)) {
            const answer = window.prompt(`${lines}\n\n${config.input.label || ''}`.trim(), config.input.value || '');
            if (answer === null) {
                result.id = cancelButton ? cancelButton.id : 'cancel';
                result.dismissed = true;
                return result;
            }
            result.id = okButton.id;
            result.index = buttons.indexOf(okButton);
            result.value = answer;
            return result;
        }

        if (cancelButton && buttons.length > 1) {
            if (!window.confirm(lines)) {
                result.id = cancelButton.id;
                result.index = buttons.indexOf(cancelButton);
                result.dismissed = true;
                return result;
            }
        } else {
            window.alert(lines);
        }

        result.id = okButton.id;
        result.index = Math.max(buttons.indexOf(okButton), 0);
        return result;
    }

    const listeners = new Map();

    function emit(channel, payload) {
        const list = listeners.get(channel) || [];
        list.forEach((handler) => {
            try {
                handler({}, payload);
            } catch (error) {
                log('ERROR', `事件处理失败 (channel=${channel} detail=${error && error.message})`);
            }
        });
    }

    const ipcRenderer = {
        async invoke(channel, payload) {
            const entry = handlers[channel];
            if (!entry || entry.send) {
                log('WARN', `未实现的通道 (channel=${channel})`);
                return undefined;
            }
            return entry.run(payload);
        },
        send(channel, payload) {
            const entry = handlers[channel];
            if (!entry) {
                log('WARN', `未实现的通道 (channel=${channel})`);
                return;
            }
            entry.run(payload);
        },
        sendSync(channel, payload) {
            const entry = handlers[channel];
            if (!entry || !entry.sync) {
                log('WARN', `未实现的同步通道 (channel=${channel})`);
                return undefined;
            }
            return entry.run(payload);
        },
        on(channel, handler) {
            if (!listeners.has(channel)) listeners.set(channel, []);
            listeners.get(channel).push(handler);
            return this;
        },
        once(channel, handler) {
            const wrapper = (...args) => {
                this.removeListener(channel, wrapper);
                handler(...args);
            };
            return this.on(channel, wrapper);
        },
        removeListener(channel, handler) {
            const list = listeners.get(channel) || [];
            listeners.set(channel, list.filter((item) => item !== handler));
            return this;
        },
        removeAllListeners(channel) {
            listeners.delete(channel);
            return this;
        }
    };

    const ipcIncoming = new Map();
    const ipcIncomingSend = new Map();

    const ipcMain = {
        handle(channel, handler) {
            ipcIncoming.set(channel, handler);
        },
        handleOnce(channel, handler) {
            ipcIncoming.set(channel, handler);
        },
        removeHandler(channel) {
            ipcIncoming.delete(channel);
        },
        on(channel, handler) {
            if (!ipcIncomingSend.has(channel)) ipcIncomingSend.set(channel, []);
            ipcIncomingSend.get(channel).push(handler);
        },
        once(channel, handler) {
            this.on(channel, handler);
        },
        removeAllListeners(channel) {
            ipcIncomingSend.delete(channel);
        }
    };

    const electronShim = {
        ipcRenderer,
        webFrame: {
            setZoomFactor(value) {
                const scale = Number(value);
                if (Number.isFinite(scale) && scale > 0) document.documentElement.style.zoom = String(scale);
            },
            getZoomFactor() {
                return Number(document.documentElement.style.zoom) || 1;
            }
        },
        clipboard: {
            writeText(text) {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(String(text == null ? '' : text)).catch(() => {});
                }
            },
            readText() {
                return '';
            }
        },
        shell: {
            openExternal(url) {
                window.open(String(url), '_blank', 'noopener');
                return Promise.resolve();
            },
            openPath() {
                return Promise.resolve(WEB_ONLY_MESSAGE);
            }
        },
        systemPreferences: {
            getAccentColor() {
                return '';
            },
            on() {},
            removeListener() {}
        },
        safeStorage: {
            isEncryptionAvailable() {
                return false;
            },
            getSelectedStorageBackend() {
                return 'plain';
            }
        },
        ipcMain,
        webUtils: {
            getPathForFile(file) {
                const target = virtualPathFor(file);
                if (!target) return '';
                const buffer = new Uint8Array(0);
                virtualPending.push({ path: target, file });
                return target;
            }
        },
        app: {
            getPath(name) {
                return String(name) === 'appData' ? APP_DATA_DIR : CONFIG_DIR;
            },
            getVersion() {
                return appVersion();
            },
            isPackaged: false,
            on() {}
        },
        dialog: {
            showOpenDialog() {
                return Promise.resolve({ canceled: true, filePaths: [] });
            },
            showSaveDialog() {
                return Promise.resolve({ canceled: true, filePath: '' });
            },
            showMessageBox() {
                return Promise.resolve({ response: 0 });
            }
        },
        BrowserWindow: {
            fromWebContents() {
                return null;
            }
        }
    };

    const virtualPending = [];

    async function flushPendingVirtualFiles() {
        while (virtualPending.length) {
            const item = virtualPending.shift();
            try {
                const buffer = await item.file.arrayBuffer();
                vfs.writeFileSync(item.path, new Uint8Array(buffer));
            } catch (error) {
                log('WARN', `拖放文件写入失败 (path=${item.path} detail=${error && error.message})`);
            }
        }
    }

    const MODULES = {
        fs: {
            existsSync: (target) => vfs.existsSync(target),
            readFileSync: (target, encoding) => vfs.readFileSync(target, encoding),
            writeFileSync: (target, data) => vfs.writeFileSync(target, data),
            copyFileSync: (from, to) => vfs.copyFileSync(from, to),
            renameSync: (from, to) => vfs.renameSync(from, to),
            unlinkSync: (target) => vfs.unlinkSync(target),
            mkdirSync: (target) => vfs.mkdirSync(target),
            rmdirSync: (target) => vfs.unlinkSync(target),
            readdirSync: (target, options) => vfs.readdirSync(target, options),
            statSync: (target) => vfs.statSync(target),
            lstatSync: (target) => vfs.statSync(target),
            promises: {}
        },
        path,
        url: {
            pathToFileURL(target) {
                return new URL(`file://${path.resolve(target)}`);
            },
            fileURLToPath(target) {
                return path.resolve(typeof target === 'string' ? target.replace(/^file:\/\//, '') : target.pathname);
            }
        },
        'node:crypto': cryptoShim,
        crypto: cryptoShim,
        buffer: { Buffer: BufferPolyfill },
        electron: electronShim
    };

    const requireShim = function require(id) {
        const key = String(id).replace(/^node:/, '');
        if (key === 'electron') return electronShim;
        if (key === 'fs') return MODULES.fs;
        if (key === 'path') return MODULES.path;
        if (key === 'url') return MODULES.url;
        if (key === 'crypto') return cryptoShim;
        if (key === 'buffer') return MODULES.buffer;
        if (key === 'os') return { homedir: () => '/', tmpdir: () => '/tmp', platform: () => 'browser' };
        throw new Error(`网页模式不提供模块：${id}`);
    };

    window.require = requireShim;
    window.module = { exports: {} };
    window.exports = window.module.exports;
    window.Buffer = BufferPolyfill;
    window.process = {
        argv: [],
        env: { WEB_MODE: '1' },
        platform: 'browser',
        versions: { web: '1' },
        cwd: () => '/',
        nextTick: (fn) => setTimeout(fn, 0),
        on: () => {}
    };
    window.global = window;
    window.__esprinWebHost = { vfs, flushPendingVirtualFiles, DATA_DIR, CONFIG_DIR };

    function setupWebMode() {
        const root = document.documentElement;
        root.classList.add(WEB_MODE_CLASS);

        const title = document.querySelector('title');
        if (title && !/\sWeb$/.test(title.textContent)) title.textContent = `${title.textContent} Web`;
    }

    function refreshApp() {
        if (typeof window.renderApp !== 'function') return;
        try {
            window.renderApp();
        } catch (error) {
            log('WARN', `合并浏览器数据库后重绘界面失败 (detail=${error && error.message})`);
        }
    }

    const moduleCache = new Map();
    let syncReady = false;

    function normalizeModulePath(value) {
        const stack = [];
        String(value || '').split('/').forEach((part) => {
            if (!part || part === '.') return;
            if (part === '..') {
                stack.pop();
                return;
            }
            stack.push(part);
        });
        return stack.join('/');
    }

    async function loadModuleSource(relative) {
        const inline = window.__esprinSources;
        if (inline && typeof inline[relative] === 'string') return inline[relative];
        const response = await fetch(`/${relative}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`无法读取模块源码 ${relative}（HTTP ${response.status}）`);
        return response.text();
    }

    async function loadModule(relative) {
        const key = normalizeModulePath(relative);
        if (moduleCache.has(key)) return moduleCache.get(key);

        const source = await loadModuleSource(key);
        const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
        const module = { exports: {} };

        const localRequire = (id) => {
            const name = String(id).replace(/^node:/, '');
            if (!name.startsWith('.')) return requireShim(name);
            const resolved = normalizeModulePath(`${dir}/${name}`);
            if (!moduleCache.has(resolved)) throw new Error(`模块依赖尚未加载 (target=${resolved})`);
            return moduleCache.get(resolved);
        };

        const factory = new Function('require', 'module', 'exports', '__dirname', '__filename', source);
        factory(localRequire, module, module.exports, `/${dir}`, `/${key}`);
        moduleCache.set(key, module.exports);
        return module.exports;
    }

    function readUserConfig() {
        try {
            const parsed = JSON.parse(vfs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    let hostedBase = '';
    let hostedReachable = false;

    function probeSyncServer() {
        if (!/^https?:$/i.test(window.location.protocol)) return false;
        try {
            const request = new XMLHttpRequest();
            request.open('GET', '/sync/health', false);
            request.setRequestHeader('Accept', 'application/json');
            request.send();
            if (request.status !== 200) return false;
            const info = JSON.parse(request.responseText || '{}');
            return !!(info && info.ok === true && typeof info.syncPath === 'string');
        } catch (error) {
            return false;
        }
    }

    function registerOfflineCache() {
        if (!('serviceWorker' in navigator)) return;
        if (!/^https?:$/i.test(window.location.protocol)) return;
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => {
            log('INFO', '已登记离线缓存：设备断网或服务端暂时不可用时，本页仍可打开');
        }).catch((error) => {
            log('WARN', `离线缓存登记失败 (detail=${error && error.message})`);
        });
    }

    let syncPrefilled = false;

    function prefillSyncAddress() {
        const origin = window.location.origin;
        const reachable = probeSyncServer();
        const config = readUserConfig();
        const current = config.syncServer && typeof config.syncServer === 'object' ? config.syncServer : {};
        const remembered = !!origin && String(current.url || '').trim() === origin;

        if (!reachable && !remembered) {
            log('INFO', '本页不由 EsprinSync 托管，按本地模式运行（要同步请在设置里自行填写服务器地址）');
            return false;
        }

        hostedBase = origin;
        hostedReachable = reachable;
        document.documentElement.classList.add('hosted-sync');

        if (!reachable) {
            log('INFO', `服务端暂时联系不上，先用浏览器里的副本离线运行 (base=${origin})`);
            return false;
        }

        log('INFO', `本页由 EsprinSync 托管 (base=${origin})`);
        if (remembered && current.enabled === true) return false;

        const next = { ...config, syncServer: { ...current, url: origin, enabled: true } };
        try {
            vfs.writeFileSync(path.join(DATA_DIR, 'config.json'), `${JSON.stringify(next, null, 2)}\n`);
            log('INFO', `已把托管地址填为 ${origin} 并开启自建同步`);
            return true;
        } catch (error) {
            log('WARN', `写入同步配置失败 (detail=${error && error.message})`);
            return false;
        }
    }

    let gateHost = null;
    let gateTokenMode = false;

    function ensureGateHost() {
        if (gateHost) return gateHost;

        const mask = document.createElement('div');
        mask.className = 'web-sync-gate hidden';
        mask.id = 'web-sync-gate';

        const card = document.createElement('div');
        card.className = 'web-sync-gate-card';

        const title = document.createElement('div');
        title.className = 'web-sync-gate-title';
        title.textContent = '登录到 EsprinSync';

        const desc = document.createElement('div');
        desc.className = 'web-sync-gate-desc';
        desc.textContent = '笔记与待办保存在托管本页的 EsprinSync 上，本地只留一份用于离线阅读的副本。用服务端上的账户登录后即可读写。';

        const accountLabel = document.createElement('label');
        accountLabel.className = 'web-sync-gate-field';
        const accountCaption = document.createElement('span');
        accountCaption.textContent = '账户名';
        const accountInput = document.createElement('input');
        accountInput.type = 'text';
        accountInput.id = 'web-sync-gate-account';
        accountInput.value = 'admin';
        accountInput.autocomplete = 'username';
        accountLabel.append(accountCaption, accountInput);

        const passwordLabel = document.createElement('label');
        passwordLabel.className = 'web-sync-gate-field';
        const passwordCaption = document.createElement('span');
        passwordCaption.textContent = '密码';
        const passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.id = 'web-sync-gate-password';
        passwordInput.autocomplete = 'current-password';
        passwordLabel.append(passwordCaption, passwordInput);

        const tokenLabel = document.createElement('label');
        tokenLabel.className = 'web-sync-gate-field hidden';
        const tokenCaption = document.createElement('span');
        tokenCaption.textContent = '访问令牌';
        const tokenInput = document.createElement('input');
        tokenInput.type = 'text';
        tokenInput.id = 'web-sync-gate-token';
        tokenInput.autocomplete = 'off';
        tokenLabel.append(tokenCaption, tokenInput);

        const message = document.createElement('div');
        message.className = 'web-sync-gate-msg';
        message.id = 'web-sync-gate-msg';

        const actions = document.createElement('div');
        actions.className = 'web-sync-gate-actions';

        const submit = document.createElement('button');
        submit.className = 'web-sync-gate-submit';
        submit.id = 'web-sync-gate-submit';
        submit.type = 'button';
        submit.textContent = '登录';

        const modeButton = document.createElement('button');
        modeButton.className = 'web-sync-gate-mode';
        modeButton.type = 'button';
        modeButton.textContent = '改用访问令牌';
        modeButton.addEventListener('click', () => {
            gateTokenMode = !gateTokenMode;
            tokenLabel.classList.toggle('hidden', !gateTokenMode);
            accountLabel.classList.toggle('hidden', gateTokenMode);
            passwordLabel.classList.toggle('hidden', gateTokenMode);
            submit.textContent = gateTokenMode ? '连接' : '登录';
            modeButton.textContent = gateTokenMode ? '改用账户密码' : '改用访问令牌';
            const field = gateTokenMode ? tokenInput : (accountInput.value ? passwordInput : accountInput);
            field.focus();
        });

        const hint = document.createElement('div');
        hint.className = 'web-sync-gate-hint';
        hint.textContent = '账户在服务端的 /admin 管理页创建；也可以在管理页生成访问令牌，再用令牌直接连接。登录成功后本机会保存一份令牌，之后打开本页无需重复登录。';

        actions.append(submit, modeButton);
        card.append(title, desc, accountLabel, passwordLabel, tokenLabel, message, actions, hint);
        mask.appendChild(card);
        document.body.appendChild(mask);

        submit.addEventListener('click', () => { submitWebSyncGate(); });
        mask.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') submitWebSyncGate();
        });

        gateHost = {
            mask,
            message,
            submit,
            accountInput,
            passwordInput,
            tokenInput
        };
        return gateHost;
    }

    function setGateMessage(text, isError) {
        const host = ensureGateHost();
        host.message.textContent = text || '';
        host.message.classList.toggle('error', !!isError);
    }

    function showWebSyncGate(message) {
        const host = ensureGateHost();
        host.mask.classList.remove('hidden');
        setGateMessage(message, !!message);
        setTimeout(() => {
            const field = gateTokenMode
                ? host.tokenInput
                : (host.accountInput.value ? host.passwordInput : host.accountInput);
            field.focus();
        }, 30);
    }

    function hideWebSyncGate() {
        if (!gateHost) return;
        gateHost.mask.classList.add('hidden');
        setGateMessage('', false);
    }

    async function submitWebSyncGate() {
        const host = ensureGateHost();
        const account = host.accountInput.value.trim() || 'admin';
        const password = host.passwordInput.value;
        const token = host.tokenInput.value.trim();

        if (gateTokenMode ? !token : !password) {
            setGateMessage(gateTokenMode ? '连接失败：请填写访问令牌' : '登录失败：请填写账户密码', true);
            return;
        }

        host.submit.disabled = true;
        setGateMessage('正在连接服务端…', false);

        try {
            const entered = gateTokenMode
                ? await dispatchMain('sync:set-token', { token }, () => null)
                : await dispatchMain('sync:login', { account, password }, () => null);

            if (!entered || entered.ok === false) {
                setGateMessage((entered && entered.error) || '登录失败：同步模块不可用', true);
                return;
            }

            setGateMessage('正在同步…', false);
            const synced = await dispatchMain('sync:now', null, () => null);
            if (!synced || synced.ok === false) {
                setGateMessage((synced && synced.error) || '同步失败', true);
                return;
            }

            host.passwordInput.value = '';
            host.tokenInput.value = '';
            hideWebSyncGate();
            refreshApp();
            log('INFO', `已登录并完成首次同步 (summary=${synced.summary || '同步完成'})`);
        } finally {
            host.submit.disabled = false;
        }
    }

    async function ensureWebSyncSession() {
        if (!syncReady) return;

        const status = await dispatchMain('sync:status', null, () => null);
        if (!status || status.enabled !== true) return;

        if (!status.hasToken) {
            if (!hostedReachable) {
                log('INFO', '离线运行：本机还没有令牌，等接上服务端后再登录');
                return;
            }
            log('INFO', '本页由 EsprinSync 托管，需要登录后才能读写');
            showWebSyncGate('');
            return;
        }

        const result = await dispatchMain('sync:now', null, () => null);
        if (result && result.ok) {
            log('INFO', `已用本机保存的令牌完成同步 (summary=${result.summary || '同步完成'})`);
            refreshApp();
            return;
        }

        const detail = (result && result.error) || '';
        if (/令牌|凭据|登录/.test(detail)) {
            showWebSyncGate(detail);
            return;
        }
        log('WARN', `启动同步未成功 (detail=${detail || '未知原因'})`);
    }

    async function startSyncEngine() {
        try {
            await loadModule('src/main/data_path.js');
            await loadModule('src/main/secret_store.js');
            const sync = await loadModule('src/main/sync_server.js');
            sync.configureSyncServer({
                getDataDir: () => DATA_DIR,
                getConfig: readUserConfig,
                onRendererMessage: (channel, payload) => emit(channel, payload)
            });
            sync.registerSyncIpc();
            syncReady = true;
            log('INFO', '已接入自建同步：与桌面端同一套同步逻辑，本页直接读写服务端的操作日志');
        } catch (error) {
            log('WARN', `未能接入自建同步，本页只能本地使用 (detail=${error && error.message})`);
        }
    }

    async function dispatchMain(channel, payload, fallback) {
        if (syncReady) {
            const handler = ipcIncoming.get(channel);
            if (handler) {
                try {
                    return await handler({ sender: null }, payload);
                } catch (error) {
                    log('ERROR', `同步通道失败 (channel=${channel} detail=${error && error.message})`);
                    return { ok: false, error: String((error && error.message) || error) };
                }
            }
            const listeners = ipcIncomingSend.get(channel);
            if (listeners && listeners.length) {
                listeners.forEach((listener) => {
                    try {
                        listener({ sender: null }, payload);
                    } catch (error) {
                        log('ERROR', `同步事件处理失败 (channel=${channel} detail=${error && error.message})`);
                    }
                });
                return undefined;
            }
        }
        return fallback ? fallback(payload) : { ok: false, error: '网页模式暂未接入同步' };
    }

    async function startHost() {
        setupWebMode();
        flushPendingVirtualFiles();
        registerOfflineCache();
        const merged = await vfs.open();
        if (merged || syncPrefilled) refreshApp();
        await startSyncEngine();
        await ensureWebSyncSession();
        log('INFO', `浏览器宿主就绪 (dataDir=${DATA_DIR} backend=${vfs.backend()})`);
    }

    window.addEventListener('online', () => {
        if (!hostedBase) return;
        hostedReachable = true;
        log('INFO', '网络已恢复，尝试接回服务端');
        ensureWebSyncSession().catch(() => {});
    });

    window.addEventListener('pagehide', () => {
        vfs.flush();
    });

    syncPrefilled = prefillSyncAddress();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startHost);
    } else {
        startHost();
    }
})();
