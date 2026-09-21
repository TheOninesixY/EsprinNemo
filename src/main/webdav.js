// WebDAV 同步（主进程）：把数据目录里的笔记、待办、对话与配置与 WebDAV 服务器上的
// 一份副本做备份（上传）、恢复（下载）或双向同步。
//
// 渲染进程只提交「测试连接 / 上传 / 下载 / 同步」四类动作：服务器地址、账号与远程目录
// 由主进程从 config.json 读取，口令由系统密钥链单独保管（见 secret_store.js），
// 因此口令既不落在配置文件里，也不经过 IPC 往返，页面脚本拿不到明文。
//
// 只用 Node 自带的 fetch 与 WebDAV 的四个基础方法（PROPFIND / MKCOL / PUT / GET），
// 不引入额外依赖，适配坚果云、Nextcloud、群晖、Alist 等常见服务。
//
// 同步规则：以「体积 + 修改时间」判断文件是否一致（低于 2 秒的差异视为同一时刻，
// 因为服务器的 getlastmodified 只精确到秒），双向同步时较新的一方覆盖较旧的一方；
// 无论哪个方向都不会删除另一侧多出来的文件——删除传播一旦误判就是不可逆的数据丢失。
const { app, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { getConfigDir, isDevRun } = require('./data_path.js');
const { createSecretStore } = require('./secret_store.js');

// 目录列举与连接测试属于轻量请求，传输单个文件可能很慢（图片附件）
const PROPFIND_TIMEOUT_MS = 30000;
const TRANSFER_TIMEOUT_MS = 180000;

// 修改时间比对容差：WebDAV 的 getlastmodified 精确到秒，本地时间戳带毫秒
const MTIME_TOLERANCE_MS = 2000;
// 失败明细最多回报多少条（其余只计数），避免一次同步的返回体过长
const MAX_REPORTED_FAILURES = 20;
// 远程目录名：默认在服务器上单独占一个目录，不与服务器上的其他内容混在一起
const DEFAULT_REMOTE_DIR = 'EsprinNemo';
// 可写性诊断用的临时目录名前缀（建完就删，只在创建远程目录失败时出现）
const PROBE_DIR_PREFIX = '__esprin_nemo_write_test_';

// 同步方向：upload（本地 → 服务器）/ download（服务器 → 本地）/ both（较新的一方胜出）
const SYNC_MODES = ['upload', 'download', 'both'];

/* 两种使用方式：
   sync    —— 同步模式（默认）：本地数据目录是主副本，用户点按钮才与服务器交换文件；
   storage —— 使用模式：服务器是主储存源，本地数据目录只是它的缓存 */
const STORAGE_MODE = 'storage';
// 使用模式：同一文件连续保存时的上传合并窗口（编辑器自动保存很频繁）
const PUSH_DEBOUNCE_MS = 700;
// 使用模式：自动对齐的间隔（写穿是即时的，这个定时器负责把别的设备改过的内容拉回来）
const STORAGE_AUTO_SYNC_MS = 5 * 60 * 1000;
// 首次自动同步的延迟：错开启动高峰（两种模式共用）
const AUTO_FIRST_SYNC_DELAY_MS = 3000;

/* 同步模式下的自动双向同步：off 关闭；startup 只在每次启动应用时同步一次；
   其余为预设间隔；custom 用用户在设置里填的秒数（见 autoSyncSeconds）。 */
const AUTO_SYNC_PRESETS = {
  off: 0,
  '5s': 5,
  '1m': 60,
  '5m': 300,
  startup: 0
};
const AUTO_SYNC_VALUES = Object.keys(AUTO_SYNC_PRESETS).concat('custom');
const AUTO_SYNC_MIN_SECONDS = 5;
const AUTO_SYNC_MAX_SECONDS = 24 * 60 * 60;
const AUTO_SYNC_DEFAULT_SECONDS = 60;

// 口令的读写交给通用密钥存储：与 AI Key 同一套加密与退化策略，另用一份文件
const store = createSecretStore({
  header: 'esprin-nemo-webdav/1',
  fileName: 'webdav_pwd.bin',
  devFileName: 'webdav_pwd.dev.bin',
  label: 'WebDAV 口令'
});

/* 同步状态文件：记下上一次同步之后两侧各自的体积、修改时间与 ETag。

   为什么不能只比修改时间：不少服务器（Alist 等）对 PROPFIND 的 getlastmodified 给零值，
   远端时间恒为 0，双向同步就会永远判成「本地更新」，表现为只能上传、永远不会下载。
   有了这份记录就能反过来问：自上次同步以来，到底哪一侧变过？

   文件放在配置目录（与密钥文件同级）而不是数据目录里：它是「这台机器与这个远端目录」的
   同步状态，跟着用户走，也不应该被自己同步上去。 */
const STATE_FILE_NAME = 'webdav_state.json';
const DEV_STATE_FILE_NAME = 'webdav_state.dev.json';
/* 版本 2：早期版本记的是「同步前」的状态（下载/上传之后的错位），
   会让本地被误判成「变过」，因此升版号让它自动失效、按首次同步重建基线 */
const STATE_FILE_VERSION = 2;

let ipcRegistered = false;
// 同一时刻只允许一个同步任务：两次并发同步会在同一批文件上互相覆盖
let running = false;

// 由 main.js 注入：当前数据目录、读取配置（config.json），以及向主窗口推送消息的通道
let resolveDataDir = () => '';
let readUserConfig = () => ({});
let sendToRenderer = () => {};

function configureWebdavSync({ getDataDir, getConfig, onRendererMessage } = {}) {
  if (typeof getDataDir === 'function') resolveDataDir = getDataDir;
  if (typeof getConfig === 'function') readUserConfig = getConfig;
  if (typeof onRendererMessage === 'function') sendToRenderer = onRendererMessage;
}

/* ---------------- 配置 ---------------- */

// 远程目录：逐段去掉首尾斜杠与 . / ..，避免拼出跑到目标之外的路径；留空时用默认目录名
function normalizeRemoteDir(value) {
  const segments = String(value == null ? '' : value)
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  return segments.join('/') || DEFAULT_REMOTE_DIR;
}

// 服务器地址：只接受 http(s)，统一按目录处理（末尾补斜杠，写不写都由用户）
function normalizeBaseUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return '';
  return text.endsWith('/') ? text : `${text}/`;
}

function readWebdavConfig() {
  const config = readUserConfig();
  const source = config && typeof config === 'object' && config.webdav && typeof config.webdav === 'object'
    ? config.webdav
    : {};
  return {
    // 总开关：旧配置里没有该字段时视为开启（填写了地址即视为要用）
    enabled: source.enabled !== false,
    // 使用方式：sync（同步模式）/ storage（使用模式，WebDAV 就是储存源）
    mode: source.mode === STORAGE_MODE ? STORAGE_MODE : 'sync',
    url: typeof source.url === 'string' ? source.url.trim() : '',
    username: typeof source.username === 'string' ? source.username.trim() : '',
    remoteDir: normalizeRemoteDir(source.remoteDir),
    // 同步模式下的自动双向同步：关闭 / 每 5 秒 / 每 1 分钟 / 每 5 分钟 / 每次启动应用时 / 自定义
    autoSync: AUTO_SYNC_VALUES.includes(source.autoSync) ? source.autoSync : 'off',
    autoSyncSeconds: clampAutoSyncSeconds(source.autoSyncSeconds)
  };
}

