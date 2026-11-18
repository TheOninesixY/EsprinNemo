const { app, ipcMain, dialog, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfigDir, isDevRun } = require('./data_path.js');
const { createSecretStore } = require('./secret_store.js');

const STATE_FILE_NAME = 'sync_state.json';
const DEV_STATE_FILE_NAME = 'sync_state.dev.json';
const OUTBOX_FILE_NAME = 'sync_outbox.json';
const DEV_OUTBOX_FILE_NAME = 'sync_outbox.dev.json';
const STATE_VERSION = 1;

const REQUEST_TIMEOUT_MS = 15000;
const PUSH_TIMEOUT_MS = 60000;

const SYNC_PATH = '/sync';

const ADMIN_API_PATH = '/admin/api';

const PAGE_LIMIT = 500;
const MAX_OPS_PER_PUSH = 200;

const PUSH_DEBOUNCE_MS = 800;

const RECYCLE_CLAIM_COUNT = 2;

const AUTO_SYNC_PRESETS = { off: 0, '5s': 5, '1m': 60, '5m': 300 };
const AUTO_SYNC_VALUES = Object.keys(AUTO_SYNC_PRESETS).concat('custom');
const AUTO_SYNC_MIN_SECONDS = 5;
const AUTO_SYNC_MAX_SECONDS = 24 * 60 * 60;
const AUTO_SYNC_DEFAULT_SECONDS = 60;
const AUTO_FIRST_SYNC_DELAY_MS = 3000;

const store = createSecretStore({
  header: 'esprin-nemo-sync-token/1',
  fileName: 'sync_token.bin',
  devFileName: 'sync_token.dev.bin',
  label: '同步令牌'
});

let ipcRegistered = false;

let running = false;

let lastError = '';

let autoTimer = null;
let autoFirstTimer = null;

let startupSyncScheduled = false;

let pushTimer = null;
let opCounter = 0;

let resolveDataDir = () => '';
let readUserConfig = () => ({});
let sendToRenderer = () => {};

function configureSyncServer({ getDataDir, getConfig, onRendererMessage } = {}) {
  if (typeof getDataDir === 'function') resolveDataDir = getDataDir;
  if (typeof getConfig === 'function') readUserConfig = getConfig;
  if (typeof onRendererMessage === 'function') sendToRenderer = onRendererMessage;
}

function normalizeBaseUrl(value) {
  const text = String(value == null ? '' : value).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(text)) return '';
  return text;
}

function clampAutoSyncSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return AUTO_SYNC_DEFAULT_SECONDS;
  return Math.min(Math.max(Math.round(num), AUTO_SYNC_MIN_SECONDS), AUTO_SYNC_MAX_SECONDS);
}

function readSyncConfig() {
  const config = readUserConfig();
  const source = config && typeof config === 'object' && config.syncServer && typeof config.syncServer === 'object'
    ? config.syncServer
    : {};

  return {

    enabled: source.enabled === true,
    url: normalizeBaseUrl(source.url),
    device: typeof source.device === 'string' ? source.device.trim() : '',
    autoSync: AUTO_SYNC_VALUES.includes(source.autoSync) ? source.autoSync : 'off',
    autoSyncSeconds: clampAutoSyncSeconds(source.autoSyncSeconds)
  };
}

function autoSyncIntervalMs(config) {
  if (config.autoSync === 'custom') return clampAutoSyncSeconds(config.autoSyncSeconds) * 1000;
  const seconds = AUTO_SYNC_PRESETS[config.autoSync];
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

function validateConfig(config) {
  if (!config.enabled) return { error: '自建同步尚未启用，请先在「设置 → 数据与存储」中打开' };
  if (!config.url) return { error: '请先填写同步服务器地址（以 http:// 或 https:// 开头）' };
  if (!store.status().hasKey) return { error: '请先填写访问令牌（在设置页用「账户登录」生成，或在服务端管理页创建：服务器地址 + /admin）' };
  return {};
}

function configDirFile(name, devName) {
  const dir = getConfigDir(app);
  if (!dir) return null;
  return path.join(dir, isDevRun(app) ? devName : name);
}

function stateFilePath() {
  return configDirFile(STATE_FILE_NAME, DEV_STATE_FILE_NAME);
}

function outboxFilePath() {
  return configDirFile(OUTBOX_FILE_NAME, DEV_OUTBOX_FILE_NAME);
}

function dataPath(relative) {
  return path.join(resolveDataDir(), ...relative.split('/'));
}

function normalizeRelative(value) {
  const text = String(value == null ? '' : value).trim().replace(/\\/g, '/');
  if (!text || text.startsWith('/')) return '';
  const parts = text.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return '';
  return parts.join('/');
}

function writeJsonAtomic(file, value) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(value, null, 2);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch (error) {
    console.warn('[Esprin Nemo] 写入同步文件失败:', file, error.message);
    return false;
  }
}

function makeDeviceId() {
  return `dev-${crypto.randomBytes(3).toString('hex')}`;
}

function readState() {
  const url = readSyncConfig().url;
  const empty = {
    version: STATE_VERSION, url, deviceId: '', journalId: '', lastSeq: 0,
    lastSyncAt: 0, lastSyncSummary: '', selfPushed: []
  };
  const file = stateFilePath();
  if (!file || !fs.existsSync(file)) return empty;

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn('[Esprin Nemo] 读取同步位置失败，将按首次同步处理:', error.message);
    return empty;
  }
  if (!parsed || parsed.version !== STATE_VERSION) return empty;

