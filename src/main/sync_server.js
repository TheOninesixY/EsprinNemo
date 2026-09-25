// Esprin Nemo 自建同步（主进程）：操作日志模型，服务端见 server/EsprinServer.py。
//
// 与 WebDAV 那套「扫目录、比时间」的根本区别在于「什么才算发生了事」：
//   * 旧模型：只能看到「远端有这个文件 / 没有这个文件」。A 删了一篇笔记，B 看到自己缺文件，
//     就会当成「本地没有、需要补上」——于是删掉的笔记又被传回来。
//   * 本模型：每一次本地写入/删除都变成一条操作（put / del）记进 outbox 推给服务端，
//     服务端分配全局递增 seq 写进 append-only 日志。删除本身就是一条操作（tombstone），
//     谁重放都会删掉它，绝不会因为「文件不存在」而触发任何补写。
//
// 三个本地文件（都在应用配置目录，不在数据目录里，免得被自己同步）：
//   sync_state.json   本次同步位置：服务器地址、设备 id、已应用到第几号 seq
//   sync_outbox.json  还没推上去的操作（原子写，推成功后按 opId 移除）
//   sync_token.bin    访问令牌，交给系统密钥链（见 secret_store.js）
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

// 请求超时：拉取与状态查询是轻量请求，推送可能带上多篇笔记
const REQUEST_TIMEOUT_MS = 15000;
const PUSH_TIMEOUT_MS = 60000;
// 服务端的同步接口前缀：所有同步请求都挂在它下面（管理页在 /admin，与此无关）
const SYNC_PATH = '/sync';
// 一次拉取多少条、一次推送多少条
const PAGE_LIMIT = 500;
const MAX_OPS_PER_PUSH = 200;
// 本地改动攒一下再推，避免每敲一个字就发一次请求
const PUSH_DEBOUNCE_MS = 800;
// 一次领几个可复用 ID：多领一两个，连着新建也能用上；领了没用上的会在服务端超时回到池子
const RECYCLE_CLAIM_COUNT = 2;

/* 自动同步的预设（与渲染进程的设置项保持一致）：值是「定时同步」的间隔秒数，0 表示不定时。
   这里没有「每次启动应用时」这一项：只要同步开着，每次应用启动都会同步一次，
   启动同步是总开关本身的行为，不归「自动同步」管（见 applyAutoSyncRuntime）。 */
const AUTO_SYNC_PRESETS = { off: 0, '5s': 5, '1m': 60, '5m': 300 };
const AUTO_SYNC_VALUES = Object.keys(AUTO_SYNC_PRESETS).concat('custom');
const AUTO_SYNC_MIN_SECONDS = 5;
const AUTO_SYNC_MAX_SECONDS = 24 * 60 * 60;
const AUTO_SYNC_DEFAULT_SECONDS = 60;
const AUTO_FIRST_SYNC_DELAY_MS = 3000;

// 访问令牌存在系统密钥链里，与 AI Key、WebDAV 口令同一套实现
const store = createSecretStore({
  header: 'esprin-nemo-sync-token/1',
  fileName: 'sync_token.bin',
  devFileName: 'sync_token.dev.bin',
  label: '同步令牌'
});

let ipcRegistered = false;
// 同一时刻只跑一次同步
let running = false;
// 最近一次失败原因：设置页据此提示，成功后清空
let lastError = '';
// 自动同步的定时器
let autoTimer = null;
let autoFirstTimer = null;
// 本轮启动的同步是否已经排上：设置变更会重建定时器，但「启动同步」每轮只排一次
let startupSyncScheduled = false;
// outbox 推送的防抖定时器
let pushTimer = null;
let opCounter = 0;

// 由 main.js 注入
let resolveDataDir = () => '';
let readUserConfig = () => ({});
let sendToRenderer = () => {};

function configureSyncServer({ getDataDir, getConfig, onRendererMessage } = {}) {
  if (typeof getDataDir === 'function') resolveDataDir = getDataDir;
  if (typeof getConfig === 'function') readUserConfig = getConfig;
  if (typeof onRendererMessage === 'function') sendToRenderer = onRendererMessage;
}

