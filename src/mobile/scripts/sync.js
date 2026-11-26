import {
    readRecord, writeRecord, deleteRecord, readOutbox, writeOutbox, mergeOutboxOp, onFileChange
} from './store.js';

const SYNC_PATH = '/sync';
const ADMIN_API_PATH = '/admin/api';
const PAGE_LIMIT = 500;
const MAX_OPS_PER_PUSH = 200;
const PUSH_DEBOUNCE_MS = 800;
const REQUEST_TIMEOUT_MS = 15000;
const PUSH_TIMEOUT_MS = 60000;

let settings = null;
let persist = async () => {};
let notifyChange = () => {};

let pushTimer = null;
let running = false;
let opCounter = 0;
let unsubscribe = null;

const b64ToBytes = (text) => {
    const binary = atob(String(text || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

function bytesToHex(bytes) {
    return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function hashRecord(record) {
    const bytes = record.enc === 'base64'
        ? b64ToBytes(record.data)
        : new TextEncoder().encode(String(record.data || ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function randomHex(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function makeOpId(deviceId) {
    opCounter += 1;
    return `${deviceId || 'dev'}-${Date.now().toString(36)}-${opCounter}`;
}

export function normalizeRelative(value) {
    const text = String(value == null ? '' : value).trim().replace(/\\/g, '/');
    if (!text || text.startsWith('/')) return '';
    const parts = text.split('/').filter((part) => part && part !== '.');
    if (!parts.length || parts.some((part) => part === '..')) return '';
    return parts.join('/');
}

function normalizeBaseUrl(value) {
    const text = String(value == null ? '' : value).trim().replace(/\/+$/, '');
    return text.replace(/\/sync$/i, '');
}

export function syncConfigured() {
    return !!(settings && settings.sync && settings.sync.url && settings.sync.token);
}

export function initSync({ settings: settingsRef, persist: persistFn, onChange }) {
    settings = settingsRef;
    persist = persistFn || (async () => {});
    notifyChange = onChange || (() => {});

    if (!settings.sync.deviceId) {
        settings.sync.deviceId = `dev-${randomHex(3)}`;
        persist().catch(() => {});
    }

    if (unsubscribe) unsubscribe();
    unsubscribe = onFileChange((path) => {
        queueLocalChange('put', path).catch((err) => {
            console.warn('[Mobile:WARN] 排队同步失败：', err && err.message);
        });
    });
}

function describeHttpError(status) {
    if (status === 401) return '同步令牌不正确，请重新登录同步账户';
    if (status === 403) return '服务端拒绝访问';
    if (status === 404) return '接口不存在，请确认地址指向 EsprinSync 且版本一致';
    if (status === 429) return '尝试次数过多，请稍后再试';
    if (status >= 500) return `服务端错误（HTTP ${status}）`;
    return `请求失败（HTTP ${status}）`;
}

function describeNetworkError(error) {
    const message = error && error.message ? String(error.message) : '';
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|Failed to fetch/i.test(message)) {
        return '无法连接到服务器，请检查地址、端口与网络';
    }
    if (/certificate|SSL|TLS/i.test(message)) return 'TLS 证书校验失败，请检查服务器地址与证书';
    return message ? `请求失败：${message}` : '请求失败：无法连接到服务器';
}

async function apiRequest(method, pathname, { body, timeoutMs = REQUEST_TIMEOUT_MS, baseUrl, token } = {}) {
    const base = normalizeBaseUrl(baseUrl !== undefined ? baseUrl : (settings && settings.sync.url));
    if (!base) return { ok: false, error: '尚未填写同步服务器地址' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const headers = { Accept: 'application/json' };
        const bearer = token !== undefined ? token : (settings && settings.sync.token);
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        const response = await fetch(base + pathname, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal
        });

        const text = await response.text().catch(() => '');
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch (err) {
            parsed = null;
        }

        if (!response.ok) {
            const detail = parsed && parsed.error ? parsed.error : describeHttpError(response.status);
            return { ok: false, status: response.status, error: detail };
        }
        if (!parsed) return { ok: false, error: '服务器返回的不是 JSON，请确认地址指向 EsprinSync' };
        return { ok: true, status: response.status, data: parsed };
    } catch (error) {
        const aborted = error && error.name === 'AbortError';
        return {
            ok: false,
            status: 0,
            error: aborted ? `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）` : describeNetworkError(error)
        };
    } finally {
        clearTimeout(timer);
    }
}
export async function loginWithAccount({ url, account, password }) {
    const base = normalizeBaseUrl(url);
    if (!base) return { ok: false, error: '请先填写同步服务器地址' };
    if (!account) return { ok: false, error: '请填写账户名' };
    if (!password) return { ok: false, error: '请填写账户密码' };

    const device = (settings && settings.sync.deviceId) || `dev-${randomHex(3)}`;
    const result = await apiRequest('POST', `${ADMIN_API_PATH}/tokens/generate`, {
        baseUrl: base,
        token: '',
        body: { name: account, password, tokenName: '移动端', device }
    });
    if (!result.ok) return result;
    if (!result.data.token) return { ok: false, error: '服务端没有返回令牌' };

    return {
        ok: true,
        token: result.data.token,
        tokenId: result.data.id || '',
        user: result.data.user || null
    };
}

export async function checkHealth() {
    const result = await apiRequest('GET', `${SYNC_PATH}/health`, { timeoutMs: 8000 });
    if (!result.ok) return result;
    return { ok: true, data: result.data };
}

export async function queueLocalChange(kind, relativeValue) {
    if (!syncConfigured()) return;
    const relative = normalizeRelative(relativeValue);
    if (!relative) return;

    const state = settings.sync;
    const op = kind === 'del'
        ? { opId: makeOpId(state.deviceId), op: 'del', path: relative, time: Date.now() }
        : await buildPutOp(relative, state.deviceId);
    if (!op) return;

    await writeOutbox(mergeOutboxOp(await readOutbox(), op));
    schedulePush();
}

async function buildPutOp(relative, deviceId) {
    const record = await readRecord(relative);
    if (!record) return null;
    const encoding = record.enc === 'base64' ? 'base64' : 'utf8';
    return {
        opId: makeOpId(deviceId),
        op: 'put',
        path: relative,
        time: Date.now(),
        hash: await hashRecord(record),
        encoding,
        data: String(record.data == null ? '' : record.data)
    };
}

export function schedulePush() {
    if (!syncConfigured()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        pushTimer = null;
        pushOutbox().catch((error) => console.warn('[Mobile:WARN] 推送本地改动失败：', error && error.message));
    }, PUSH_DEBOUNCE_MS);
}

function rememberSelfPushed(seqs) {
    const list = settings.sync.selfPushed || [];
    seqs.forEach((seq) => {
        if (Number(seq) > 0 && !list.includes(Number(seq))) list.push(Number(seq));
    });
    settings.sync.selfPushed = list.slice(-400);
}

function isSelfPushed(seq) {
    const value = Number(seq) || 0;
    if (!value) return false;
    return (settings.sync.selfPushed || []).includes(value);
}

export async function pushOutbox() {
    if (!syncConfigured()) return { ok: false, error: '同步尚未启用' };

    let pushed = 0;
    let remaining = (await readOutbox()).length;

    while (remaining > 0) {
        const ops = (await readOutbox()).slice(0, MAX_OPS_PER_PUSH);
        const result = await apiRequest('POST', `${SYNC_PATH}/ops`, {
            body: { device: settings.sync.deviceId, ops },
            timeoutMs: PUSH_TIMEOUT_MS
        });
        if (!result.ok) return { ok: false, error: result.error, pushed, remaining };

        const acceptedList = Array.isArray(result.data.accepted) ? result.data.accepted : [];
        const accepted = new Set(
            acceptedList.filter((item) => item && !item.error && item.opId).map((item) => item.opId)
        );
        const rejected = acceptedList.filter((item) => item && item.error);

        rememberSelfPushed(acceptedList.filter((item) => item && !item.error && Number(item.seq) > 0)
            .map((item) => Number(item.seq)));

        await writeOutbox((await readOutbox()).filter((op) => !accepted.has(op.opId)
            && !rejected.some((item) => item.opId === op.opId)));

        pushed += accepted.size;
        remaining = (await readOutbox()).length;
        if (!accepted.size && !rejected.length) break;
    }

    return { ok: true, pushed, remaining };
}

async function applyOneOp(op, applied) {
    const relative = normalizeRelative(op && op.path);
    if (!relative || !op || (op.op !== 'put' && op.op !== 'del')) return;
    if (isSelfPushed(op.seq)) return;

    const outbox = await readOutbox();
    const pending = outbox.find((item) => item.path === relative) || null;
    const localNewerPending = !!pending && (pending.time || 0) > (op.time || 0);

    if (localNewerPending) {
        applied.push({ path: relative, action: 'kept-local' });
        return;
    }

    const local = await readRecord(relative);

    if (op.op === 'del') {
        if (!local) {
            applied.push({ path: relative, action: 'already-gone' });
            return;
        }
        await deleteRecord(relative);
        await writeOutbox((await readOutbox()).filter((item) => item.path !== relative));
        applied.push({ path: relative, action: 'deleted' });
        return;
    }

    if (local && op.hash && (await hashRecord(local)) === op.hash) {
        applied.push({ path: relative, action: 'same' });
        return;
    }

    await writeRecord(relative, {
        enc: op.encoding === 'base64' ? 'base64' : 'utf8',
        data: String(op.data == null ? '' : op.data),
        time: Date.now()
    });
    await writeOutbox((await readOutbox()).filter((item) => item.path !== relative));
    applied.push({ path: relative, action: 'written' });
}

export async function pullOps({ full = false } = {}) {
    let since = full ? 0 : Number(settings.sync.lastSeq) || 0;
    const applied = [];

    for (;;) {
        const result = await apiRequest('GET', `${SYNC_PATH}/ops?since=${since}&limit=${PAGE_LIMIT}`);
        if (!result.ok) return { ok: false, error: result.error, applied };

        const ops = Array.isArray(result.data.ops) ? result.data.ops : [];
        for (const op of ops) {
            await applyOneOp(op, applied);
            const seq = Number(op.seq) || 0;
            if (seq > since) since = seq;
        }

        settings.sync.lastSeq = since;
        settings.sync.selfPushed = (settings.sync.selfPushed || []).filter((seq) => seq > since);
        await persist();

        if (!ops.length || !result.data.hasMore) break;
    }

    return { ok: true, applied, lastSeq: settings.sync.lastSeq };
}

function buildSummary({ applied, pushed, remaining }) {
    const written = applied.filter((item) => item.action === 'written').length;
    const deleted = applied.filter((item) => item.action === 'deleted').length;
    const keptLocal = applied.filter((item) => item.action === 'kept-local').length;
    const parts = [];
    if (written) parts.push(`写入 ${written}`);
    if (deleted) parts.push(`删除 ${deleted}`);
    if (keptLocal) parts.push(`保留本地 ${keptLocal}`);
    if (pushed) parts.push(`推送 ${pushed}`);
    if (remaining) parts.push(`待推送 ${remaining}`);
    return parts.length ? `同步完成：${parts.join('、')}` : '同步完成：两侧已一致';
}

export async function syncNow({ full = false, reason = '手动' } = {}) {
    if (running) return { ok: false, error: '上一次同步还没有结束' };
    if (!syncConfigured()) return { ok: false, error: '请先在设置里填写同步服务器并登录' };

    running = true;
    notifyChange({ type: 'syncing', reason });

    try {
        const stateResult = await apiRequest('GET', `${SYNC_PATH}/state`);
        if (!stateResult.ok) return { ok: false, error: stateResult.error };

        const journalId = String(stateResult.data.journalId || '');
        const identityReset = !!journalId && settings.sync.journalId && journalId !== settings.sync.journalId;
        if (journalId && settings.sync.journalId !== journalId) {
            settings.sync.journalId = journalId;
            if (identityReset) settings.sync.lastSeq = 0;
            await persist();
        }

        const pulled = await pullOps({ full: full || identityReset });
        if (!pulled.ok) return { ok: false, error: pulled.error };

        const pushed = await pushOutbox();
        if (!pushed.ok) return { ok: false, error: pushed.error };

        const summary = buildSummary({ applied: pulled.applied, pushed: pushed.pushed, remaining: pushed.remaining });
        settings.sync.lastSyncAt = Date.now();
        settings.sync.summary = summary;
        await persist();

        notifyChange({ type: 'done', summary });
        return { ok: true, summary, applied: pulled.applied, pushed: pushed.pushed, remaining: pushed.remaining };
    } finally {
        running = false;
    }
}

export function isSyncing() {
    return running;
}

export function syncState() {
    return settings ? settings.sync : null;
}