const sameTarget = parsed.url === url;
  const state = {
    version: STATE_VERSION,
    url,
    deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : '',
    journalId: sameTarget && typeof parsed.journalId === 'string' ? parsed.journalId : '',
    lastSeq: sameTarget && Number.isFinite(Number(parsed.lastSeq)) ? Math.max(0, Math.round(Number(parsed.lastSeq))) : 0,
    lastSyncAt: Number(parsed.lastSyncAt) || 0,
    lastSyncSummary: typeof parsed.lastSyncSummary === 'string' ? parsed.lastSyncSummary : '',

    selfPushed: sameTarget && Array.isArray(parsed.selfPushed)
      ? parsed.selfPushed
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0)
      : []
  };
  return state;
}

let cachedState = null;

function currentState({ reload = false } = {}) {
  if (reload || !cachedState) {
    const loaded = readState();

    cachedState = loaded.deviceId ? loaded : saveState({ deviceId: makeDeviceId() });
  }
  return cachedState;
}

function saveState(patch = {}) {
  const state = { ...(cachedState || readState()), ...patch };
  cachedState = state;
  writeJsonAtomic(stateFilePath(), state);
  return state;
}

function rememberSelfPushed(seqs) {
  const state = currentState();
  const merged = new Set(state.selfPushed || []);
  seqs.forEach((seq) => {
    const value = Math.round(Number(seq) || 0);
    if (value > 0) merged.add(value);
  });
  saveState({ selfPushed: [...merged].filter((seq) => seq > (state.lastSeq || 0)).sort((a, b) => a - b) });
}

function isSelfPushed(seq) {
  const value = Math.round(Number(seq) || 0);
  return value > 0 && (currentState().selfPushed || []).includes(value);
}

function readOutbox() {
  const file = outboxFilePath();
  if (!file || !fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[Esprin Nemo] 读取待推送队列失败:', error.message);
    return [];
  }
}

function writeOutbox(list) {
  return writeJsonAtomic(outboxFilePath(), list);
}

function mergeOutboxOp(list, op) {
  const next = list.filter((item) => item.path !== op.path);
  next.push(op);
  return next;
}

function hashBytes(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function isLikelyText(buffer) {
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString('utf8');
  return !decoded.includes('\uFFFD');
}

function makeOpId(deviceId) {
  opCounter += 1;
  return `${deviceId || 'dev'}-${Date.now().toString(36)}-${opCounter}`;
}

function buildPutOp(relative, deviceId) {
  let buffer = null;
  try {
    buffer = fs.readFileSync(dataPath(relative));
  } catch (error) {
    return null;
  }

  const text = isLikelyText(buffer);
  return {
    opId: makeOpId(deviceId),
    op: 'put',
    path: relative,
    time: Date.now(),
    hash: hashBytes(buffer),
    encoding: text ? 'utf8' : 'base64',
    data: text ? buffer.toString('utf8') : buffer.toString('base64')
  };
}

function buildDelOp(relative, deviceId) {
  return {
    opId: makeOpId(deviceId),
    op: 'del',
    path: relative,
    time: Date.now()
  };
}

function decideApply(op, { localNewerPending = false, localExists = false, localHash = '', opHash = '' } = {}) {
  if (localNewerPending) return 'keep-local';
  if (!op || (op.op !== 'put' && op.op !== 'del')) return 'skip';
  if (op.op === 'del') return localExists ? 'apply' : 'skip';
  if (localExists && opHash && localHash === opHash) return 'skip';
  return 'apply';
}

function describeHttpError(status) {
  if (status === 401) return '同步令牌不正确（服务端要求 Bearer 令牌）';
  if (status === 403) return '服务端拒绝访问';
  if (status === 404) return '接口不存在，请确认地址指向 EsprinSync 且版本一致';
  if (status >= 500) return '服务端返回错误';
  return `请求失败（HTTP ${status}）`;
}

function describeNetworkError(error) {
  const message = error && error.message ? String(error.message) : '';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return '无法解析服务器域名，请检查地址与网络';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) return '无法连接到服务器，请确认它已启动、地址与端口正确';
  if (/certificate|SSL|TLS|self-signed/i.test(message)) return 'TLS 证书校验失败，请检查服务器地址与证书';
  return message ? `请求失败：${message}` : '请求失败：无法连接到服务器';
}