/* ---------------- 配置 ---------------- */

// 服务器地址：只接受 http(s)，统一去掉末尾斜杠
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
    // 默认关闭：没填地址就什么都不做
    enabled: source.enabled === true,
    url: normalizeBaseUrl(source.url),
    device: typeof source.device === 'string' ? source.device.trim() : '',
    autoSync: AUTO_SYNC_VALUES.includes(source.autoSync) ? source.autoSync : 'off',
    autoSyncSeconds: clampAutoSyncSeconds(source.autoSyncSeconds)
  };
}

// 自动同步的间隔（毫秒）：0 表示不定时（关闭，只靠启动时同步一次与本地改动的即时推送）
function autoSyncIntervalMs(config) {
  if (config.autoSync === 'custom') return clampAutoSyncSeconds(config.autoSyncSeconds) * 1000;
  const seconds = AUTO_SYNC_PRESETS[config.autoSync];
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

// 参数是否齐到可以同步：地址与访问令牌都是必需项（服务端对 /sync 一律要求凭据）
function validateConfig(config) {
  if (!config.enabled) return { error: '自建同步尚未启用，请先在「设置 → 数据与存储」中打开' };
  if (!config.url) return { error: '请先填写同步服务器地址（以 http:// 或 https:// 开头）' };
  if (!store.status().hasKey) return { error: '请先填写访问令牌（在服务端管理页创建：服务器地址 + /admin）' };
  return {};
}

/* ---------------- 本地文件：路径、状态、outbox ---------------- */

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

// 数据目录内的相对路径 → 绝对路径
function dataPath(relative) {
  return path.join(resolveDataDir(), ...relative.split('/'));
}

// 数据目录内的相对路径：统一正斜杠、拒绝越界与空路径（与服务端同一套规则）
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

/* 同步位置。两个注意点：
   - 换了服务器地址就把 lastSeq 归零：不同服务端的 seq 没有可比性，硬接着用会漏拉。
   - 设备 id 生成一次后固定下来，它同时出现在每条操作的 opId 里，便于事后分辨是谁改的。 */
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

  // 换了服务器地址就把序号与日志身份一并清掉：不同服务端的 seq 没有可比性
  const sameTarget = parsed.url === url;
  const state = {
    version: STATE_VERSION,
    url,
    deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : '',
    journalId: sameTarget && typeof parsed.journalId === 'string' ? parsed.journalId : '',
    lastSeq: sameTarget && Number.isFinite(Number(parsed.lastSeq)) ? Math.max(0, Math.round(Number(parsed.lastSeq))) : 0,
    lastSyncAt: Number(parsed.lastSyncAt) || 0,
    lastSyncSummary: typeof parsed.lastSyncSummary === 'string' ? parsed.lastSyncSummary : '',
    // 本机推上去、服务端已受理的操作序号（重放时跳过它们，见 applyOneOp）
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
    // 第一次使用时生成设备 id 并落盘：opId 与日志里都靠它分辨来源，不能每次重开都变
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

/* 本机推上去、服务端已受理的操作序号。两处用到：
   - 重放时跳过它们：本机对这些路径的改动早就落盘了，再应用一遍只会把后来的内容冲掉
     （最典型的是「彻底删掉一个条目，又用它的 ID 新建」——那条删除会把自己新建的条目删掉）；
   - 拉取游标已经越过的就没必要留着：服务端不会再把它发下来。 */
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

// 还没推上去的操作。数组顺序即提交顺序，同路径的旧操作在入队时就被合并掉了。
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

/* 同一路径只保留最后一条待推送操作：中间过程没有意义（最终状态一样），
   少写几条日志，也避免同一次编辑产生一串重复操作。
   注意只合并「还在队列里」的那些：已经推上去的操作是服务端日志的一部分，不能撤销。 */
function mergeOutboxOp(list, op) {
  const next = list.filter((item) => item.path !== op.path);
  next.push(op);
  return next;
}

/* ---------------- 操作与哈希 ---------------- */

function hashBytes(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

// 内容看起来是不是 UTF-8 文本（笔记、JSON 都是文本；图片附件走 base64）
function isLikelyText(buffer) {
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString('utf8');
  return !decoded.includes('\uFFFD');
}

function makeOpId(deviceId) {
  opCounter += 1;
  return `${deviceId || 'dev'}-${Date.now().toString(36)}-${opCounter}`;
}

// 把本地文件的一刻状态变成一条 put 操作
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

/* 重放决策（纯函数，便于自测）：
   - keep-local：本地有一条更晚的、还没推上去的同路径改动，先保留它（它稍后推送会成为更新的一条操作）
   - skip：远端这条在这里什么也不用做（同样的内容，或删除的对象本来就不存在）
   - apply：写入或删除本地文件
   注意 del 在「本地不存在」时返回 skip —— 这正是「删除不会被当成缺失又补回来」的关键：
   重放删除只会删，永远不会反向产生一条 put。 */
function decideApply(op, { localNewerPending = false, localExists = false, localHash = '', opHash = '' } = {}) {
  if (localNewerPending) return 'keep-local';
  if (!op || (op.op !== 'put' && op.op !== 'del')) return 'skip';
  if (op.op === 'del') return localExists ? 'apply' : 'skip';
  if (localExists && opHash && localHash === opHash) return 'skip';
  return 'apply';
}

/* ---------------- 与服务端通信 ---------------- */

function describeHttpError(status) {
  if (status === 401) return '同步令牌不正确（服务端要求 Bearer 令牌）';
  if (status === 403) return '服务端拒绝访问';
  if (status === 404) return '接口不存在，请确认地址指向 EsprinServer 且版本一致';
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
    if (!parsed) return { ok: false, error: '服务器返回的不是 JSON，请确认地址指向 EsprinServer' };
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

/* ---------------- 推送（本地 → 服务端） ---------------- */

// 本地落盘/删除后排队：合并同一路径的连续改动，攒一小会儿一起推
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
  // 这一批里有没有删除被服务端收下：有的话回收池可能多了一个 ID，要叫界面补领
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
    // 服务端受理的序号记下来：重放时跳过这些操作（见 applyOneOp）
    rememberSelfPushed((result.data.accepted || [])
      .filter((item) => item && !item.error && Number(item.seq) > 0)
      .map((item) => Number(item.seq)));
    if (ops.some((op) => op.op === 'del' && accepted.has(op.opId))) freedIds = true;
    // 服务端没接受的（内容过大、路径不合法）也一并丢掉：留着重试也不会成功，
    // 反而会把队列堵死，挡住后面正常的操作
    const rejected = (result.data.accepted || []).filter((item) => item && item.error);
    if (rejected.length) {
      console.warn('[Esprin Nemo] 服务端拒绝了部分操作:', rejected.map((item) => item.error).join('；'));
    }
    writeOutbox(readOutbox().filter((op) => !accepted.has(op.opId)
      && !rejected.some((item) => item.opId === op.opId)));

    pushed += accepted.size;
    remaining = readOutbox().length;
    if (!accepted.size && !rejected.length) break; // 服务端没有进展，别再空转
  }

  lastError = '';
  // 刚推上去的删除把那个 ID 交回了服务端的回收池：叫界面补领一批可复用 ID
  if (freedIds) sendToRenderer('sync:pushed', { pushed, remaining });
  return { ok: true, pushed, remaining };
}

/* 可复用 ID：条目被删除后，它的 ID 会回到服务端的回收池（删除记录仍留着，别处的老副本不会被推回来）。
   新建条目时向服务端领几个来用——被删掉的那一条腾出来的 ID 会重新落到新建的条目上。
   服务端会把领走的 ID 占住一小会儿，所以两台设备同时新建也不会撞到同一个。 */
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
      // 只领「本机已经重放过那条删除」的 ID：否则新建好的条目会被自己还没拉到的删除擦掉
      since: state.lastSeq
    },
    timeoutMs: 8000
  });
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    ids: Array.isArray(result.data.ids) ? result.data.ids : [],
    // 池子里还有，只是本机的序号还没跟上：先同步一次再来领
    pending: Number(result.data.pending) || 0
  };
}