// 自定义同步间隔的取值整理：非数字回落到 1 分钟，夹在 5 秒 ~ 24 小时之间
function clampAutoSyncSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return AUTO_SYNC_DEFAULT_SECONDS;
  return Math.min(Math.max(Math.round(num), AUTO_SYNC_MIN_SECONDS), AUTO_SYNC_MAX_SECONDS);
}

// 自动同步的间隔（毫秒）：0 表示不定时（关闭，或只按「每次启动应用时」）
function autoSyncIntervalMs(config) {
  if (config.autoSync === 'custom') return clampAutoSyncSeconds(config.autoSyncSeconds) * 1000;
  const seconds = AUTO_SYNC_PRESETS[config.autoSync];
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

// 口令保管状态：hasPassword 是否已保存，encrypted 磁盘上是否加密存放，strong 是否为系统密钥链级加密
function passwordStatus() {
  const status = store.status();
  return {
    hasPassword: status.hasKey,
    encrypted: status.encrypted,
    strong: status.strong,
    path: status.path
  };
}

/* ---------------- 请求 ---------------- */

// Basic 鉴权头：没填账号时不发 Authorization（有些服务器允许匿名只读）
function authHeaders(config) {
  if (!config.username) return {};
  const token = Buffer.from(`${config.username}:${store.read()}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${token}` };
}

/* 服务器地址 + 相对路径 → 完整 URL。relativePath 是「从服务器地址往下算」的路径
   （远程目录名也在其中），由本模块自己拼出来的目录段逐个做百分号编码，
   服务器地址本身原样保留。
   collection 为 true 时末尾带一个斜杠，用于 PROPFIND——探测与列举的是「目录」本身，
   少这个斜杠时不少服务器（Apache、Nextcloud 等）会先回一个 301。
   注意 MKCOL 不能用这种带尾斜杠的写法：服务器会把它理解成「在 dir/ 里创建一个无名资源」，
   父集合不存在，于是回 409（Apache mod_dav、Alist、群晖等都是这个行为）。 */
function serverUrl(relativePath, { collection = false } = {}) {
  const base = normalizeBaseUrl(readWebdavConfig().url);
  if (!base) return '';
  const segments = String(relativePath || '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const url = base + segments.map(encodeURIComponent).join('/');
  // 地址本身已经以斜杠结尾时不再补一个，免得拼出 https://host/dav//
  if (!collection || url.endsWith('/')) return url;
  return `${url}/`;
}

/* 数据目录内的相对路径 → 它在服务器上的路径（远程目录名是它的根前缀）。
   多层远程目录（a/b）同样按段处理，因此每一段都会各自编码。
   注意这里不能把已经带远程目录的路径再传进来——那会拼成 EsprinNemo/EsprinNemo。 */
function remoteDirServerPath(relativeInDataDir = '') {
  return [normalizeRemoteDir(readWebdavConfig().remoteDir), String(relativeInDataDir || '')]
    .filter(Boolean)
    .join('/');
}

// 数据目录内相对路径 → URL；传 '' 就是远程目录本身
function remoteUrl(relativePath, options) {
  return serverUrl(remoteDirServerPath(relativePath), options);
}

function describeStatus(status) {
  if (status === 401) return '账号或口令不正确（服务器要求登录）';
  if (status === 403) return '服务器拒绝访问：该账号没有此目录的读写权限';
  if (status === 404) return '服务器上找不到该路径';
  if (status === 405) return '服务器不支持该操作，可能不是标准的 WebDAV 服务';
  if (status === 409) return '远程目录不存在或路径冲突';
  if (status === 423) return '远程文件被锁定，请稍后重试';
  if (status === 507) return '服务器存储空间不足';
  if (status >= 500) return 'WebDAV 服务器返回错误';
  return `请求失败（HTTP ${status}）`;
}

function describeNetworkError(error) {
  const message = error && error.message ? String(error.message) : '';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return '无法解析服务器域名，请检查地址与网络';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) return '无法连接到服务器，请确认地址、端口与服务是否可用';
  if (/certificate|SSL|TLS|self-signed/i.test(message)) return 'TLS 证书校验失败，请检查服务器地址与证书';
  return message ? `请求失败：${message}` : '请求失败：无法连接到服务器';
}

/* 一次 WebDAV 请求：返回 { ok, status, response, error }。
   fetch 对 PROPFIND / MKCOL 这类方法不做限制，直接交给它即可。 */
async function davRequest(method, url, { body, headers = {}, depth = '', timeoutMs = PROPFIND_TIMEOUT_MS } = {}) {
  const config = readWebdavConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...authHeaders(config),
        ...(depth ? { Depth: depth } : {}),
        ...headers
      },
      body,
      signal: controller.signal,
      redirect: 'follow'
    });
    return { ok: response.ok, status: response.status, response, error: '' };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      response: null,
      error: aborted ? `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）` : describeNetworkError(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<D:propfind xmlns:D="DAV:"><D:prop>'
  + '<D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:getetag/>'
  + '</D:prop></D:propfind>';

/* ---------------- 远程目录与列举 ----------------
   这里的两种路径概念必须分清，否则很容易把远程目录名拼两遍：
     serverPath —— 从「服务器地址」往下算的路径（远程目录名也在其中），对应 serverUrl
     remotePath —— 从「远程目录」往下算的路径（即数据目录内的相对路径），对应 remoteUrl */

// 探测服务器上某个路径（相对服务器地址）是不是已存在的集合：207 即存在，404 即不存在（其余状态原样带出）
async function probeServerPath(serverPath) {
  const result = await davRequest('PROPFIND', serverUrl(serverPath, { collection: true }), {
    depth: '0',
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY
  });
  if (result.ok) return { exists: true };
  if (result.status === 404) return { exists: false };
  return { exists: false, status: result.status, error: result.error || describeStatus(result.status) };
}

// 服务器地址本身是否可用：地址里的目录必须已经在服务器上（坚果云的 /dav/、Nextcloud 的 /remote.php/dav/files/<用户>/ 等）
async function probeBaseUrl() {
  const url = serverUrl('', { collection: true });
  if (!url) return { exists: false, error: '尚未填写服务器地址' };

  const result = await davRequest('PROPFIND', url, {
    depth: '0',
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY
  });
  if (result.ok) return { exists: true };

  const reason = result.status ? `HTTP ${result.status}` : '网络错误';
  return {
    exists: false,
    status: result.status,
    error: `另外，服务器地址本身也没能访问（${reason}）：${result.error || describeStatus(result.status)}`
      + '，请确认地址指向服务器上一个已存在的目录'
  };
}

// 创建失败时把原因说清楚：带上实际请求的完整地址与 HTTP 状态，可以直接拿去浏览器 / 客户端里复核
function describeCreateFailure(url, result) {
  const status = result.status;
  const suffix = status ? `（HTTP ${status}）` : '';
  if (status === 409) {
    return `无法创建远程目录 ${url}${suffix}：服务器拒绝在该位置创建，常见原因是上级目录不存在`
      + '（服务器地址里的路径必须已经在服务器上）或该账号没有写入权限';
  }
  if (status === 401 || status === 403) return `无法创建远程目录 ${url}${suffix}：${describeStatus(status)}`;
  return `无法创建远程目录 ${url}${suffix}：${result.error || describeStatus(status)}`;
}

/* 服务器地址那一层是否可写：试着建一个随机名的临时目录再删掉。
   只在创建远程目录失败时用于诊断——“地址本身不可写”与“路径拼错”是两种完全不同的原因，
   单看 409 分不出来。Alist 这类多存储的 WebDAV 就是这样：根路径 /dav/ 能列举、不能建目录，
   必须把地址写到具体的存储挂载路径下（例如 http://127.0.0.1:5244/dav/ali/）。 */
async function probeBaseWritable() {
  const name = `${PROBE_DIR_PREFIX}${Math.random().toString(36).slice(2, 8)}`;
  const created = await davRequest('MKCOL', serverUrl(name));

  if (!created.ok) {
    const reason = created.status ? `HTTP ${created.status}` : '网络错误';
    return {
      writable: false,
      status: created.status,
      error: `服务器地址这一层不可写（${reason}）：请把地址改到服务器上一个可写的目录`
        + '；用 Alist 这类多存储服务时，要写到具体的存储挂载路径下（例如 http://127.0.0.1:5244/dav/ali/），'
        + '根路径 /dav/ 只能列举、不能创建目录'
    };
  }

  // 诊断用的临时目录用完就删（删不掉也不影响判断，留着也只是个空目录）
  await davRequest('DELETE', serverUrl(name));
  return { writable: true };
}

/* 确保服务器上某个路径（相对服务器地址）对应的集合存在：先探测，不存在才创建，创建完再回查一次。
   不同服务器对「目录已存在」的 MKCOL 响应各不相同（405 / 301 / 409 都有），
   因此只有回查确认确实不存在才算失败。
   MKCOL 的 URL 不带尾斜杠：带尾斜杠时服务器会把它理解成「在 dir/ 里创建一个无名资源」而回 409。 */
async function ensureCollection(serverPath) {
  const probe = await probeServerPath(serverPath);
  if (probe.exists) return { ok: true };

  const url = serverUrl(serverPath);
  const created = await davRequest('MKCOL', url);
  if (created.ok || created.status === 405) return { ok: true };

  const verify = await probeServerPath(serverPath);
  if (verify.exists) return { ok: true };

  return { ok: false, status: created.status, error: describeCreateFailure(url, created) };
}

// 逐段创建远程目录（远程目录写成多层时（a/b）也按段处理）
async function ensureRemoteDir() {
  const segments = remoteDirServerPath().split('/').filter(Boolean);
  let current = '';

  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const ensured = await ensureCollection(current);
    if (ensured.ok) continue;

    // 第一段就建不出来时，依次查两件事：服务器地址本身在不在、地址这一层能不能写。
    // “地址里的目录其实不存在”与“地址本身不可写”（Alist 的 /dav/ 根就是这样）是最常见的两种原因，
    // 直接说清比让用户对着 409 猜好
    if (!current.includes('/')) {
      const base = await probeBaseUrl();
      if (!base.exists) return { ok: false, error: `${ensured.error}；${base.error}` };

      const writable = await probeBaseWritable();
      if (!writable.writable) return { ok: false, error: `${ensured.error}；${writable.error}` };
    }
    return { ok: false, error: ensured.error };
  }
  return { ok: true };
}