async function apiRequest(method, pathname, { body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const config = readSyncConfig();
  if (!config.url) return { ok: false, error: '尚未填写同步服务器地址' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { Accept: 'application/json' };
    const token = store.read();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(config.url + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text().catch(() => '');
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (error) {
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

async function loginWithAccount({ account, password, tokenName } = {}) {
  const config = readSyncConfig();
  if (!config.url) return { ok: false, error: '请先填写同步服务器地址（以 http:// 或 https:// 开头）' };

  const name = String(account == null ? '' : account).trim();
  const secret = String(password == null ? '' : password);
  if (!secret) return { ok: false, error: '请填写账户密码' };

  const result = await apiRequest('POST', `${ADMIN_API_PATH}/tokens/generate`, {
    body: {
      name,
      password: secret,

      tokenName: tokenName || 'Esprin Nemo',
      device: currentState().deviceId
    }
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };

  const token = result.data && typeof result.data.token === 'string' ? result.data.token.trim() : '';
  if (!token) return { ok: false, error: '服务器没有返回令牌，请确认地址指向 EsprinSync 且版本一致' };

  const saved = store.write(token);
  if (!saved.ok) return saved;

lastError = '';
  return {
    ok: true,
    user: result.data.user || null,
    tokenId: result.data.id || '',
    hasToken: true,
    strong: store.status().strong,
    encrypted: store.status().encrypted
  };
}

function queueLocalChange(kind, relativeValue) {
  const relative = normalizeRelative(relativeValue);
  if (!relative) return;

  const config = readSyncConfig();
  if (!config.enabled || !config.url) return;

  const state = currentState({ reload: true });
  const op = kind === 'del' ? buildDelOp(relative, state.deviceId) : buildPutOp(relative, state.deviceId);
  if (!op) return;

  writeOutbox(mergeOutboxOp(readOutbox(), op));
  schedulePush();
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushOutbox().catch((error) => console.warn('[Esprin Nemo] 推送本地改动失败:', error.message));
  }, PUSH_DEBOUNCE_MS);
}

async function pushOutbox() {
  const config = readSyncConfig();
  const checked = validateConfig(config);
  if (checked.error) return { ok: false, error: checked.error };

  let pushed = 0;
  let remaining = readOutbox().length;

  let freedIds = false;

  while (remaining > 0) {
    const ops = readOutbox().slice(0, MAX_OPS_PER_PUSH);
    const result = await apiRequest('POST', `${SYNC_PATH}/ops`, {
      body: { device: currentState().deviceId, ops },
      timeoutMs: PUSH_TIMEOUT_MS
    });
    if (!result.ok) return { ok: false, error: result.error, pushed, remaining };

    const accepted = new Set(
      (result.data.accepted || [])
        .filter((item) => item && !item.error && item.opId)
        .map((item) => item.opId)
    );

    rememberSelfPushed((result.data.accepted || [])
      .filter((item) => item && !item.error && Number(item.seq) > 0)
      .map((item) => Number(item.seq)));
    if (ops.some((op) => op.op === 'del' && accepted.has(op.opId))) freedIds = true;

const rejected = (result.data.accepted || []).filter((item) => item && item.error);
    if (rejected.length) {
      console.warn('[Esprin Nemo] 服务端拒绝了部分操作:', rejected.map((item) => item.error).join('；'));
    }
    writeOutbox(readOutbox().filter((op) => !accepted.has(op.opId)
      && !rejected.some((item) => item.opId === op.opId)));

    pushed += accepted.size;
    remaining = readOutbox().length;
    if (!accepted.size && !rejected.length) break;
  }

  lastError = '';

  if (freedIds) sendToRenderer('sync:pushed', { pushed, remaining });
  return { ok: true, pushed, remaining };
}

async function claimRecycledIds({ count = RECYCLE_CLAIM_COUNT, kind = '' } = {}) {
  const checked = validateConfig(readSyncConfig());
  if (checked.error) return { ok: false, error: checked.error };

  const state = currentState();
  const wanted = Math.max(1, Math.round(Number(count) || 1));
  const result = await apiRequest('POST', `${SYNC_PATH}/ids/claim`, {
    body: {
      device: state.deviceId,
      kind: kind === 'notes' || kind === 'todos' ? kind : '',
      count: wanted,

      since: state.lastSeq
    },
    timeoutMs: 8000
  });
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    ids: Array.isArray(result.data.ids) ? result.data.ids : [],

    pending: Number(result.data.pending) || 0
  };
}

async function listShares() {
  const checked = validateConfig(readSyncConfig());
  if (checked.error) return { ok: false, error: checked.error };

  const result = await apiRequest('GET', `${SYNC_PATH}/shares`, { timeoutMs: 8000 });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return { ok: true, ...result.data };
}

async function requestShare(payload = {}) {
  const checked = validateConfig(readSyncConfig());
  if (checked.error) return { ok: false, error: checked.error };

  const relative = normalizeRelative(payload.path);
  if (!relative) return { ok: false, error: '这篇笔记还没有归属，无法共享' };
  const target = String(payload.target == null ? '' : payload.target).trim();
  if (!target) return { ok: false, error: '请填写对方的用户 ID' };

  const result = await apiRequest('POST', `${SYNC_PATH}/shares/request`, {
    body: { path: relative, target }
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return { ok: true, share: result.data.share || null };
}

async function shareAction(pathname, payload = {}) {
  const checked = validateConfig(readSyncConfig());
  if (checked.error) return { ok: false, error: checked.error };

  const id = String(payload.id == null ? '' : payload.id).trim();
  if (!id) return { ok: false, error: '缺少共享记录标识' };

  const body = { id };
  if (pathname.endsWith('/respond')) body.accept = payload.accept !== false;

  const result = await apiRequest('POST', `${SYNC_PATH}${pathname}`, { body });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };

  const synced = await syncNow({ reason: '团队笔记' });
  return {
    ok: true,
    status: result.data.status || '',
    shared: result.data.share || null,
    synced: synced && synced.ok ? synced : null,
    syncError: synced && !synced.ok ? synced.error : ''
  };
}

function decodeOpPayload(op) {
  const data = typeof op.data === 'string' ? op.data : '';
  if (op.encoding === 'base64') return Buffer.from(data, 'base64');
  return Buffer.from(data, 'utf8');
}

function writeFileAtomicBuffer(file, buffer) {
  const temp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, file);
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch (cleanupError) {

    }
    console.error('[Esprin Nemo] 重放写入失败:', file, error.message);
    return false;
  }
}

function applyOneOp(op, applied) {
  const relative = normalizeRelative(op && op.path);
  if (!relative || !op || (op.op !== 'put' && op.op !== 'del')) return;

if (isSelfPushed(op.seq)) return;

  const outbox = readOutbox();
  const pending = outbox.find((item) => item.path === relative) || null;
  const localNewerPending = !!pending && (pending.time || 0) > (op.time || 0);

  const target = dataPath(relative);
  const exists = fs.existsSync(target);
  let localHash = '';
  if (exists && op.op === 'put') {
    try {
      localHash = hashBytes(fs.readFileSync(target));
    } catch (error) {
      localHash = '';
    }
  }

  const decision = decideApply(op, {
    localNewerPending,
    localExists: exists,
    localHash,
    opHash: op.hash || ''
  });

  if (decision === 'keep-local') {
    applied.push({ path: relative, action: 'kept-local' });
    return;
  }
  if (decision === 'skip') {
    applied.push({ path: relative, action: op.op === 'del' ? 'already-gone' : 'same' });
    return;
  }

  if (op.op === 'del') {
    try {
      fs.unlinkSync(target);

      writeOutbox(readOutbox().filter((item) => item.path !== relative));
      applied.push({ path: relative, action: 'deleted' });
    } catch (error) {
      applied.push({ path: relative, action: 'error', error: error.message });
    }
    return;
  }

  const buffer = decodeOpPayload(op);
  if (writeFileAtomicBuffer(target, buffer)) {
    writeOutbox(readOutbox().filter((item) => item.path !== relative));
    applied.push({ path: relative, action: 'written' });
  } else {
    applied.push({ path: relative, action: 'error', error: '写入失败' });
  }
}

const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;

let parsedJournalCache = null;

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function parseJournalText(text) {
  const entries = [];
  const devices = new Set();
  let invalid = 0;
  let latestSeq = 0;

  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw = null;
    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      invalid += 1;
      continue;
    }

    const record = raw && typeof raw === 'object' ? raw : null;
    const kind = record ? record.op : '';
    const relative = record ? normalizeRelative(record.path) : '';
    const hasPayload = kind !== 'put' || typeof record.data === 'string';
    if (!record || !relative || (kind !== 'put' && kind !== 'del') || !hasPayload) {
      invalid += 1;
      continue;
    }

    const seq = Number(record.seq) || 0;
    if (seq > latestSeq) latestSeq = seq;
    if (record.device) devices.add(String(record.device));
    entries.push({ ...record, seq, path: relative, op: kind });
  }

  return { entries, invalid, latestSeq, devices: [...devices] };
}

