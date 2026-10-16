'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
    JOURNAL_NAME,
    JOURNAL_ID_NAME,
    MAX_DATA_CHARS,
    RECYCLE_HOLD_SECONDS,
    RECYCLE_CLAIM_MAX,
    RECYCLE_POOL_LIMIT,
    ITEM_PATH_PATTERN,
    nowMs,
    sha256Text,
    normalizeRelativePath,
    ensureDir
} = require('./lib.js');

class Journal {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.path = path.join(dataDir, JOURNAL_NAME);
        this.latestSeq = 0;
        this.opIds = new Map();
        this.files = new Map();
        this.deleted = new Map();
        this.deletedBy = new Map();
        this.holds = new Map();
        this.count = 0;
        this.load();
        this.journalId = this.loadOrCreateId();
    }

    loadOrCreateId() {
        const target = path.join(this.dataDir, JOURNAL_ID_NAME);
        try {
            const value = fs.readFileSync(target, 'utf8').trim();
            if (value) return value;
        } catch (error) {
            void error;
        }

        const value = crypto.randomUUID().replace(/-/g, '');
        try {
            fs.writeFileSync(target, value, 'utf8');
        } catch (error) {
            void error;
        }
        return value;
    }

    load() {
        ensureDir(this.dataDir);
        if (!fs.existsSync(this.path)) return;
        let raw = '';
        try {
            raw = fs.readFileSync(this.path, 'utf8');
        } catch (error) {
            return;
        }
        for (const line of raw.split('\n')) {
            const text = line.trim();
            if (!text) continue;
            let entry = null;
            try {
                entry = JSON.parse(text);
            } catch (error) {
                continue;
            }
            this.index(entry);
        }
    }

    index(entry) {
        const seq = Number.parseInt(entry.seq, 10) || 0;
        if (seq <= 0) return;
        this.latestSeq = Math.max(this.latestSeq, seq);
        this.count += 1;

        const opId = entry.opId;
        if (opId) this.opIds.set(String(opId), seq);
        for (const purged of entry.purged || []) {
            if (purged && !this.opIds.has(String(purged))) this.opIds.set(String(purged), seq);
        }

        const filePath = entry.path;
        if (!filePath) return;
        if (entry.op === 'del') {
            this.files.delete(filePath);
            this.deleted.set(filePath, seq);
            this.deletedBy.set(filePath, String(entry.device || ''));
            return;
        }
        this.files.set(filePath, { hash: entry.hash || '', seq, device: entry.device || '' });
        this.deleted.delete(filePath);
        this.deletedBy.delete(filePath);
        this.holds.delete(filePath);
    }

    appendMany(device, ops) {
        const accepted = [];
        let handle = null;
        try {
            handle = fs.openSync(this.path, 'a');
            for (const raw of ops) {
                const opId = String((raw && raw.opId) || '');
                if (opId && this.opIds.has(opId)) {
                    accepted.push({ opId, seq: this.opIds.get(opId), duplicate: true });
                    continue;
                }

                const kind = raw && raw.op;
                if (kind !== 'put' && kind !== 'del') {
                    accepted.push({ opId, seq: 0, error: '未知操作类型' });
                    continue;
                }

                const filePath = normalizeRelativePath(raw.path);
                if (!filePath) {
                    accepted.push({ opId, seq: 0, error: '路径不合法' });
                    continue;
                }

                const entry = {
                    seq: this.latestSeq + 1,
                    opId,
                    device: String(raw.device || device || ''),
                    time: Number.parseInt(raw.time, 10) || nowMs(),
                    op: kind,
                    path: filePath
                };

                if (kind === 'put') {
                    const data = raw.data;
                    if (typeof data !== 'string') {
                        accepted.push({ opId, seq: 0, error: 'put 缺少内容' });
                        continue;
                    }
                    if (data.length > MAX_DATA_CHARS) {
                        accepted.push({ opId, seq: 0, error: '内容过大' });
                        continue;
                    }
                    entry.data = data;
                    entry.encoding = raw.encoding === 'base64' ? 'base64' : 'utf8';
                    entry.hash = raw.hash || (entry.encoding === 'utf8' ? sha256Text(data) : '');
                } else {
                    entry.hash = raw.hash || '';
                }

                fs.writeSync(handle, `${JSON.stringify(entry)}\n`);
                fs.fsyncSync(handle);

                this.index(entry);
                accepted.push({ opId, seq: entry.seq });
            }
        } catch (error) {
            return accepted.length ? accepted : [{ opId: '', seq: 0, error: `写入失败：${error.message}` }];
        } finally {
            if (handle !== null) {
                try {
                    fs.closeSync(handle);
                } catch (error) {
                    void error;
                }
            }
        }
        return accepted;
    }

    readOps(since, limit) {
        if (!fs.existsSync(this.path)) return [];
        let raw = '';
        try {
            raw = fs.readFileSync(this.path, 'utf8');
        } catch (error) {
            return [];
        }
        const result = [];
        for (const line of raw.split('\n')) {
            const text = line.trim();
            if (!text) continue;
            let entry = null;
            try {
                entry = JSON.parse(text);
            } catch (error) {
                continue;
            }
            const seq = Number.parseInt(entry.seq, 10) || 0;
            if (seq <= since) continue;
            result.push(entry);
            if (result.length >= limit) break;
        }
        return result;
    }

    readFile(filePath) {
        if (!fs.existsSync(this.path)) return null;
        let raw = '';
        try {
            raw = fs.readFileSync(this.path, 'utf8');
        } catch (error) {
            return null;
        }
        let latest = null;
        for (const line of raw.split('\n')) {
            const text = line.trim();
            if (!text) continue;
            let entry = null;
            try {
                entry = JSON.parse(text);
            } catch (error) {
                continue;
            }
            if (entry.path !== filePath) continue;
            latest = entry;
        }
        if (!latest || latest.op !== 'put') return null;
        return latest;
    }

    recyclableNow() {
        const now = nowMs();
        const pool = [];
        for (const [filePath, seq] of this.deleted) {
            if (this.files.has(filePath)) continue;
            const matched = ITEM_PATH_PATTERN.exec(filePath);
            if (!matched) continue;
            const hold = this.holds.get(filePath);
            if (hold) {
                if (now < Number(hold.until || 0)) continue;
                this.holds.delete(filePath);
            }
            pool.push({
                id: matched[2],
                kind: matched[1],
                path: filePath,
                seq,
                device: this.deletedBy.get(filePath) || ''
            });
        }
        pool.sort((left, right) => right.seq - left.seq);
        return pool;
    }

    recyclable(limit = RECYCLE_POOL_LIMIT) {
        return this.recyclableNow().slice(0, Math.max(0, Number.parseInt(limit, 10) || 0));
    }

    compact(paths) {
        let wanted = null;
        if (paths) {
            wanted = new Set();
            for (const item of paths) {
                const value = normalizeRelativePath(item);
                if (value) wanted.add(value);
            }
        }

        if (!fs.existsSync(this.path)) return { removed: 0, kept: 0, paths: 0 };

        let raw = '';
        try {
            raw = fs.readFileSync(this.path, 'utf8');
        } catch (error) {
            return { removed: 0, kept: 0, paths: 0 };
        }

        const entries = [];
        for (const line of raw.split('\n')) {
            const text = line.trim();
            if (!text) continue;
            let entry = null;
            try {
                entry = JSON.parse(text);
            } catch (error) {
                entry = null;
            }
            entries.push({ entry, line: text });
        }

        const lastOp = new Map();
        const lastIndex = new Map();
        entries.forEach((item, index) => {
            const filePath = item.entry ? item.entry.path : null;
            if (!filePath) return;
            lastOp.set(filePath, item.entry.op);
            lastIndex.set(filePath, index);
        });

        const removable = new Set();
        for (const [filePath, op] of lastOp) {
            if (op !== 'del') continue;
            if (wanted && !wanted.has(filePath)) continue;
            removable.add(filePath);
        }

        const markers = new Set();
        for (const filePath of removable) markers.add(lastIndex.get(filePath));

        const purged = new Map();
        entries.forEach((item, index) => {
            if (!item.entry) return;
            const filePath = item.entry.path;
            if (!removable.has(filePath)) return;
            if (markers.has(index)) {
                for (const opId of item.entry.purged || []) {
                    if (!purged.has(filePath)) purged.set(filePath, new Set());
                    purged.get(filePath).add(String(opId));
                }
                return;
            }
            if (item.entry.opId) {
                if (!purged.has(filePath)) purged.set(filePath, new Set());
                purged.get(filePath).add(String(item.entry.opId));
            }
            for (const opId of item.entry.purged || []) {
                if (!purged.has(filePath)) purged.set(filePath, new Set());
                purged.get(filePath).add(String(opId));
            }
        });

        const kept = [];
        entries.forEach((item, index) => {
            if (item.entry && !markers.has(index) && removable.has(item.entry.path)) return;
            if (item.entry && markers.has(index) && purged.has(item.entry.path)) {
                const marker = { ...item.entry, purged: Array.from(purged.get(item.entry.path)).sort() };
                kept.push({ entry: marker, line: JSON.stringify(marker) });
                return;
            }
            kept.push(item);
        });

        const removed = entries.length - kept.length;
        if (removed) {
            const temp = `${this.path}.tmp`;
            const body = kept.map((item) => `${item.line}\n`).join('');
            try {
                const handle = fs.openSync(temp, 'w');
                fs.writeSync(handle, body);
                fs.fsyncSync(handle);
                fs.closeSync(handle);
                fs.renameSync(temp, this.path);
            } catch (error) {
                return { removed: 0, kept: entries.length, paths: 0 };
            }
            this.rebuild(kept);
        }
        return { removed, kept: kept.length, paths: removable.size };
    }

    rebuild(kept) {
        this.latestSeq = 0;
        this.opIds = new Map();
        this.files = new Map();
        this.deleted = new Map();
        this.deletedBy = new Map();
        this.count = 0;
        for (const item of kept) {
            if (item.entry) this.index(item.entry);
        }
    }

    claimRecyclable(device, kind = '', count = 1, since = null) {
        const wanted = Math.max(1, Math.min(Number.parseInt(count, 10) || 1, RECYCLE_CLAIM_MAX));
        const owner = String(device || '');
        let pool = this.recyclableNow();

        if (kind) {
            const sameKind = pool.filter((item) => item.kind === kind);
            if (sameKind.length) pool = sameKind;
        }

        const ready = since === null || since === undefined
            ? pool
            : pool.filter((item) => item.seq <= Number(since) || (owner && item.device === owner));

        const picked = ready.slice(0, wanted);
        const until = nowMs() + RECYCLE_HOLD_SECONDS * 1000;
        for (const item of picked) this.holds.set(item.path, { device: owner, until });
        return { picked, pending: pool.length - picked.length };
    }

    state() {
        return {
            latestSeq: this.latestSeq,
            count: this.count,
            files: Object.fromEntries(this.files),
            deleted: Object.fromEntries(this.deleted),
            recyclable: this.recyclableNow().length
        };
    }

    summary() {
        const exists = fs.existsSync(this.path);
        let size = 0;
        let updatedAt = 0;
        if (exists) {
            try {
                const info = fs.statSync(this.path);
                size = Number(info.size) || 0;
                updatedAt = Math.round(info.mtimeMs) || 0;
            } catch (error) {
                size = 0;
                updatedAt = 0;
            }
        }
        return {
            journalId: this.journalId,
            latestSeq: this.latestSeq,
            ops: this.count,
            files: this.files.size,
            deleted: this.deleted.size,
            recyclable: this.recyclableNow().length,
            size,
            updatedAt,
            exists
        };
    }
}

module.exports = { Journal };