/* ---------------- 重放（服务端 → 本地） ---------------- */

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
      // 清理失败不影响错误上报
    }
    console.error('[Esprin Nemo] 重放写入失败:', file, error.message);
    return false;
  }
}

/* 应用一条远端操作。写盘/删除之外最重要的一件事是「什么都不做」：
   删除的对象本来就不存在时直接跳过——不产生任何上传动作，笔记因此不会被复活。 */
function applyOneOp(op, applied) {
  const relative = normalizeRelative(op && op.path);
  if (!relative || !op || (op.op !== 'put' && op.op !== 'del')) return;

  /* 本机自己推上去的操作不必再应用一遍：本地早就落盘了。
     彻底删掉一个条目、又用回收的 ID 新建之后，本机很可能还没拉到自己那条删除，
     重放它就会把刚新建的条目删掉——这条跳过就是为此。 */
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
      // 本地那条还没推上去的改动已被删除覆盖，丢掉它，免得又把文件写回来
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

/* ---------------- 文件日志（journal.log） ----------------

   服务端的全部数据就是那一份 append-only 的操作日志（见开头的模型说明）。这一节把日志当成
   「一份可以离线使用的普通文件」来处理，与服务端在不在线无关：

     * 导入（journal:import-file）：把日志重放到本地数据目录，等价于「以这份日志为准还原数据」——
       日志里写过的文件按内容还原，标记为删除的路径在本地同样删除，日志没提到的文件保持原样。
     * 转文件夹（journal:export-folder）：把日志的最终状态摊成一个目录树，不动本地数据目录。

   两件事都只读日志文件本身：不推进「已应用到第几号」，也不往待推送队列里塞任何东西，
   因此导入不会被当成一次同步，导出也不会把服务端已有的内容又推一遍回去。 */

// 读取上限：日志是文本，整份读进内存逐行解析，超过这个大小就直接说读不了
const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
// 同一份日志（路径、大小、修改时间都没变）只解析一次：
//「先看概览、再确认导入」会读两遍，第二次直接命中缓存
let parsedJournalCache = null;

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

/* 逐行解析日志。服务端写的是 JSON Lines，一行一条
   {seq, opId, device, time, op, path, data, encoding, hash}。
   这里只认「操作类型与路径都合法」的行；空行、被截断的半行、别处的 JSON 只计数不中断，
   一份被中途打断的日志因此仍然能导入它前面那些完整的操作。 */
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

/* 文件里的顺序就是序号顺序（服务端只会往后追加）。只有每一行都带序号时才按序号重排，
   这样两段日志（例如手工拼接的两份备份）也能按正确的次序重放。 */
function orderJournalEntries(entries) {
  const list = entries.slice();
  if (!list.length || list.some((entry) => !(entry.seq > 0))) return list;
  return list.sort((a, b) => a.seq - b.seq);
}

// 重放到底时每个路径是什么：同一路径后出现的操作覆盖先前的，del 表示这条路最终不存在
function journalFinalState(entries) {
  const final = new Map();
  for (const entry of entries) {
    if (entry.op === 'del') final.delete(entry.path);
    else final.set(entry.path, entry);
  }
  return final;
}

// 读取并解析一份日志；结果按「路径 + 大小 + 修改时间」缓存一份
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

// 概览：先看清楚要导入 / 导出的是什么，再决定动不动手
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
    // 只回一份预览：日志可能有几千个路径，界面不需要完整清单
    samplePaths: [...final.keys()].sort().slice(0, 12),
    devices: parsed.devices,
    cached: parsed.cached
  };
}