function orderJournalEntries(entries) {
  const list = entries.slice();
  if (!list.length || list.some((entry) => !(entry.seq > 0))) return list;
  return list.sort((a, b) => a.seq - b.seq);
}

function journalFinalState(entries) {
  const final = new Map();
  for (const entry of entries) {
    if (entry.op === 'del') final.delete(entry.path);
    else final.set(entry.path, entry);
  }
  return final;
}

function readJournalFile(filePath, { reload = false } = {}) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: '请先选择一份日志文件' };

  let file = '';
  try {
    file = path.resolve(filePath);
  } catch (error) {
    return { ok: false, error: '日志文件路径不合法' };
  }

  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    return { ok: false, error: `读不到这个文件：${error.message}` };
  }
  if (!stat.isFile()) return { ok: false, error: '所选路径不是一个文件' };
  if (stat.size > JOURNAL_MAX_BYTES) {
    return { ok: false, error: `日志太大（${formatBytes(stat.size)}），超过 ${formatBytes(JOURNAL_MAX_BYTES)} 的读取上限` };
  }

  if (!reload && parsedJournalCache
    && parsedJournalCache.file === file
    && parsedJournalCache.size === stat.size
    && parsedJournalCache.mtimeMs === stat.mtimeMs) {
    return { ...parsedJournalCache.parsed, file, size: stat.size, cached: true };
  }

  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: `读取日志失败：${error.message}` };
  }

  const parsed = parseJournalText(text);
  if (!parsed.entries.length) {
    return {
      ok: false,
      error: parsed.invalid
        ? '这个文件里没有可用的操作：每行应当是一条 JSON 操作记录（是不是选错了文件？）'
        : '这个文件是空的'
    };
  }

  parsedJournalCache = { file, size: stat.size, mtimeMs: stat.mtimeMs, parsed };
  return { ...parsed, file, size: stat.size, cached: false };
}

function inspectJournal(filePath) {
  const parsed = readJournalFile(filePath);
  if (!parsed.ok) return parsed;

  const final = journalFinalState(orderJournalEntries(parsed.entries));
  let contentBytes = 0;
  final.forEach((entry) => { contentBytes += decodeOpPayload(entry).length; });

  const puts = parsed.entries.filter((entry) => entry.op === 'put').length;
  return {
    ok: true,
    file: parsed.file,
    fileName: path.basename(parsed.file),
    size: parsed.size,
    ops: parsed.entries.length,
    puts,
    dels: parsed.entries.length - puts,
    files: final.size,
    contentBytes,
    invalid: parsed.invalid,
    latestSeq: parsed.latestSeq,

    samplePaths: [...final.keys()].sort().slice(0, 12),
    devices: parsed.devices,
    cached: parsed.cached
  };
}