// 远程目录名（多层写法取最后一段）：href 的前缀和我们的写法不一致时用它定位
function remoteDirName() {
  const segments = normalizeRemoteDir(readWebdavConfig().remoteDir).split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

function decodePathText(text) {
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return '';
  }
}

/* 从 href 里取出相对远程目录的路径。
   href 有完整 URL、绝对路径、相对路径三种写法，前缀也可能和我们请求的写法不同
   （个别服务器返回的路径少了 base 那一段）。因此不能死比字符串前缀：
   先按前缀切，切不动再按「远程目录名在路径中的位置」定位——列举结果为空会让同步
   变成「只能上传、永不下载」，这一步值得多兜一层。 */
function relativeFromHref(href, encodedDirPath) {
  let target = String(href || '').trim();
  if (!target) return '';

  if (/^https?:\/\//i.test(target)) {
    try {
      target = new URL(target).pathname;
    } catch (error) {
      return '';
    }
  }

  // 相对路径：相对的就是当前被列举的这个目录
  if (!target.startsWith('/')) return decodePathText(target).replace(/\/+$/, '');

  const prefix = encodedDirPath.endsWith('/') ? encodedDirPath : `${encodedDirPath}/`;
  if (target.startsWith(prefix)) return decodePathText(target.slice(prefix.length)).replace(/\/+$/, '');

  // 兜底：按远程目录名定位，且只认「目录名之后紧跟着 /」的位置，避免命中同名前缀的别的目录
  const name = remoteDirName();
  if (name) {
    const marker = `/${encodeURIComponent(name)}`;
    const index = target.lastIndexOf(marker);
    if (index >= 0) {
      const rest = target.slice(index + marker.length);
      if (rest.startsWith('/')) return decodePathText(rest.slice(1)).replace(/\/+$/, '');
    }
  }
  return '';
}

function pickTag(block, tag) {
  const matched = block.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'));
  return matched ? decodeXmlText(matched[1].trim()) : '';
}

function decodeXmlText(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (all, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function parseHttpDate(value) {
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : 0;
}

/* 解析多状态响应（207）：按 <D:response> 分段取 href / resourcetype / 体积 / 修改时间。
   这里不引 XML 依赖，只认这三种字段——命名空间前缀各服务端写法不一（d: / D: / lp1:），
   因此标签一律写成「可选前缀 + 本地名」。 */
function parseMultiStatus(xml, encodedDirPath) {
  const blocks = String(xml).match(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi) || [];
  return blocks.map((block) => {
    const href = pickTag(block, 'href');
    return {
      path: relativeFromHref(href, encodedDirPath),
      /* 是不是集合（目录）：resourcetype 里带 collection 标签，或 href 以斜杠结尾。
         注意 collection 标签上可能带属性（`<D:collection xmlns:D="DAV:"/>`，Go 的 x/net/webdav
         就是这么写的），所以不能要求标签后紧跟 `/` 或 `>`——写成那样会让目录被当成文件，
         后果是从不递归进子目录、远端文件永远不在列表里，表现就是只能上传、永不下载。 */
      isCollection: /<(?:\w+:)?collection[\s/>]/i.test(block) || /\/$/.test(href.trim()),
      size: Number(pickTag(block, 'getcontentlength')) || 0,
      mtimeMs: parseHttpDate(pickTag(block, 'getlastmodified')),
      // ETag：服务器不给修改时间时，它是判断「远端这份变没变」的第二手依据
      etag: pickTag(block, 'getetag')
    };
  }).filter((entry) => !!entry.path);
}


/* 递归列出远程目录下的文件：返回 { ok, files }，files 为 相对路径 → { size, mtimeMs }。
   远程目录还不存在（404）时按「空目录」处理，交由调用方先创建。
   encodedDirPath 是远程目录自身的（已编码）路径，用来把 href 折成相对路径。 */
async function listRemoteDir(encodedDirPath, relativePrefix = '', files = new Map()) {
  const result = await davRequest('PROPFIND', remoteUrl(relativePrefix, { collection: true }), {
    depth: '1',
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY
  });

  if (result.status === 404) return { ok: true, files };
  if (!result.ok) {
    return { ok: false, files, error: result.error || describeStatus(result.status) };
  }

  const xml = await result.response.text().catch(() => '');
  const entries = parseMultiStatus(xml, encodedDirPath);

  for (const entry of entries) {
    // 目录列举结果里第一条通常是目录自身，relativeFromHref 已把它折成空路径，跳过
    if (entry.path === relativePrefix) continue;
    if (entry.isCollection) {
      const nested = await listRemoteDir(encodedDirPath, entry.path, files);
      if (!nested.ok) return nested;
      continue;
    }
    files.set(entry.path, {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      etag: entry.etag,
      /* 服务器到底给没给这部文件的元数据：x/net/webdav 系（Alist 等）会把不支持的属性
         放进 404 的 propstat 里，值读出来就是 0——这种「看起来永远没变」的元数据不能用来
         判断远端变没变，否则表现就是只能上传、永不下载。 */
      metaKnown: entry.size > 0 || entry.mtimeMs > 0 || !!entry.etag
    });
  }
  return { ok: true, files };
}

/* 远程目录在服务器上的（已编码）路径：从 href 里折相对路径时用它做前缀比较。
   这里刻意不解码——href 本身就是百分号编码的写法，两边保持一致才能比得上。 */
function remoteDirUrlPath() {
  const url = remoteUrl('');
  if (!url) return '';
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch (error) {
    return '';
  }
}

/* ---------------- 本地文件 ---------------- */

// 原子写入留下的临时文件不进同步：它可能正是上次中断的残留
function isIgnorableFile(name) {
  return name.endsWith('.tmp');
}

function scanLocalDir(dir, prefix = '', files = new Map()) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    console.error('[Esprin Nemo] 读取本地数据目录失败:', error);
    return files;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      scanLocalDir(full, relative, files);
      continue;
    }
    if (!entry.isFile() || isIgnorableFile(entry.name)) continue;
    try {
      const stat = fs.statSync(full);
      files.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      // 单个文件读不到（被占用/刚被删）时跳过，不影响其余文件
    }
  }
  return files;
}