/* 逐条重放：put 原子写入（临时文件 + rename），del 删文件。
   本地本来就不存在的删除只记一次「跳过」——与同步重放同一条规矩：删除不会反过来产生写入。 */
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

// 导入：把日志重放到本地数据目录（调用方在收到结果后重新载入界面数据）
function importJournalFile(payload = {}) {
  const parsed = readJournalFile(payload.filePath);
  if (!parsed.ok) return parsed;

  const root = resolveDataDir();
  if (!root) return { ok: false, error: '数据目录不可用，无法导入' };

  const entries = orderJournalEntries(parsed.entries);
  const applied = applyJournalEntries(entries, root);
  // 解析结果用完就放：导入可能刚把整份日志读进过内存
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

// 路径是否落在某个目录内（含自身）：用于拒绝把导出目标放进数据目录
function isSameOrInside(target, parent) {
  if (!target || !parent) return false;
  const normalize = (value) => {
    const resolved = path.resolve(String(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const child = normalize(target);
  const root = normalize(parent);
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

// 转文件夹：把日志的最终状态按相对路径原样摊到目标目录下，不碰本地数据目录
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
  // 解析结果用完就放：导出可能刚把整份日志读进过内存
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

/* 拉取前先对一次「服务端日志身份」。
   服务端换了数据目录、或日志被清空重建时，seq 会从头开始；客户端若还拿着旧的
   「已应用到第几号」，就会一直从那个号码往后拉——服务端最新序号比它还小，于是永远拉到空，
   表现就是「什么都同步不了」（推送却是通的，所以很容易看错方向）。
   对不上就把序号归零、下一轮全量重放。 */
async function ensureJournalIdentity() {
  const health = await apiRequest('GET', `${SYNC_PATH}/health`, { timeoutMs: 8000 });
  if (!health.ok) return { ok: false, error: health.error };

  const remoteId = String(health.data.journalId || '');
  const remoteLatest = Number(health.data.latestSeq) || 0;
  const state = currentState({ reload: true });

  const idChanged = !!remoteId && remoteId !== state.journalId;
  // 服务端没给身份（旧版服务端）时的兜底：序号比本机还小，说明日志被重置过
  const seqRewound = !idChanged && remoteLatest < state.lastSeq;

  if (idChanged || seqRewound) {
    // 换了日志（序号另起一套）：自推的旧序号跟着作废
    saveState({ journalId: remoteId, lastSeq: 0, selfPushed: [] });
    console.warn('[Esprin Nemo] 服务端日志已更换，同步序号已归零，将重新全量重放');
    return { ok: true, reset: true, remoteId };
  }

  if (remoteId && !state.journalId) saveState({ journalId: remoteId });
  return { ok: true, reset: false, remoteId };
}

/* 拉取并重放：从 lastSeq 之后逐页取，每条都推进 lastSeq（跳过的不必再取一遍） */
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
      // 游标已经越过这些操作：服务端不会再发下来，自推记录可以丢掉
      selfPushed: (state.selfPushed || []).filter((seq) => seq > since)
    });
    if (!ops.length || !result.data.hasMore) break;
  }

  return { ok: true, applied, lastSeq: state.lastSeq };
}

/* ---------------- 同步动作 ---------------- */

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

/* 一次完整同步：先拉（把远端的操作重放到本地）再推（把本地改动送上去）。
   顺序很重要：先推的话，本地基于旧版本的改动会抢先进入全局序列，把远端更新的内容盖掉。 */
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

    // 日志被换过时全量重放一遍（序号刚归零，full 与常规拉取等价，这里显式表达意图）
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

    // 本地文件被远端操作改过（或删过）时要通知界面重新载入
    const changed = pulled.applied.filter((item) => item.action === 'written' || item.action === 'deleted');
    if (changed.length) {
      sendToRenderer('sync:applied', {
        summary,
        count: changed.length,
        applied: changed.slice(0, 20)
      });
    }

    return {
      ok: true,
      reason,
      summary,
      lastSeq: state.lastSeq,
      lastSyncAt: state.lastSyncAt,
      // 服务端日志被换过、刚做过一次全量重放
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

// 数据目录里现有的文件（相对路径 → 大小）：只在「首次导入」时扫一次
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
      // 单个文件读不到就跳过
    }
  }
  return files;
}