function applyJournalEntries(entries, rootDir) {
  const applied = { written: 0, deleted: 0, skipped: 0, errors: [] };

  for (const entry of entries) {
    const target = path.join(rootDir, ...entry.path.split('/'));
    if (entry.op === 'del') {
      if (!fs.existsSync(target)) {
        applied.skipped += 1;
        continue;
      }
      try {
        fs.unlinkSync(target);
        applied.deleted += 1;
      } catch (error) {
        applied.errors.push(`${entry.path}：${error.message}`);
      }
      continue;
    }

    if (writeFileAtomicBuffer(target, decodeOpPayload(entry))) applied.written += 1;
    else applied.errors.push(`${entry.path}：写入失败`);
  }

  return applied;
}

function importJournalFile(payload = {}) {
  const parsed = readJournalFile(payload.filePath);
  if (!parsed.ok) return parsed;

  const root = resolveDataDir();
  if (!root) return { ok: false, error: '数据目录不可用，无法导入' };

  const entries = orderJournalEntries(parsed.entries);
  const applied = applyJournalEntries(entries, root);

  parsedJournalCache = null;
  const failed = applied.errors.length;
  const summary = `导入完成：写入 ${applied.written} 个文件，删除 ${applied.deleted} 个，跳过 ${applied.skipped} 个`
    + (failed ? `，失败 ${failed} 个` : '');

  return {
    ok: true,
    fileName: path.basename(parsed.file),
    ops: entries.length,
    written: applied.written,
    deleted: applied.deleted,
    skipped: applied.skipped,
    errors: applied.errors.slice(0, 10),
    summary
  };
}

function isSameOrInside(target, parent) {
  if (!target || !parent) return false;
  const normalize = (value) => path.resolve(String(value)).toLowerCase();
  const child = normalize(target);
  const root = normalize(parent);
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function exportJournalToFolder(payload = {}) {
  const parsed = readJournalFile(payload.filePath);
  if (!parsed.ok) return parsed;

  const rawTarget = String(payload.targetDir || '');
  if (!rawTarget) return { ok: false, error: '请先选择要导出到的文件夹' };

  let target = '';
  try {
    target = path.resolve(rawTarget);
  } catch (error) {
    return { ok: false, error: '导出目录不合法' };
  }

  const dataRoot = resolveDataDir();
  if (dataRoot && isSameOrInside(target, dataRoot)) {
    return { ok: false, error: '导出目录不能位于数据目录内：导出的文件会被当成数据，混进同步里' };
  }

  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (error) {
    return { ok: false, error: `无法创建导出目录：${error.message}` };
  }

  const final = journalFinalState(orderJournalEntries(parsed.entries));

  parsedJournalCache = null;
  const errors = [];
  let files = 0;
  let bytes = 0;

  for (const [relative, entry] of final) {
    const buffer = decodeOpPayload(entry);
    if (writeFileAtomicBuffer(path.join(target, ...relative.split('/')), buffer)) {
      files += 1;
      bytes += buffer.length;
    } else {
      errors.push(`${relative}：写入失败`);
    }
  }

  return {
    ok: true,
    targetDir: target,
    journalFile: path.basename(parsed.file),
    ops: parsed.entries.length,
    files,
    bytes,
    errors: errors.slice(0, 10),
    summary: `已把《${path.basename(parsed.file)}》摊成 ${files} 个文件（${formatBytes(bytes)}）`
  };
}

async function ensureJournalIdentity() {
  const health = await apiRequest('GET', `${SYNC_PATH}/health`, { timeoutMs: 8000 });
  if (!health.ok) return { ok: false, error: health.error };

  const remoteId = String(health.data.journalId || '');
  const remoteLatest = Number(health.data.latestSeq) || 0;
  const state = currentState({ reload: true });

  const idChanged = !!remoteId && remoteId !== state.journalId;

  const seqRewound = !idChanged && remoteLatest < state.lastSeq;

  if (idChanged || seqRewound) {

    saveState({ journalId: remoteId, lastSeq: 0, selfPushed: [] });
    console.warn('[Esprin Nemo] 服务端日志已更换，同步序号已归零，将重新全量重放');
    return { ok: true, reset: true, remoteId };
  }

  if (remoteId && !state.journalId) saveState({ journalId: remoteId });
  return { ok: true, reset: false, remoteId };
}

async function pullOps({ full = false } = {}) {
  let state = currentState({ reload: true });
  let since = full ? 0 : state.lastSeq;
  const applied = [];

  for (;;) {
    const result = await apiRequest('GET', `${SYNC_PATH}/ops?since=${since}&limit=${PAGE_LIMIT}`);
    if (!result.ok) return { ok: false, error: result.error, applied };

    const ops = Array.isArray(result.data.ops) ? result.data.ops : [];
    for (const op of ops) {
      applyOneOp(op, applied);
      const seq = Number(op.seq) || 0;
      if (seq > since) since = seq;
    }

    state = saveState({
      lastSeq: since,

      selfPushed: (state.selfPushed || []).filter((seq) => seq > since)
    });
    if (!ops.length || !result.data.hasMore) break;
  }

  return { ok: true, applied, lastSeq: state.lastSeq };
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

async function syncNow({ full = false, reason = '手动' } = {}) {
  if (running) return { ok: false, error: '上一次同步还没有结束' };

  const config = readSyncConfig();
  const checked = validateConfig(config);
  if (checked.error) return { ok: false, error: checked.error };

  running = true;
  try {
    const identity = await ensureJournalIdentity();
    if (!identity.ok) {
      lastError = identity.error;
      return { ok: false, error: identity.error };
    }

const pulled = await pullOps({ full: full || identity.reset });
    if (!pulled.ok) {
      lastError = pulled.error;
      return { ok: false, error: pulled.error };
    }

    const pushed = await pushOutbox();
    if (!pushed.ok) {
      lastError = pushed.error;
      return { ok: false, error: pushed.error };
    }

    const summary = buildSummary({ applied: pulled.applied, pushed: pushed.pushed, remaining: pushed.remaining });
    const state = saveState({ lastSyncAt: Date.now(), lastSyncSummary: summary });
    lastError = '';

const changed = pulled.applied.filter((item) => item.action === 'written' || item.action === 'deleted');
    if (changed.length) {
      sendToRenderer('sync:applied', {
        summary,
        count: changed.length,
        applied: changed.slice(0, 20)
      });
    }

    sendToRenderer('sync:complete', { summary, lastSeq: state.lastSeq, changed: changed.length });

    return {
      ok: true,
      reason,
      summary,
      lastSeq: state.lastSeq,
      lastSyncAt: state.lastSyncAt,

      journalReset: identity.reset,
      pulled: pulled.applied.length,
      written: pulled.applied.filter((item) => item.action === 'written').length,
      deleted: pulled.applied.filter((item) => item.action === 'deleted').length,
      keptLocal: pulled.applied.filter((item) => item.action === 'kept-local').length,
      pushed: pushed.pushed,
      remaining: pushed.remaining
    };
  } finally {
    running = false;
  }
}

function scanDataDir(dir, prefix = '', files = new Map()) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return files;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      scanDataDir(full, relative, files);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
    try {
      files.set(relative, fs.statSync(full).size);
    } catch (error) {

    }
  }
  return files;
}