// 把本地文件的修改时间对齐到某个时刻：两侧的比对基准一致，反复同步时才不会来回来去地「重传同一份内容」
function applyLocalMtime(relativePath, stamp) {
  if (!Number.isFinite(stamp) || !stamp) return;
  try {
    const when = new Date(stamp);
    fs.utimesSync(path.join(resolveDataDir(), ...relativePath.split('/')), when, when);
  } catch (error) {
    // 修改时间只用于比对，设置失败不影响同步结果
  }
}

function writeLocalFile(relativePath, buffer, stamp) {
  const target = path.join(resolveDataDir(), ...relativePath.split('/'));
  const tempPath = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, target);
    applyLocalMtime(relativePath, stamp);
    return { ok: true };
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      // 清理失败不影响错误上报
    }
    return { ok: false, error: error.message };
  }
}

/* ---------------- 同步状态（判断「哪一侧变过」） ---------------- */

function stateFilePath() {
  const dir = getConfigDir(app);
  if (!dir) return null;
  return path.join(dir, isDevRun(app) ? DEV_STATE_FILE_NAME : STATE_FILE_NAME);
}

// 状态按「服务器地址 + 远程目录」区分：换了目标就从头来过，免得拿旧记录去判断新服务器上的文件
function syncStateKey() {
  const config = readWebdavConfig();
  return `${normalizeBaseUrl(config.url)}|${config.remoteDir}`;
}

// 读取上一次同步留下的记录；文件不存在、版本不符或目标变了都当作没有记录
function readSyncState() {
  const key = syncStateKey();
  const file = stateFilePath();
  if (!file || !fs.existsSync(file)) return { key, files: {} };

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== STATE_FILE_VERSION || parsed.key !== key) return { key, files: {} };
    const files = parsed.files && typeof parsed.files === 'object' ? parsed.files : {};
    return { key, files };
  } catch (error) {
    console.warn('[Esprin Nemo] 读取 WebDAV 同步状态失败，将按首次同步处理:', error.message);
    return { key, files: {} };
  }
}

// 写回状态：内容没变就不写盘（自动同步可能每隔几秒跑一次）
let lastWrittenStateText = '';

function writeSyncState(state) {
  const file = stateFilePath();
  if (!file) return false;

  try {
    const text = JSON.stringify({ version: STATE_FILE_VERSION, key: state.key, files: state.files }, null, 2);
    if (text === lastWrittenStateText) return true;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
    lastWrittenStateText = text;
    return true;
  } catch (error) {
    console.warn('[Esprin Nemo] 写入 WebDAV 同步状态失败:', error.message);
    return false;
  }
}

/* 同步完成后重建记录：只记「两侧都存在」的文件——它们此时内容相同（同步过，或本来就一致）。

   关键点：记录必须反映同步「之后」的状态，因此本地一侧一律重新 stat 一次。
   下载会覆盖本地内容、上传后还可能按服务器时间对齐过 mtime，用同步前那轮扫描的值会错位，
   错位又会让下一次同步把「其实没变」误判成「变了」，进而永远只上传不下载。

   远端那一侧只有列举时读到的值：
   - 本轮没上传过（远端内容就是我们读到的那份）→ 直接记它的体积、时间与 ETag；
   - 本轮上传过（远端内容已被我们改写）→ 体积按本地，时间与 ETag 记为未知（0 / 空），
     下一次判断时就不会把我们自己的上传误判成「远端被别处改了」。 */
function statLocalFile(relative) {
  try {
    const stat = fs.statSync(path.join(resolveDataDir(), ...relative.split('/')));
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    return null;
  }
}

function buildSyncState(previous, localFiles, remoteFiles, uploadedPaths, failedPaths, conflictPaths) {
  const files = {};
  for (const relative of new Set([...localFiles.keys(), ...remoteFiles.keys()])) {
    if (failedPaths.has(relative)) {
      if (previous.files[relative]) files[relative] = previous.files[relative];
      continue;
    }
    /* 冲突未处理的文件也不记：下次同步仍是「没有记录」→ 继续报出来，
       不会因为一次「已记录」而静默地永不同步 */
    if (conflictPaths.has(relative)) continue;

    const remote = remoteFiles.get(relative);
    if (!remote) continue;
    const local = statLocalFile(relative);
    if (!local) continue;

    /* 冲突（两侧都改过、判断不出方向）的文件同样要记录。
       不记的话它会永远停在「无记录」状态，每次都判成两侧都变了，永远无法自动收敛——
       这正是「只能上传、永不下载」最难缠的一种成因。
       记下来并带上 c 标记：本地一侧自此有了基线，远端一旦再变就能自动下载；
       而 c 标记会让结果里继续把这几份文件报出来，直到你手动定过方向。 */
    if (conflictPaths.has(relative)) {
      files[relative] = {
        ls: local.size,
        lm: local.mtimeMs,
        rs: remote.size,
        rm: remote.mtimeMs || 0,
        re: remote.etag || '',
        c: 1
      };
      continue;
    }

    if (uploadedPaths.has(relative)) {
      files[relative] = { ls: local.size, lm: local.mtimeMs, rs: local.size, rm: 0, re: '' };
      continue;
    }

    files[relative] = {
      ls: local.size,
      lm: local.mtimeMs,
      rs: remote.size,
      rm: remote.mtimeMs || 0,
      re: remote.etag || ''
    };
  }
  return files;
}

/* ---------------- 同步 ---------------- */

// 两侧文件是否一致：体积相同且修改时间在容差之内（服务器只精确到秒）
function isSameFile(local, remote) {
  if (!local || !remote) return false;
  if (local.size !== remote.size) return false;
  return Math.abs(local.mtimeMs - remote.mtimeMs) <= MTIME_TOLERANCE_MS;
}