/* 首次接入：先把服务端日志全部重放到本地（以服务端为准），
   再把「服务端从未见过」的本地文件推上去。
   判断「见过」用的是服务端的 state：现存文件在 files 里，历史上被删过的在 deleted 里——
   后者同样算「见过」，所以本地那份陈旧的副本不会被重新导入。 */
async function importLocal({ sender = null } = {}) {
  const config = readSyncConfig();
  const checked = validateConfig(config);
  if (checked.error) return { ok: false, error: checked.error };

  // 先把日志身份对上（会顺带把序号归零），再全量重放
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

/* ---------------- 状态与定时 ---------------- */

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
    // 只要启用且地址、令牌齐全，每次启动应用都会同步一次：与「自动同步」选了什么无关
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

/* 按当前配置重建自动同步的定时器（启动时、设置变更后各调一次）。两件事互相独立：
   - 启动同步：只要同步开着、地址与令牌齐全，每次应用启动都同步一次——与「自动同步」选了什么
     无关（启动时正是本机最可能落后的时候）。设置变更也会走这里，所以用 startupSyncScheduled
     保证每轮启动只排一次，改间隔 / 改地址不会顺带多同步几次。
   - 定时同步：按用户选的间隔反复执行。 */
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

/* ---------------- 诊断 ---------------- */

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

      /* 本地与服务端的差异：这两行能一眼看出「还没做首次接入」与「序号对不对得上」。
         序号错位（本机比服务端大）是最隐蔽的一种——推送照常成功，拉取却永远为空 */
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

    /* 计划预览：把「接下来会做什么」算出来。这里只读远端日志，不动本地文件。
       重点是确认删除会被照实重放，而不是被当成「缺失」补回来。 */
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

/* ---------------- IPC ---------------- */

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

  // 测试连接：健康检查不需要令牌，用它区分「地址不对」与「令牌不对」
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
          ? '能连上服务器，但需要访问令牌：请在下面填写令牌后重试'
          : stateResult.error
      };
    }

    return {
      ok: true,
      server: health.data.name || 'EsprinServer',
      version: health.data.version || 1,
      latestSeq: stateResult.data.latestSeq || 0,
      fileCount: Object.keys(stateResult.data.files || {}).length,
      deletedCount: Object.keys(stateResult.data.deleted || {}).length,
      authRequired: !!health.data.authRequired
    };
  });

  ipcMain.handle('sync:now', () => syncNow({ reason: '手动' }));

  // 新建条目时领可复用的 ID：被删掉的条目腾出来的 ID 会重新用起来
  ipcMain.handle('sync:claim-ids', (event, payload) => claimRecycledIds(payload || {}));

  // 首次接入：先把服务端日志重放到本地，再把本地独有的文件推上去
  ipcMain.handle('sync:import-local', (event) => importLocal({ sender: event.sender }));

  // 设置变更（地址、令牌、间隔、开关）后重建定时器
  ipcMain.handle('sync:apply-auto-sync', () => {
    applyAutoSyncRuntime();
    return syncStatus();
  });

  ipcMain.handle('sync:diagnose', () => diagnose());

  // 渲染进程的写穿通知：某个文件刚落盘 / 刚被本地删除（只发路径，其余在本地读）
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