async function importLocal({ sender = null } = {}) {
  const config = readSyncConfig();
  const checked = validateConfig(config);
  if (checked.error) return { ok: false, error: checked.error };

const identity = await ensureJournalIdentity();
  if (!identity.ok) return { ok: false, error: identity.error };

  const pulled = await pullOps({ full: true });
  if (!pulled.ok) return { ok: false, error: pulled.error };

  const stateResult = await apiRequest('GET', `${SYNC_PATH}/state`);
  if (!stateResult.ok) return { ok: false, error: stateResult.error };

  const known = new Set([
    ...Object.keys(stateResult.data.files || {}),
    ...Object.keys(stateResult.data.deleted || {})
  ]);

  const local = scanDataDir(resolveDataDir());
  const state = currentState({ reload: true });
  let queued = 0;
  for (const relative of local.keys()) {
    if (known.has(relative)) continue;
    const op = buildPutOp(relative, state.deviceId);
    if (!op) continue;
    writeOutbox(mergeOutboxOp(readOutbox(), op));
    queued += 1;
  }

  const pushed = await pushOutbox();
  if (!pushed.ok) return { ok: false, error: pushed.error };

  const summary = `首次接入：拉取 ${pulled.applied.length} 条，推送 ${pushed.pushed} 个本地文件`;
  saveState({ lastSyncAt: Date.now(), lastSyncSummary: summary });
  lastError = '';

  const changed = pulled.applied.filter((item) => item.action === 'written' || item.action === 'deleted');
  if (changed.length) {
    sendToRenderer('sync:applied', { summary, count: changed.length, applied: changed.slice(0, 20) });
  }

  return {
    ok: true,
    summary,
    pulled: pulled.applied.length,
    written: pulled.applied.filter((item) => item.action === 'written').length,
    deleted: pulled.applied.filter((item) => item.action === 'deleted').length,
    imported: queued,
    pushed: pushed.pushed,
    remaining: pushed.remaining
  };
}

function syncStatus() {
  const config = readSyncConfig();
  const state = currentState({ reload: true });
  const intervalMs = autoTimer ? autoSyncIntervalMs(config) : 0;

  return {
    enabled: config.enabled,
    url: config.url,
    device: config.device,
    deviceId: state.deviceId,
    autoSync: config.autoSync,
    autoSyncSeconds: config.autoSyncSeconds,
    intervalMs,

    startupSync: !validateConfig(config).error,
    active: !!autoTimer || !!autoFirstTimer,
    lastSeq: state.lastSeq,
    lastSyncAt: state.lastSyncAt,
    lastSyncSummary: state.lastSyncSummary,
    pending: readOutbox().length,
    hasToken: store.status().hasKey,
    strong: store.status().strong,
    lastError
  };
}

async function autoSync(reason) {
  const config = readSyncConfig();
  if (validateConfig(config).error) return null;
  const result = await syncNow({ reason });
  if (!result.ok) console.warn(`[Esprin Nemo] 自建同步（${reason}）未成功:`, result.error);
  return result;
}