/* 计划一次同步：返回 { actions, skipped, conflicts }。mode 为 upload / download / both：
   - 只有一侧有的文件：上传时只把「本地有、服务器没有」的传上去（服务器上多出来的原样保留），
     下载时反过来（本地多出来的同样保留），双向同步则哪边有就补到另一边。
   - upload / download 是用户明确指定的方向，两侧都有的文件直接按该方向处理，不看历史记录。
   - both（双向同步与自动同步）改为「谁变过谁说了算」：对照上一次同步留下的记录——
     只有一侧变了就按那一侧的方向走（只有远端变过 = 下载）；两侧都变过才比修改时间；
     时间也不可用时宁可不动，只把文件名记进 conflicts，由用户决定方向。
   skipped 是「本次不动的文件数」，用于报告里说明一共有多少文件已经一致。 */
function planActions(mode, localFiles, remoteFiles, previousFiles = {}) {
  const actions = [];
  const allPaths = new Set([...localFiles.keys(), ...remoteFiles.keys()]);
  let skipped = 0;
  const conflicts = [];

  for (const relative of allPaths) {
    const local = localFiles.get(relative) || null;
    const remote = remoteFiles.get(relative) || null;

    if (local && !remote) {
      if (mode === 'download') skipped++;
      else actions.push({ action: 'upload', relative });
      continue;
    }
    if (!local && remote) {
      if (mode === 'upload') skipped++;
      else actions.push({ action: 'download', relative });
      continue;
    }

    if (mode === 'upload' || mode === 'download') {
      if (isSameFile(local, remote)) skipped++;
      else actions.push({ action: mode === 'upload' ? 'upload' : 'download', relative });
      continue;
    }

    // both：先看两侧自上次同步以来各自有没有变
    const previous = previousFiles[relative] || null;
    const localChanged = !previous || local.size !== previous.ls || local.mtimeMs !== previous.lm;

    /* 服务器连体积 / 时间 / ETag 都不给（PROPFIND 元数据为空，典型如 Alist 对某些驱动）：
       既不知道怎么算「远端变了」，也没法比时间。此时只要本地自上次同步后没动过，
       就把远端那份下载下来——内容相同也无害，但绝不能因为元数据是空的就永远不下载。 */
    if (remote.metaKnown === false) {
      if (previous && !localChanged) {
        actions.push({ action: 'download', relative });
      } else {
        conflicts.push(relative);
      }
      continue;
    }

    /* 远端时间 / ETag 缺失时只能靠体积判断（这也是为什么需要那份记录：
       光比时间会永远判成本地更新） */
    const remoteChanged = !previous || remote.size !== previous.rs
      || (remote.mtimeMs && previous.rm ? remote.mtimeMs !== previous.rm : false)
      || (remote.etag && previous.re ? remote.etag !== previous.re : false);

    if (!localChanged && !remoteChanged) {
      skipped++;
      continue;
    }
    if (localChanged && !remoteChanged) {
      actions.push({ action: 'upload', relative });
      continue;
    }
    if (!localChanged && remoteChanged) {
      // 本地没动、远端变了：这就是「下载」该发生的时刻
      actions.push({ action: 'download', relative });
      continue;
    }

    // 两侧都变了：体积相同且服务器不给时间时，宁可当作一致，避免来回传同一份内容
    if (local.size === remote.size && !remote.mtimeMs) {
      skipped++;
      continue;
    }

    // 两侧都变了：先用修改时间判断
    if (remote.mtimeMs && local.mtimeMs && Math.abs(remote.mtimeMs - local.mtimeMs) > MTIME_TOLERANCE_MS) {
      actions.push({ action: remote.mtimeMs > local.mtimeMs ? 'download' : 'upload', relative });
      continue;
    }

    /* 判断不出方向（服务器不给时间，或两侧时间几乎相同）：不动这个文件，只记一笔。
       猜方向猜错就是把人家刚写的内容覆盖掉，所以这里宁可不做——结果里会列出文件名，
       想指定方向时点「上传到服务器」或「从服务器下载」即可。 */
    conflicts.push(relative);
  }

  return { actions: actions.sort((a, b) => a.relative.localeCompare(b.relative)), skipped, conflicts };
}

// 把远程文件取回本地：落盘后把本地修改时间对齐到服务器的那个时刻
async function downloadFile(relative, remoteStampMs) {
  const result = await davRequest('GET', remoteUrl(relative), { timeoutMs: TRANSFER_TIMEOUT_MS });
  if (!result.ok) return { ok: false, error: result.error || describeStatus(result.status) };

  const buffer = Buffer.from(await result.response.arrayBuffer());
  const stamp = parseHttpDate(result.response.headers.get('last-modified')) || remoteStampMs;
  return writeLocalFile(relative, buffer, stamp);
}

// 把本地文件送上服务器（父目录由调用方提前创建）
async function uploadFile(relative) {
  let buffer;
  try {
    buffer = fs.readFileSync(path.join(resolveDataDir(), ...relative.split('/')));
  } catch (error) {
    return { ok: false, error: `读取本地文件失败：${error.message}` };
  }

  const result = await davRequest('PUT', remoteUrl(relative), {
    body: buffer,
    headers: { 'Content-Type': 'application/octet-stream' },
    timeoutMs: TRANSFER_TIMEOUT_MS
  });
  if (result.ok) {
    // PUT 的 Last-Modified 是服务器给这份内容记下的时刻：本地跟着对齐，两侧基准就一致了
    applyLocalMtime(relative, parseHttpDate(result.response.headers.get('last-modified')));
    return { ok: true };
  }
  return { ok: false, error: result.error || describeStatus(result.status) };
}

// 上传前把涉及的每一层远程子目录建出来（notes/、ai_files/ 等）
async function ensureRemoteSubdirs(actions) {
  const dirs = new Set();
  actions.forEach(({ relative }) => {
    const segments = relative.split('/');
    segments.pop();
    let current = '';
    segments.forEach((segment) => {
      current = current ? `${current}/${segment}` : segment;
      dirs.add(current);
    });
  });

  for (const dir of dirs) {
    // dir 是数据目录内的相对路径，建之前要补上远程目录名（ensureCollection 认的是相对服务器地址的路径）
    const ensured = await ensureCollection(remoteDirServerPath(dir));
    if (!ensured.ok) return { ok: false, error: ensured.error };
  }
  return { ok: true };
}

function sendProgress(sender, payload) {
  if (!sender || sender.isDestroyed()) return;
  sender.send('webdav:progress', payload);
}

// 一次性检查：总开关是否打开、连接参数齐不齐、口令有没有
function validateConfig() {
  const config = readWebdavConfig();
  if (config.enabled === false) return { error: 'WebDAV 同步已关闭，请先在「设置 → 数据与存储」中启用' };
  if (!normalizeBaseUrl(config.url)) return { error: '请先填写服务器地址（以 http:// 或 https:// 开头）' };
  if (config.username && !store.read()) return { error: '已填写账号，但还没保存 WebDAV 口令' };
  return { config };
}

// 连接测试：建出远程目录，再看一眼里面已经有多少个文件
async function testConnection() {
  const checked = validateConfig();
  if (checked.error) return { ok: false, error: checked.error };

  const dirPath = remoteDirUrlPath();
  const created = await ensureRemoteDir();
  if (!created.ok) return { ok: false, error: created.error };

  const listed = await listRemoteDir(dirPath);
  if (!listed.ok) return { ok: false, error: listed.error };

  return {
    ok: true,
    remoteDir: checked.config.remoteDir,
    url: normalizeBaseUrl(checked.config.url),
    fileCount: listed.files.size
  };
}