/* ---------------- 文件日志的 IPC ----------------

   两个选择框都从主进程弹出（渲染进程拿不到任意路径的读写权），
   读取与写盘也都在主进程：日志里可能含 config.json 这类敏感内容，路径与内容不必回传渲染进程。 */

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

  // 概览：看清要导入 / 导出的是什么，此时还不动任何文件
  ipcMain.handle('journal:inspect', (event, payload) => inspectJournal(payload && payload.filePath));

  // 导入：把日志重放到本地数据目录（渲染进程收到结果后会重新载入界面数据）
  ipcMain.handle('journal:import-file', (event, payload) => importJournalFile(payload || {}));

  // 转文件夹：把日志的最终状态摊成一个目录树，导出成功后在文件管理器里打开它
  ipcMain.handle('journal:export-folder', (event, payload) => {
    const result = exportJournalToFolder(payload || {});
    if (result.ok && shell) {
      try {
        Promise.resolve(shell.openPath(result.targetDir)).catch(() => {});
      } catch (error) {
        // 打不开文件夹不影响导出结果：状态行里已经写了导出到哪儿
      }
    }
    return result;
  });
}

module.exports = {
  configureSyncServer,
  registerSyncIpc,
  applyAutoSyncRuntime,
  // 供自测使用（纯逻辑，不依赖 electron 与磁盘）
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