function applyAutoSyncRuntime() {
  clearAutoSyncRuntime();

  const config = readSyncConfig();
  if (validateConfig(config).error) return;

  if (!startupSyncScheduled) {
    startupSyncScheduled = true;
    autoFirstTimer = setTimeout(() => { autoSync('启动'); }, AUTO_FIRST_SYNC_DELAY_MS);
  }

  const intervalMs = autoSyncIntervalMs(config);
  if (intervalMs > 0) {
    autoTimer = setInterval(() => { autoSync('定时'); }, intervalMs);
  }
}

function clearAutoSyncRuntime() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (autoFirstTimer) {
    clearTimeout(autoFirstTimer);
    autoFirstTimer = null;
  }
}

async function diagnose() {
  const config = readSyncConfig();
  const state = currentState({ reload: true });
  const lines = [];

  lines.push('=== Esprin Nemo 自建同步诊断 ===');
  lines.push(`时间：${new Date().toLocaleString()}`);
  lines.push(`服务器地址：${config.url || '（未填写）'}`);
  lines.push(`启用：${config.enabled ? '是' : '否'}；自动同步：${config.autoSync}`
    + `${config.autoSync === 'custom' ? `（${config.autoSyncSeconds} 秒）` : ''}`);
  lines.push(`设备 ID：${state.deviceId}；设备名：${config.device || '（未填）'}`);
  lines.push(`已应用到序号：${state.lastSeq}；最近同步：${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : '（从未）'}`);
  lines.push(`待推送操作：${readOutbox().length} 条`);
  lines.push(`令牌：${store.status().hasKey ? '已保存' : '未保存'}`);
  lines.push(`状态文件：${stateFilePath() || '（配置目录不可用）'}`);
  lines.push(`待推送队列：${outboxFilePath() || '（配置目录不可用）'}`);

  const outbox = readOutbox();
  if (outbox.length) {
    lines.push('', '--- 待推送操作（最多 30 条）---');
    outbox.slice(0, 30).forEach((op) => {
      lines.push(`  ${op.op === 'del' ? '删除' : '写入'}  ${op.path}  time=${op.time}`);
    });
  }

  const health = await apiRequest('GET', `${SYNC_PATH}/health`, { timeoutMs: 8000 });
  lines.push('', `--- 服务端 ${SYNC_PATH}/health ---`);
  lines.push(health.ok ? JSON.stringify(health.data) : `失败：${health.error}`);

  if (health.ok) {
    const serverState = await apiRequest('GET', `${SYNC_PATH}/state`);
    if (serverState.ok) {
      const files = Object.keys(serverState.data.files || {});
      const deleted = Object.keys(serverState.data.deleted || {});
      lines.push('', `--- 服务端状态：最新序号 ${serverState.data.latestSeq}，存活 ${files.length} 个文件，删除记录 ${deleted.length} 条 ---`);
      lines.push(`  日志身份：${serverState.data.journalId || '（服务端未提供）'}`);
      files.slice(0, 40).forEach((file) => {
        const info = serverState.data.files[file];
        lines.push(`  ${file}  seq=${info.seq}  device=${info.device || '（未知）'}`);
      });
      if (deleted.length) {
        lines.push('  已删除：' + deleted.slice(0, 20).join('、'));
      }

const localFiles = scanDataDir(resolveDataDir());
      const serverSet = new Set(files);
      const deletedSet = new Set(deleted);
      const neverSeen = [...localFiles.keys()]
        .filter((relative) => !serverSet.has(relative) && !deletedSet.has(relative));
      const localMissing = files.filter((relative) => !localFiles.has(relative));
      const remoteLatest = Number(serverState.data.latestSeq) || 0;
      const idMismatch = !!serverState.data.journalId && serverState.data.journalId !== state.journalId;

      lines.push('', '--- 与服务端的差异 ---');
      lines.push(`  日志身份：服务端 ${serverState.data.journalId || '（未提供）'}；本机记录 ${state.journalId || '（无）'}`
        + `${idMismatch ? '  → 不一致，下次同步会自动归零并全量重拉' : ''}`);
      lines.push(`  序号：本机已应用到 ${state.lastSeq}，服务端最新 ${remoteLatest}`
        + `${remoteLatest < state.lastSeq ? '  → 服务端日志比本机旧（换过目录 / 清空过），下次同步会自动归零重拉' : ''}`);
      lines.push(`  本地 ${localFiles.size} 个文件；服务端从未见过的 ${neverSeen.length} 个；服务端有而本地没有的 ${localMissing.length} 个`);
      if (neverSeen.length) {
        lines.push(`  从未上传：${neverSeen.slice(0, 10).join('、')}${neverSeen.length > 10 ? ' 等' : ''}`);
        lines.push('  → 刚配置好时点「首次接入」可以一次把它们推上去');
      }
      if (localMissing.length) {
        lines.push(`  本地缺失：${localMissing.slice(0, 10).join('、')}${localMissing.length > 10 ? ' 等' : ''}`);
      }
    } else {
      lines.push(`--- 拉取服务端状态失败：${serverState.error} ---`);
    }

const ops = await apiRequest('GET', `${SYNC_PATH}/ops?since=${state.lastSeq}&limit=${PAGE_LIMIT}`);
    if (ops.ok) {
      const list = Array.isArray(ops.data.ops) ? ops.data.ops : [];
      lines.push('', `--- 计划：还有 ${list.length} 条操作待重放 ---`);
      list.slice(0, 30).forEach((op) => {
        const relative = normalizeRelative(op.path);
        const exists = relative ? fs.existsSync(dataPath(relative)) : false;
        lines.push(`  ${op.op === 'del' ? '删除' : '写入'}  ${op.path}  seq=${op.seq}`
          + `  device=${op.device || '（未知）'}  本地${exists ? '存在' : '不存在'}`);
      });
    }
  }

  const text = lines.join('\n');
  const file = configDirFile('sync_diagnose.txt', 'sync_diagnose.dev.txt');
  if (file) {
    try {
      fs.writeFileSync(file, text, 'utf8');
    } catch (error) {
      return { ok: true, path: '', text };
    }
  }
  return { ok: true, path: file || '', text };
}

function registerSyncIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('sync:status', () => syncStatus());

  ipcMain.handle('sync:token-status', () => ({
    hasToken: store.status().hasKey,
    strong: store.status().strong,
    encrypted: store.status().encrypted
  }));

  ipcMain.handle('sync:set-token', (event, payload) => {
    const result = store.write(payload && payload.token);
    return result.ok
      ? { ok: true, hasToken: true, strong: store.status().strong, encrypted: store.status().encrypted }
      : result;
  });

  ipcMain.handle('sync:clear-token', () => {
    const result = store.clear();
    return result.ok
      ? { ok: true, hasToken: false, strong: false, encrypted: false }
      : result;
  });

ipcMain.handle('sync:login', (event, payload) => loginWithAccount(payload || {}));

ipcMain.handle('sync:test', async () => {
    const config = readSyncConfig();
    if (!config.url) return { ok: false, error: '请先填写服务器地址（以 http:// 或 https:// 开头）' };

    const health = await apiRequest('GET', `${SYNC_PATH}/health`, { timeoutMs: 8000 });
    if (!health.ok) return { ok: false, error: health.error };

    const stateResult = await apiRequest('GET', `${SYNC_PATH}/state`);
    if (!stateResult.ok) {
      return {
        ok: false,
        error: stateResult.status === 401
          ? '能连上服务器，但需要访问令牌：可在设置页用「账户登录」生成，或在下面填写令牌后重试'
          : stateResult.error
      };
    }

    return {
      ok: true,
      server: health.data.name || 'EsprinSync',
      version: health.data.version || 1,
      latestSeq: stateResult.data.latestSeq || 0,
      fileCount: Object.keys(stateResult.data.files || {}).length,
      deletedCount: Object.keys(stateResult.data.deleted || {}).length,
      authRequired: !!health.data.authRequired
    };
  });

  ipcMain.handle('sync:now', () => syncNow({ reason: '手动' }));

ipcMain.handle('sync:claim-ids', (event, payload) => claimRecycledIds(payload || {}));

ipcMain.handle('sync:import-local', (event) => importLocal({ sender: event.sender }));

ipcMain.handle('sync:shares', () => listShares());
  ipcMain.handle('sync:share-request', (event, payload) => requestShare(payload || {}));
  ipcMain.handle('sync:share-respond', (event, payload) => shareAction('/shares/respond', payload || {}));
  ipcMain.handle('sync:share-revoke', (event, payload) => shareAction('/shares/revoke', payload || {}));
  ipcMain.handle('sync:share-leave', (event, payload) => shareAction('/shares/leave', payload || {}));

ipcMain.handle('sync:apply-auto-sync', () => {
    applyAutoSyncRuntime();
    return syncStatus();
  });

  ipcMain.handle('sync:diagnose', () => diagnose());

ipcMain.on('sync:push', (event, payload) => {
    const relative = payload && payload.path;
    const config = readSyncConfig();
    if (!config.enabled || !config.url) return;
    queueLocalChange('put', relative);
  });

  ipcMain.on('sync:remove', (event, payload) => {
    const relative = payload && payload.path;
    const config = readSyncConfig();
    if (!config.enabled || !config.url) return;
    queueLocalChange('del', relative);
  });

  registerJournalIpc();
}

function ownerWindow(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win : null;
}

async function showOpenDialogFor(event, options) {
  const parent = ownerWindow(event);
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

function registerJournalIpc() {
  ipcMain.handle('journal:pick-file', async (event) => {
    const result = await showOpenDialogFor(event, {
      title: '选择服务端的日志文件（journal.log）',
      buttonLabel: '选择日志',
      properties: ['openFile'],
      filters: [
        { name: '日志文件（journal.log）', extensions: ['log', 'jsonl', 'ndjson', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true, path: '' };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('journal:pick-folder', async (event) => {
    const result = await showOpenDialogFor(event, {
      title: '选择导出到的文件夹',
      buttonLabel: '导出到这里',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true, dir: '' };
    return { canceled: false, dir: result.filePaths[0] };
  });

ipcMain.handle('journal:inspect', (event, payload) => inspectJournal(payload && payload.filePath));

ipcMain.handle('journal:import-file', (event, payload) => importJournalFile(payload || {}));

ipcMain.handle('journal:export-folder', (event, payload) => {
    const result = exportJournalToFolder(payload || {});
    if (result.ok && shell) {
      try {
        Promise.resolve(shell.openPath(result.targetDir)).catch(() => {});
      } catch (error) {

      }
    }
    return result;
  });
}

module.exports = {
  configureSyncServer,
  registerSyncIpc,
  applyAutoSyncRuntime,

  decideApply,
  normalizeRelative,
  mergeOutboxOp,
  hashBytes,
  parseJournalText,
  orderJournalEntries,
  journalFinalState,
  applyJournalEntries,
  isSameOrInside
};