async function runSync(mode, sender) {
  if (!SYNC_MODES.includes(mode)) return { ok: false, error: '未知的同步方向' };
  if (running) return { ok: false, error: '上一次同步还没结束，请稍候' };

  const checked = validateConfig();
  if (checked.error) return { ok: false, error: checked.error };

  const dataDir = resolveDataDir();
  if (!dataDir || !fs.existsSync(dataDir)) return { ok: false, error: '数据目录不存在' };

  running = true;
  const startedAt = Date.now();
  try {
    sendProgress(sender, { phase: 'connect', done: 0, total: 0, current: '' });
    const created = await ensureRemoteDir();
    if (!created.ok) return { ok: false, error: created.error };

    sendProgress(sender, { phase: 'list', done: 0, total: 0, current: '' });
    const remoteDir = checked.config.remoteDir;
    const listed = await listRemoteDir(remoteDirUrlPath());
    if (!listed.ok) return { ok: false, error: `无法读取远程目录：${listed.error}` };

    const localFiles = scanLocalDir(dataDir);
    /* 上一次同步留下的记录：双向同步据此判断「哪一侧变过」，
       而不是只比修改时间（服务器可能根本不返回修改时间） */
    const previousState = readSyncState();
    const plan = planActions(mode, localFiles, listed.files, previousState.files);
    const actions = plan.actions;

    // 只有上传方向才需要建远程子目录
    const uploadActions = actions.filter((item) => item.action === 'upload');
    if (uploadActions.length) {
      const prepared = await ensureRemoteSubdirs(uploadActions);
      if (!prepared.ok) return { ok: false, error: prepared.error };
    }

    let uploaded = 0;
    let downloaded = 0;
    const failures = [];
    // 本轮上传过的文件：写回同步记录时要用（远端内容已被我们改写）
    const uploadedPaths = new Set();

    for (let index = 0; index < actions.length; index++) {
      const { action, relative } = actions[index];
      sendProgress(sender, { phase: 'sync', done: index, total: actions.length, current: relative });

      const remote = listed.files.get(relative);
      const result = action === 'upload'
        ? await uploadFile(relative)
        : await downloadFile(relative, remote ? remote.mtimeMs : 0);
      if (result.ok) {
        if (action === 'upload') {
          uploaded++;
          uploadedPaths.add(relative);
        } else {
          downloaded++;
        }
      } else {
        failures.push({ path: relative, error: result.error, action });
      }
    }

    const finishedAt = Date.now();
    // 记下这一轮之后两侧的状态，供下一次判断方向（失败的文件保留旧记录）
    const nextFiles = buildSyncState(
      previousState,
      localFiles,
      listed.files,
      uploadedPaths,
      new Set(failures.map((item) => item.path)),
      new Set(plan.conflicts)
    );
    const stateSaved = writeSyncState({ key: previousState.key, files: nextFiles });
    /* 记录写不进去就得说一声：没有记录，下一次同步又只能按「首次」处理，
       表现就是远端改动永不被拉下来 */
    if (!stateSaved) lastAutoError = `同步状态记录写不进去（${stateFilePath() || '配置目录不可用'}）`;

    /* 未处理过的冲突：本次新判出的，加上记录里还带着 c 标记的。
       它们本轮没有被动过，因此每次同步都要继续报出来，直到你手动定过方向 */
    const unresolvedConflicts = Object.keys(nextFiles).filter((relative) => nextFiles[relative].c);
    const conflictReport = [...new Set([...plan.conflicts, ...unresolvedConflicts])];

    const summary = buildSummary({
      mode,
      uploaded,
      downloaded,
      failed: failures.length,
      conflicts: conflictReport
    });

    sendProgress(sender, { phase: 'done', done: actions.length, total: actions.length, current: '' });

    return {
      ok: failures.length === 0,
      mode,
      remoteDir,
      uploaded,
      downloaded,
      // 本次没动的文件数（两侧一致、或本方向不动而另一侧多出来的）
      skipped: plan.skipped,
      // 两侧都改过、又判断不出方向的（含此前一直未处理的）：本轮没有动它们（结果里给出文件名）
      conflictCount: conflictReport.length,
      conflicts: conflictReport.slice(0, MAX_REPORTED_FAILURES),
      failedCount: failures.length,
      failures: failures.slice(0, MAX_REPORTED_FAILURES),
      durationMs: finishedAt - startedAt,
      total: actions.length,
      summary,
      // 记下这次同步的时刻：设置页写入配置，用于展示「上次同步」
      lastSyncAt: finishedAt,
      error: failures.length
        ? `${failures.length} 个文件未能同步，第一个失败原因：${failures[0].error}`
        : ''
    };
  } finally {
    running = false;
  }
}

function buildSummary({ mode, uploaded, downloaded, failed, conflicts }) {
  const label = mode === 'upload' ? '上传' : (mode === 'download' ? '下载' : '同步');
  const parts = [];
  if (mode !== 'download' && uploaded) parts.push(`上传 ${uploaded}`);
  if (mode !== 'upload' && downloaded) parts.push(`下载 ${downloaded}`);
  if (conflicts && conflicts.length) parts.push(`两侧都改过 ${conflicts.length}`);
  if (failed) parts.push(`失败 ${failed}`);
  return parts.length ? `${label}完成：${parts.join('、')}` : `${label}完成：两侧内容已一致`;
}

/* ---------------- 使用模式：把 WebDAV 直接当成储存源 ----------------
   与同步模式的区别在于「谁主动」：
   - 同步模式：本地数据目录是主副本，点按钮才与服务器交换文件；
   - 使用模式：服务器是主储存源，本地数据目录只是它的缓存——
     启动后与每 5 分钟自动双向对齐一次（较新的一方胜出），
     每次落盘即时上传（写穿），本地删除也会同步到服务器。
   离线时照旧读写本地缓存，联网后由写穿重试或下一次对齐补上。
   无论哪种模式都不会因为「另一侧多出来」而删文件，删除只由本地操作主动下发。 */

// 会话内已确认存在的远程目录：写穿是逐文件发生的，每次保存都重新探测一遍父目录太浪费
const ensuredRemoteDirs = new Set();
// 待上传路径与去抖定时器：同一文件的多次保存合并成一次上传
const pendingPushes = new Map();
const pushQueue = [];
let pushRunning = false;
// 最近一次自动同步失败的原因：设置页据此提示，成功后清空
let lastAutoError = '';
/* 自动同步的定时器（两种模式共用）：
   autoTimer 是周期同步，autoFirstTimer 是启动后同步一次 */
let autoTimer = null;
let autoFirstTimer = null;
let autoAligning = false;

function isStorageMode() {
  return readWebdavConfig().mode === STORAGE_MODE;
}

// 渲染进程报上来的相对路径：只接受数据目录内的普通文件路径
function normalizeDataRelative(value) {
  const text = String(value == null ? '' : value).trim().replace(/\\/g, '/');
  if (!text || text.startsWith('/') || text.includes('..')) return '';
  if (isIgnorableFile(text)) return '';
  return text;
}

// 逐层确认远程目录存在；失败不进缓存，下次写穿会再试
async function ensureRemoteDirsOnce(relativeDir) {
  const segments = remoteDirServerPath(relativeDir).split('/').filter(Boolean);
  if (!segments.length) return { ok: false, error: '尚未填写远程目录' };

  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (ensuredRemoteDirs.has(current)) continue;

    const ensured = await ensureCollection(current);
    if (!ensured.ok) return ensured;
    ensuredRemoteDirs.add(current);
  }
  return { ok: true };
}

// 把一份本地文件推给服务器（父目录按需创建）
async function pushFile(relative) {
  const segments = relative.split('/');
  segments.pop();
  const ensured = await ensureRemoteDirsOnce(segments.join('/'));
  if (!ensured.ok) return ensured;
  return uploadFile(relative);
}

// 写穿：落盘后立即排队上传（同一路径的连续写入合并成一次）
function queuePush(relative) {
  clearTimeout(pendingPushes.get(relative));
  pendingPushes.set(relative, setTimeout(() => {
    pendingPushes.delete(relative);
    if (!pushQueue.includes(relative)) pushQueue.push(relative);
    drainPushQueue();
  }, PUSH_DEBOUNCE_MS));
}

// 串行上传：一次只跑一个，避免同一个目录下的多个文件并发建目录
async function drainPushQueue() {
  if (pushRunning) return;
  pushRunning = true;
  try {
    while (pushQueue.length) {
      const relative = pushQueue.shift();
      const result = await pushFile(relative);
      if (result.ok) {
        lastAutoError = '';
        continue;
      }
      lastAutoError = `${relative}：${result.error}`;
      console.warn('[Esprin Nemo] WebDAV 写穿上传失败 -', lastAutoError);
    }
  } finally {
    pushRunning = false;
  }
}

// 本地删除下发到服务器（只有使用模式才启用删除传播；同步模式永远不动服务器上的文件）
async function removeRemote(relative) {
  // 这个文件可能还排在待上传队列里：先取消，免得刚删掉又被推回去
  clearTimeout(pendingPushes.get(relative));
  pendingPushes.delete(relative);
  const queued = pushQueue.indexOf(relative);
  if (queued >= 0) pushQueue.splice(queued, 1);

  const result = await davRequest('DELETE', remoteUrl(relative));
  // 服务器上本来就没有（404）同样算删掉了
  if (result.ok || result.status === 404) {
    lastAutoError = '';
    return { ok: true };
  }

  const error = result.error || describeStatus(result.status);
  lastAutoError = `${relative}：${error}`;
  console.warn('[Esprin Nemo] WebDAV 删除远端文件失败 -', lastAutoError);
  return { ok: false, error };
}

/* 自动同步：双向、较新者胜出、不删任何一侧多出来的文件。
   两种情况都会走到这里——同步模式下按用户选的间隔定时；
   使用模式下启动时与每 5 分钟各一次（写穿负责把本地改动即时送上去）。
   下载了新内容就通知渲染进程重新载入，界面才会看到别的设备改过的内容。 */
async function autoAlign(reason) {
  if (autoAligning || running) return null;
  if (!normalizeBaseUrl(readWebdavConfig().url)) return null;

  autoAligning = true;
  try {
    const result = await runSync('both', null);
    if (!result.ok) {
      lastAutoError = result.error;
      console.warn(`[Esprin Nemo] WebDAV ${reason}自动同步未完全成功 -`, result.error);
      return result;
    }

    lastAutoError = '';
    /* 无论有没有下载都告诉渲染进程一声：设置页据此更新「上次同步」；
       真的下载了文件时，渲染进程还会重新载入一次数据 */
    sendToRenderer('webdav:remote-changed', {
      downloaded: result.downloaded,
      summary: result.summary,
      lastSyncAt: result.lastSyncAt,
      lastSyncSummary: result.summary
    });
    return result;
  } finally {
    autoAligning = false;
  }
}

/* 按当前模式与配置重建自动同步的定时器：应用启动时调一次，设置变更（间隔、地址、口令、模式）
   后再调一次。参数不完整时什么都不启——起了也只会每隔几秒失败一次。 */
function applyAutoSyncRuntime() {
  clearAutoRuntime();
  if (validateConfig().error) return;

  const config = readWebdavConfig();
  if (config.mode === STORAGE_MODE) {
    // 使用模式：启动对齐一次 + 每 5 分钟对齐（本地改动由写穿即时上传，不等这个定时器）
    autoFirstTimer = setTimeout(() => { autoAlign('启动'); }, AUTO_FIRST_SYNC_DELAY_MS);
    autoTimer = setInterval(() => { autoAlign('定时'); }, STORAGE_AUTO_SYNC_MS);
    return;
  }

  // 同步模式：按用户选的间隔自动双向同步
  if (config.autoSync === 'startup') {
    autoFirstTimer = setTimeout(() => { autoAlign('启动'); }, AUTO_FIRST_SYNC_DELAY_MS);
    return;
  }

  const intervalMs = autoSyncIntervalMs(config);
  if (intervalMs > 0) autoTimer = setInterval(() => { autoAlign('定时'); }, intervalMs);
}

// 停掉自动同步的定时器（改间隔、切模式、退出时都要先清掉旧的）
function clearAutoRuntime() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (autoFirstTimer) {
    clearTimeout(autoFirstTimer);
    autoFirstTimer = null;
  }
}

// 自动同步的当前状态：设置页据此显示节奏、待上传数量与最近的失败原因
function autoSyncStatus() {
  const config = readWebdavConfig();
  const intervalMs = config.mode === STORAGE_MODE ? STORAGE_AUTO_SYNC_MS : autoSyncIntervalMs(config);
  return {
    mode: config.mode,
    autoSync: config.autoSync,
    autoSyncSeconds: config.autoSyncSeconds,
    // 实际生效的间隔：没有定时器（关闭 / 只按启动 / 参数不全）时为 0
    intervalMs: autoTimer ? intervalMs : 0,
    startupSync: config.mode === STORAGE_MODE || config.autoSync === 'startup',
    active: !!autoTimer || !!autoFirstTimer,
    pending: pushQueue.length + pendingPushes.size,
    aligning: autoAligning,
    lastError: lastAutoError
  };
}

// 退出使用模式：停掉定时同步与所有待推送（尚未推送的改动留给手动或自动同步处理）
function stopStorageRuntime() {
  clearAutoRuntime();
  pendingPushes.forEach((timer) => clearTimeout(timer));
  pendingPushes.clear();
  pushQueue.length = 0;
  ensuredRemoteDirs.clear();
}

/* ---------------- 诊断报告 ----------------
   把「服务器到底返回了什么、我们解析成什么、两侧各有什么、同步计划怎么做」写成一份文本。
   同步出问题时点一下「诊断」就能看到，不用来回猜。 */
async function buildDiagnoseReport() {
  const lines = [];
  const config = readWebdavConfig();
  const state = readSyncState();

  lines.push('=== Esprin Nemo WebDAV 诊断 ===');
  lines.push(`时间：${new Date().toLocaleString()}`);
  lines.push(`服务器地址：${config.url || '（未填写）'}`);
  lines.push(`远程目录：${config.remoteDir}`);
  lines.push(`模式：${config.mode}；自动双向同步：${config.autoSync}`
    + `${config.autoSync === 'custom' ? `（${config.autoSyncSeconds} 秒）` : ''}`);
  lines.push(`数据目录：${resolveDataDir()}`);
  lines.push(`口令：${store.read() ? '已保存' : '未保存'}`);
  lines.push(`同步状态记录：${stateFilePath() || '（配置目录不可用）'}`);
  lines.push(`记录条目数：${Object.keys(state.files).length}（key=${state.key}）`);

  const checked = validateConfig();
  if (checked.error) {
    lines.push(`配置检查未通过：${checked.error}`);
    return lines.join('\n');
  }

  const dirPath = remoteDirUrlPath();
  lines.push('', `=== 1. PROPFIND ${dirPath}/ （Depth 1）===`);
  const probe = await davRequest('PROPFIND', remoteUrl('', { collection: true }), {
    depth: '1',
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY
  });
  lines.push(`HTTP 状态：${probe.status}${probe.error ? `（${probe.error}）` : ''}`);

  const raw = probe.response ? await probe.response.text().catch(() => '') : '';
  lines.push(`响应长度：${raw.length} 字`);
  lines.push('--- 原始响应（最多 4000 字）---');
  lines.push(raw.slice(0, 4000));

  const entries = raw ? parseMultiStatus(raw, dirPath) : [];
  lines.push('', `=== 2. 直接解析结果：${entries.length} 条 ===`);
  entries.slice(0, 40).forEach((entry) => {
    const meta = entry.size > 0 || entry.mtimeMs > 0 || entry.etag ? '可用' : '不可用';
    lines.push(`  ${entry.isCollection ? '[目录]' : '[文件]'} ${entry.path}`
      + `  size=${entry.size} mtime=${entry.mtimeMs} etag=${entry.etag || '（无）'}  元数据${meta}`);
  });

  lines.push('', '=== 3. 递归列举 ===');
  const listed = await listRemoteDir(dirPath);
  if (!listed.ok) {
    lines.push(`  失败：${listed.error}`);
  } else {
    lines.push(`  共 ${listed.files.size} 个文件`);
    [...listed.files.entries()].slice(0, 40).forEach(([relative, entry]) => {
      lines.push(`  ${relative}  size=${entry.size} mtime=${entry.mtimeMs}`
        + ` etag=${entry.etag || '（无）'}  元数据${entry.metaKnown ? '可用' : '不可用'}`);
    });
  }

  const localFiles = scanLocalDir(resolveDataDir());
  lines.push('', `=== 4. 本地：${localFiles.size} 个文件 ===`);
  [...localFiles.entries()].slice(0, 40).forEach(([relative, entry]) => {
    lines.push(`  ${relative}  size=${entry.size} mtime=${entry.mtimeMs}`);
  });

  if (listed.ok) {
    const plan = planActions('both', localFiles, listed.files, state.files);
    lines.push('', `=== 5. 双向同步计划：动作 ${plan.actions.length}、跳过 ${plan.skipped}`
      + `、无法判断 ${plan.conflicts.length} ===`);
    plan.actions.slice(0, 40).forEach((item) => {
      lines.push(`  ${item.action === 'upload' ? '上传' : '下载'}  ${item.relative}`);
    });
    plan.conflicts.slice(0, 20).forEach((relative) => lines.push(`  无法判断  ${relative}`));

    lines.push('', '=== 6. 两侧都有的文件的判据（前 30 个）===');
    let count = 0;
    for (const [relative, local] of localFiles) {
      const remote = listed.files.get(relative);
      if (!remote) continue;

      const previous = state.files[relative];
      lines.push(`  ${relative}`);
      lines.push(`    本地   size=${local.size} mtime=${local.mtimeMs}`);
      lines.push(`    远端   size=${remote.size} mtime=${remote.mtimeMs}`
        + ` etag=${remote.etag || '（无）'} 元数据${remote.metaKnown ? '可用' : '不可用'}`);
      lines.push(`    记录   ${previous
        ? `ls=${previous.ls} lm=${previous.lm} rs=${previous.rs} rm=${previous.rm} re=${previous.re || '（无）'}`
        : '（无记录）'}`);
      if (++count >= 30) break;
    }
  }

  return lines.join('\n');
}

async function runDiagnose() {
  const text = await buildDiagnoseReport();
  const dir = getConfigDir(app);
  let savedPath = '';

  if (dir) {
    try {
      savedPath = path.join(dir, 'webdav_diagnose.txt');
      fs.writeFileSync(savedPath, text, 'utf8');
    } catch (error) {
      savedPath = '';
    }
  }

  if (savedPath) {
    try {
      await shell.openPath(savedPath);
    } catch (error) {
      // 打不开也没关系，界面会把路径显示出来
    }
  }
  return { ok: true, path: savedPath, text };
}

/* ---------------- IPC ---------------- */

function registerWebdavIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  // 设置页打开时查询口令保管状态（渲染进程始终拿不到明文）
  ipcMain.handle('webdav:password-status', () => passwordStatus());

  // 提交新口令：成功后界面清空输入框，只保留状态
  ipcMain.handle('webdav:set-password', (event, payload) => {
    const result = store.write(payload && payload.password);
    return result.ok ? { ok: true, ...passwordStatus() } : result;
  });

  ipcMain.handle('webdav:clear-password', () => {
    const result = store.clear();
    return result.ok ? { ok: true, ...passwordStatus() } : result;
  });

  // 连接测试：顺带把远程目录建出来，用户不必先去服务器上手工建目录
  ipcMain.handle('webdav:test', () => testConnection());

  // 上传 / 下载 / 双向同步；进度由主进程主动推回（webdav:progress）
  ipcMain.handle('webdav:sync', (event, payload) => runSync(payload && payload.mode, event.sender));

  /* 使用模式：渲染进程每次落盘（webdav:push）与每次删除（webdav:remove）都会通知一声，
     主进程合并后即时同步到服务器。两个通道都用 send（不等回复），不拖慢本地保存 */
  ipcMain.on('webdav:push', (event, payload) => {
    if (!isStorageMode()) return;
    const relative = normalizeDataRelative(payload && payload.path);
    if (relative) queuePush(relative);
  });

  ipcMain.on('webdav:remove', (event, payload) => {
    if (!isStorageMode()) return;
    const relative = normalizeDataRelative(payload && payload.path);
    if (relative) removeRemote(relative);
  });

  // 自动同步状态：设置页据此显示是否在自动同步、实际生效的间隔、待上传数量与最近的失败原因
  ipcMain.handle('webdav:auto-status', () => autoSyncStatus());

  /* 诊断：把服务器返回的原始 PROPFIND 响应、解析结果、两侧文件列表与同步计划写成报告并打开，
     用于定位「只能上传不能下载」这类方向判断问题 */
  ipcMain.handle('webdav:diagnose', () => runDiagnose());

  /* 设置变更（间隔、地址、账号、远程目录、口令）后重建自动同步的定时器：
     定时器只存在于主进程，渲染进程改完配置通知一声即可 */
  ipcMain.handle('webdav:apply-auto-sync', () => {
    applyAutoSyncRuntime();
    return autoSyncStatus();
  });

  /* 切换使用方式：配置由渲染进程写（webdav.mode），这里只负责运行时——
     进入使用模式时先做一次双向对齐，把本地已有内容与服务器内容合到一起 */
  ipcMain.handle('webdav:set-mode', async (event, payload) => {
    const mode = payload && payload.mode === STORAGE_MODE ? STORAGE_MODE : 'sync';

    if (mode === 'sync') {
      stopStorageRuntime();
      // 切回同步模式：还自动同步与否由用户选的间隔决定
      applyAutoSyncRuntime();
      return { ok: true, mode, firstAlign: null, error: '' };
    }

    const aligned = await runSync('both', event.sender);
    applyAutoSyncRuntime();
    return { ok: aligned.ok, mode, firstAlign: aligned, error: aligned.error || '' };
  });
}

module.exports = {
  configureWebdavSync,
  registerWebdavIpc,
  // 按配置拉起自动同步（同步模式的定时双向同步、使用模式的启动与定时对齐）：应用启动时调用
  applyAutoSyncRuntime,
  // 供自测与后续扩展使用
  passwordStatus
};
