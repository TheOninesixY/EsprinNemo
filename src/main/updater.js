/* 应用更新：检查新版本、下载安装包，再把安装包交回安装程序完成升级。
   整个流程只用 Node 内置模块，不引入第三方依赖：
   - 检查：GET /repos/{owner}/{repo}/releases/latest（GitHub Releases API）
     取该 release 的 tag（形如 v0.0.0）与当前版本逐段比较，比当前版本高才会提醒更新。
     检查、读取当前版本发布记录与下载安装包都受「使用 gh-proxy 加速」开关影响：
     打开后先经代理转发，代理不可用或返回的内容不对时自动回落直连（见 githubUrls）。
   - 下载：取该 release 里符合命名规则的附件（Windows 要求文件名里有独立的 setup 段且以
     .exe 结尾，例如 “Esprin Nemo Setup 2.1.2.exe” 或 “en.Setup.123.exe”）。
     默认直连 GitHub 下载；设置里打开「使用 gh-proxy 加速下载」后，安装包先经 gh-proxy
     公共代理转发（见 GH_PROXY_PREFIX），代理不可用或下载失败时自动回落直连。
   - 安装：把安装包以
       "Esprin Nemo Setup x.y.z.exe" --upgrade --updated --force-run
     运行。--upgrade 由安装脚本（src/win_installer/installer.nsh）识别：不显示任何向导页
     与对话框，只留一个安装进度页（进度条 + “正在更新”标题），安装结束后自动重新打开应用；
     --updated / --force-run 是 electron-builder 自带的开关，用于跳过向导页并等待旧进程退出。
   - 当前版本说明：GET /repos/{owner}/{repo}/releases/tags/v<当前版本>，取该版本的发布说明与
     发布时间给「更新与版本」页展示；更新源上没有对应的发布记录（例如本地构建的版本）时
     只记一个状态，不影响检查更新等其他功能。

   便携版整体不启用更新功能：主进程既不注册更新 IPC、也不安排自动检查，界面上的
   「更新与版本」设置项随之拿掉（见 src/main/main.js 与 src/renderer/scripts/update.js）。
   开发运行（bun start）与非 Windows 平台不支持自动安装，此时只下载安装包
   并打开它所在的目录，由用户手动完成安装。 */
const { app, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { showDialogWindow } = require('./dialog_window.js');

// 更新源：仓库的 Releases 里上传安装包即可被检查到（改仓库地址时改这里）
const UPDATE_REPO = 'TheOninesixY/EsprinNemo';
// 项目地址：设置页「更新与版本」里作为信息展示，并可在系统浏览器中打开
const REPO_URL = `https://github.com/${UPDATE_REPO}`;
const RELEASE_PAGE_URL = `${REPO_URL}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
// 指定 tag 的发布记录（当前版本的发布说明用）：tag 形如 v0.0.0
const releaseTagApi = (tag) => `https://api.github.com/repos/${UPDATE_REPO}/releases/tags/${encodeURIComponent(tag)}`;

// gh-proxy：把 GitHub 的地址（页面、API、附件）交给公共代理转发，直连 GitHub 慢或不通时用来加速。
// 设置里的「使用 gh-proxy 加速」打开后，检查更新与下载安装包都先走这个前缀，失败再回落直连。
// 换用别的 gh-proxy 实例时只改这一行即可（形如 “https://<站点>/”，转发时直接拼在原始地址前面）
const GH_PROXY_PREFIX = 'https://gh-proxy.com/';
// 允许代理转发的地址：GitHub 的仓库页与 API（github.com / api.github.com）以及附件站
const PROXYABLE_URL_PATTERN = /^https?:\/\/(?:[\w.-]+\.)?(?:github\.com|githubusercontent\.com)\//i;

const USER_AGENT = 'EsprinNemo-Updater';
const REQUEST_TIMEOUT_MS = 20000;
// 重定向跟随次数与 API 响应体上限（正常响应只有几 KB）
// 走 gh-proxy 时链路上会多一跳，因此留出比直连更宽的余量
const MAX_REDIRECTS = 8;
const MAX_API_BYTES = 2 * 1024 * 1024;
// 单个安装包的体积上限：防止被异常响应写成无限增长的文件
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

// 启动后先留一点时间让主窗口就绪，之后按固定间隔复查
const FIRST_CHECK_DELAY_MS = 12000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 下载进度上报节流：避免每收到一个数据块就往渲染进程发一次
const PROGRESS_INTERVAL_MS = 300;

// 可选的安装包后缀：Windows 取 exe，其余平台各自的后缀
const PACKAGE_EXTENSIONS = process.platform === 'win32'
  ? ['.exe']
  : ['.appimage', '.deb', '.rpm', '.dmg', '.zip'];
// Windows 安装包的命名规则（两道检查，缺一不可）：
//   1) 文件名里存在独立的 setup 段 —— 由点 / 空格 / 连字符 / 下划线分隔，如 en.Setup.123.exe
//   2) 以 .exe 结尾
const SETUP_SEGMENT_PATTERN = /(^|[.\s_\-])setup([.\s_\-]|$)/i;
const EXE_FILE_PATTERN = /\.exe$/i;

const state = {
  status: 'idle', // idle / checking / latest / available / downloading / downloaded / error
  checking: false,
  downloading: false,
  // 当前下载请求：取消时直接 destroy
  request: null,
  canceled: false,
  // 检查到的新版本：{ version, notes, publishedAt, releaseUrl, asset }
  update: null,
  // 当前版本对应的发布记录：{ version, notes, publishedAt, releaseUrl }
  currentRelease: null,
  // 当前版本发布记录的读取状态：idle / loading / ready / missing / error
  currentReleaseStatus: 'idle',
  currentReleaseError: '',
  downloadedFile: '',
  // 已下载安装包对应的版本号：与检查到的新版本不一致时说明文件已过期
  downloadedVersion: '',
  progress: null,
  error: '',
  lastCheckAt: 0,
  // 本次下载是否由后台自动流程发起：仅自动流程会在完成后弹窗询问安装
  autoFlow: false
};

let firstCheckTimer = null;
let checkIntervalTimer = null;
let progressSentAt = 0;

// 由 main.js 注入：读取用户配置（config.json）、取主窗口（弹窗的父窗口）
// 与写回配置（「永不提醒」需要在主进程里直接关掉自动更新）
let readUserConfig = () => ({});
let getOwnerWindow = () => null;
let writeUserConfig = () => false;
let ipcRegistered = false;

function configureUpdater({ getConfig, getOwner, setConfig } = {}) {
  if (typeof getConfig === 'function') readUserConfig = getConfig;
  if (typeof getOwner === 'function') getOwnerWindow = getOwner;
  if (typeof setConfig === 'function') writeUserConfig = setConfig;
}

/* ---------------- 版本号与状态 ---------------- */

function asString(value) {
  return value == null ? '' : String(value);
}

// 去掉前缀 v 与首尾空白，并只保留数字版本段：GitHub 的 tag 形如 v0.0.0，
// 取到的 “v2.1.3-beta” 会被归一化成 2.1.3；nightly / vNext 这类不是版本号的 tag 返回空串。
function normalizeVersion(value) {
  const matched = asString(value).trim().replace(/^[vV]/, '').match(/^\d+(?:\.\d+)*/);
  return matched ? matched[0] : '';
}

// 逐段比较版本号（都已被 normalizeVersion 归一成 数字.数字.数字）：返回 1 / 0 / -1
function compareVersions(a, b) {
  const left = normalizeVersion(a).split('.').map((part) => parseInt(part, 10) || 0);
  const right = normalizeVersion(b).split('.').map((part) => parseInt(part, 10) || 0);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function currentVersion() {
  return normalizeVersion(app.getVersion());
}

// 渲染进程启动参数：便携版标记。渲染进程据此把「更新与版本」设置分类与面板一并摘掉
// （见 src/renderer/boot.js 的 IS_PORTABLE_RUN 与 src/renderer/scripts/update.js）
const PORTABLE_ARG = '--esprin-nemo-portable';

// 便携版：electron-builder 的 portable 目标会在启动时写入这几个环境变量
function isPortableRun() {
  return !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

// 能否自动安装：仅 Windows 安装版（开发运行只能手动安装；便携版不会走到这一步）
function canAutoInstall() {
  return process.platform === 'win32' && app.isPackaged && !isPortableRun();
}

// 自动更新开关以 config.json 为准：数据目录切换后读到的就是新目录里的配置
function readConfigAutoUpdate() {
  try {
    const config = readUserConfig();
    return !(config && config.autoUpdate === false);
  } catch (error) {
    return true;
  }
}

// gh-proxy 加速开关同样以 config.json 为准（默认关闭）：每次检查 / 下载时现读，
// 用户在设置里改完立刻对下一次检查与下载生效，不需要重启或重新注册 IPC
function readConfigGhProxy() {
  try {
    const config = readUserConfig();
    return !!(config && config.ghProxyEnabled === true);
  } catch (error) {
    return false;
  }
}

function setStatus(status) {
  state.status = status;
}

// 已下载的安装包是否就是当前检查到的新版本（换版本或文件被删掉都算未下载）
function isDownloaded() {
  const version = state.update ? state.update.version : '';
  return !!state.downloadedVersion
    && state.downloadedVersion === version
    && !!state.downloadedFile
    && fs.existsSync(state.downloadedFile);
}

function snapshot() {
  const update = state.update;
  return {
    status: state.status,
    currentVersion: currentVersion(),
    // 项目地址：设置页里作为说明文字展示，并可在系统浏览器中打开
    repoUrl: REPO_URL,
    autoUpdate: readConfigAutoUpdate(),
    // gh-proxy 下载加速：设置页的开关状态直接取这里的值
    ghProxyEnabled: readConfigGhProxy(),
    canAutoInstall: canAutoInstall(),
    packaged: app.isPackaged,
    checking: state.checking,
    downloading: state.downloading,
    downloaded: isDownloaded(),
    progress: state.progress ? { ...state.progress } : null,
    lastCheckAt: state.lastCheckAt,
    error: state.error,
    // 当前版本的发布说明（来自 tag 等于当前版本的那条 release）
    currentRelease: state.currentRelease ? { ...state.currentRelease } : null,
    currentReleaseStatus: state.currentReleaseStatus,
    currentReleaseError: state.currentReleaseError,
    update: update
      ? {
        version: update.version,
        notes: update.notes,
        publishedAt: update.publishedAt,
        releaseUrl: update.releaseUrl,
        assetName: update.asset ? update.asset.name : '',
        assetSize: update.asset ? update.asset.size : 0,
        hasAsset: !!update.asset
      }
      : null
  };
}

function broadcast() {
  const win = getOwnerWindow();
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send('update:state', snapshot());
}

// 单独通知渲染进程「自动更新已被关掉」：界面借此提示一次，并同步开关与内存状态
function notifyAutoUpdateDisabled() {
  const win = getOwnerWindow();
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send('update:auto-disabled', { reason: 'muted' });
}

/* 「永不提醒」：把配置里的自动更新写成关闭并立即停掉定时检查。
   配置由主进程直接落盘（渲染进程只在自己保存配置时写入），因此写完再广播一次状态，
   设置页里的开关会跟着变成关闭；下次启动也不会再自动检查与下载。 */
function disableAutoUpdate() {
  stopAutoChecks();
  const saved = writeUserConfig({ autoUpdate: false });
  if (!saved) console.error('[Esprin Nemo] 关闭自动更新失败：配置未能写入');
  notifyAutoUpdateDisabled();
  broadcast();
}

/* ---------------- 网络请求 ---------------- */

function isRedirectStatus(code) {
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

// 把网络错误翻译成用户能看懂的说明
function describeNetworkError(error) {
  const code = error && error.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析更新源地址，请检查网络连接';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') return '连接更新源失败，请稍后重试';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return '更新源的 HTTPS 证书校验失败';
  return asString(error && error.message) || '检查更新失败';
}

// allowNotFound：把 404 当成“没有这条记录”而不是错误（当前版本可能没有发布过）
function requestJson(url, redirects = 0, { allowNotFound = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json'
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (response) => {
      if (isRedirectStatus(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('更新源重定向次数过多'));
          return;
        }
        resolve(requestJson(new URL(response.headers.location, url).href, redirects + 1, { allowNotFound }));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_API_BYTES) request.destroy(new Error('更新源返回内容过大'));
      });
      response.on('end', () => {
        if (response.statusCode === 404) {
          if (allowNotFound) {
            resolve(null);
            return;
          }
          reject(new Error('更新源暂无发布版本'));
          return;
        }
        if (response.statusCode === 403 || response.statusCode === 429) {
          reject(new Error('更新源访问过于频繁，请稍后再试'));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`更新源返回 HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error('更新源返回的内容无法解析'));
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('连接更新源超时')));
    request.on('error', (error) => reject(error));
  });
}

// 把 GitHub 地址换成经 gh-proxy 转发的地址；不是 GitHub 的地址返回空串（不转发）
function ghProxyUrl(url) {
  const target = asString(url);
  return PROXYABLE_URL_PATTERN.test(target) ? `${GH_PROXY_PREFIX}${target}` : '';
}

// 本次请求要依次尝试的地址：开了加速就先走代理再直连，没开就只有直连一条。
// 检查更新、读取发布记录与下载安装包共用这里，因此三处的链路行为始终一致。
function githubUrls(url) {
  const direct = asString(url);
  if (!readConfigGhProxy()) return [direct];
  const proxied = ghProxyUrl(direct);
  return proxied ? [proxied, direct] : [direct];
}

/* 请求 GitHub 的 JSON 接口：依次尝试 githubUrls 给出的地址，代理被拦下、限速或
   返回的压根不是 JSON 时自动改用直连重来，全部失败才把最后一个错误抛出去。 */
async function requestGithubJson(url, { allowNotFound = false } = {}) {
  const urls = githubUrls(url);
  let lastError = null;

  for (let i = 0; i < urls.length; i++) {
    try {
      // allowNotFound 在所有地址上同样生效：任一个地址确认“没有这条记录”就直接返回 null
      return await requestJson(urls[i], 0, { allowNotFound });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('请求更新源失败');
}

/* ---------------- 检查更新 ---------------- */

function hasPackageExtension(name) {
  const lower = asString(name).toLowerCase();
  return PACKAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// 文件名是否符合安装包命名规则：Windows 必须同时满足“有 setup 段”与“以 .exe 结尾”
function isPackageName(name) {
  const value = asString(name);
  if (process.platform === 'win32') {
    return EXE_FILE_PATTERN.test(value) && SETUP_SEGMENT_PATTERN.test(value);
  }
  return hasPackageExtension(value);
}

// 从 release 的附件里挑出符合命名规则的安装包；没有符合条件的附件时返回 null
function pickAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return list.find((asset) => asset && asset.browser_download_url && isPackageName(asset.name)) || null;
}

let pendingCheck = null;

// 检查是否有新版本；同时只允许一个检查在跑，重复调用复用同一个结果
function checkForUpdates() {
  if (pendingCheck) return pendingCheck;

  state.checking = true;
  state.error = '';
  setStatus('checking');
  broadcast();

  pendingCheck = (async () => {
    try {
      const release = await requestGithubJson(LATEST_RELEASE_API);
      const latest = normalizeVersion(release && (release.tag_name || release.name));
      if (!latest) throw new Error('更新源返回的版本号无法识别');

      const notes = asString(release.body);
      const asset = pickAsset(release.assets);
      state.update = {
        version: latest,
        notes,
        publishedAt: asString(release.published_at),
        releaseUrl: asString(release.html_url) || RELEASE_PAGE_URL,
        asset: asset
          ? { name: asString(asset.name), url: asString(asset.browser_download_url), size: Number(asset.size) || 0 }
          : null
      };
      // 更新源上的版本已经变了：上一版下载好的安装包随之作废
      if (state.downloadedVersion && state.downloadedVersion !== latest) {
        removeFileQuietly(state.downloadedFile);
        state.downloadedFile = '';
        state.downloadedVersion = '';
        state.progress = null;
      }

      setStatus(compareVersions(latest, currentVersion()) > 0 ? 'available' : 'latest');
      state.lastCheckAt = Date.now();
      broadcast();
      return snapshot();
    } catch (error) {
      state.error = describeNetworkError(error);
      setStatus('error');
      broadcast();
      return snapshot();
    } finally {
      state.checking = false;
      pendingCheck = null;
    }
  })();

  return pendingCheck;
}

/* ---------------- 当前版本的发布说明 ---------------- */

let pendingCurrentRelease = null;

/* 读取当前版本在更新源上的发布记录（更新说明、发布时间、发布页地址）。
   与「检查更新」互不影响：只读 tag 等于当前版本的那条 release，拿到就缓存，
   同一版本不再重复请求；更新源上没有这条记录（404）或网络出错都只记状态，
   界面上显示一句说明即可，不影响检查更新与下载安装包。 */
function ensureCurrentRelease() {
  if (pendingCurrentRelease) return pendingCurrentRelease;

  const version = currentVersion();
  if (!version) return Promise.resolve(snapshot());
  // 已经拿到当前版本的记录：直接复用缓存，避免每次打开设置页都打一次 API
  if (state.currentReleaseStatus === 'ready'
    && state.currentRelease
    && state.currentRelease.version === version) {
    return Promise.resolve(snapshot());
  }

  state.currentReleaseStatus = 'loading';
  state.currentReleaseError = '';
  broadcast();

  pendingCurrentRelease = (async () => {
    try {
      // 发布用的是 v<版本> 形式的 tag；万一没带 v，就按原样再试一次
      let release = await requestGithubJson(releaseTagApi(`v${version}`), { allowNotFound: true });
      if (!release) release = await requestGithubJson(releaseTagApi(version), { allowNotFound: true });

      if (!release) {
        state.currentRelease = null;
        state.currentReleaseStatus = 'missing';
        return snapshot();
      }

      state.currentRelease = {
        version: normalizeVersion(release.tag_name || release.name) || version,
        notes: asString(release.body),
        publishedAt: asString(release.published_at),
        releaseUrl: asString(release.html_url) || RELEASE_PAGE_URL
      };
      state.currentReleaseStatus = 'ready';
      return snapshot();
    } catch (error) {
      state.currentRelease = null;
      state.currentReleaseStatus = 'error';
      state.currentReleaseError = describeNetworkError(error);
      return snapshot();
    } finally {
      pendingCurrentRelease = null;
      broadcast();
    }
  })();

  return pendingCurrentRelease;
}

/* ---------------- 下载安装包 ---------------- */

function describeProgress(received, total, startedAt) {
  const elapsed = Math.max(1, Date.now() - startedAt) / 1000;
  return {
    received,
    total,
    percent: total > 0 ? Math.min(100, Math.round((received / total) * 1000) / 10) : 0,
    bytesPerSecond: Math.round(received / elapsed)
  };
}

function removeFileQuietly(target) {
  if (!target) return;
  // Windows 上删除仍在写入的临时文件会失败（EBUSY / EPERM），稍后重试一次
  const attempt = (retry) => {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch (error) {
      if (retry) setTimeout(() => attempt(false), 800);
    }
  };
  attempt(true);
}

// 下载安装包：重定向跟随 + 进度回调 + 可取消。返回 Promise，取消时以 canceled 标记拒绝。
// 地址由调用方给出（见 githubUrls：开了加速就是“代理地址、直连地址”两条）
function downloadPackage(url, target, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    // 出错 / 取消时要把写流一并关掉，否则残留的句柄会让后续删除临时文件失败
    let file = null;
    const closeFile = () => {
      if (!file) return;
      try {
        file.destroy();
      } catch (error) {
        // 关流失败不影响错误上报
      }
      file = null;
    };

    const request = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
      timeout: REQUEST_TIMEOUT_MS
    }, (response) => {
      if (isRedirectStatus(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('更新源重定向次数过多'));
          return;
        }
        resolve(downloadPackage(new URL(response.headers.location, url).href, target, onProgress, redirects + 1));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`下载安装包失败（HTTP ${response.statusCode}）`));
        return;
      }

      const declared = Number(response.headers['content-length']) || 0;
      if (declared > MAX_PACKAGE_BYTES) {
        response.resume();
        reject(new Error('安装包体积异常，已停止下载'));
        return;
      }

      let received = 0;
      const stream = fs.createWriteStream(target);
      file = stream;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_PACKAGE_BYTES) {
          request.destroy(new Error('安装包体积异常，已停止下载'));
          return;
        }
        onProgress(received, declared);
      });
      response.on('error', (error) => {
        closeFile();
        reject(error);
      });
      stream.on('error', (error) => {
        request.destroy();
        reject(error);
      });
      stream.on('finish', () => stream.close(() => resolve({ received, declared })));
      response.pipe(stream);
    });

    state.request = request;
    request.on('timeout', () => request.destroy(new Error('下载超时')));
    request.on('error', (error) => {
      closeFile();
      reject(error);
    });
  });
}

/* 校验下载结果：体积要和声明的一致，Windows 安装包还要有 MZ 文件头。
   代理失手把错误页面当附件返回时这一步就会失败，于是会换下一个地址重来。 */
function verifyPackage(target, expected, received, ext) {
  if (expected && received !== expected) {
    throw new Error(`安装包不完整（${received}/${expected} 字节）`);
  }
  const head = Buffer.alloc(2);
  const handle = fs.openSync(target, 'r');
  try {
    fs.readSync(handle, head, 0, 2, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (ext === '.exe' && head.toString('ascii') !== 'MZ') {
    throw new Error('下载到的文件不是有效的安装包');
  }
}

/* 按候选地址依次尝试下载：代理被限速、拦下、断流或返回一个错误页面时自动改用直连重来，
   只有在所有地址都失败后才把错误抛给调用方（用户主动取消则立即结束，不再换地址）。
   每次尝试都完整走一遍「下载 + 校验」，因此代理给出坏文件也不会被当成下载成功。 */
async function downloadPackageFrom(urls, target, { expectedSize = 0, ext = '', onProgress }) {
  let lastError = null;

  for (let i = 0; i < urls.length; i++) {
    try {
      const result = await downloadPackage(urls[i], target, onProgress);
      verifyPackage(target, result.declared || expectedSize, result.received, ext);
      return result;
    } catch (error) {
      lastError = error;
      if (state.canceled) break;
      // 半截文件会干扰下一次尝试：先删干净（写入流本来也会截断，这里顺手把失败痕迹清掉）
      removeFileQuietly(target);
      if (i < urls.length - 1) {
        // 换地址等于从头开始：进度归零重画，界面不会停在上一段的进度与速度上
        state.progress = {
          received: 0,
          total: expectedSize || (state.update && state.update.asset ? state.update.asset.size : 0) || 0,
          percent: 0,
          bytesPerSecond: 0
        };
        progressSentAt = 0;
        broadcast();
      }
    }
  }

  throw lastError || new Error('下载安装包失败');
}

function cancelDownload() {
  if (!state.downloading || !state.request) return false;
  state.canceled = true;
  try {
    state.request.destroy(new Error('已取消下载'));
  } catch (error) {
    // 取消本身就是尽力而为
  }
  return true;
}

// 标记安装包已就绪：自动流程随即询问是否立即重启安装
function finishDownload(target, version, total, received, { auto = false } = {}) {
  state.downloadedFile = target;
  state.downloadedVersion = version;
  state.progress = { received, total: total || received, percent: 100, bytesPerSecond: 0 };
  setStatus('downloaded');
  broadcast();

  // 自动流程：下载完成后询问是否立即重启安装。
  // 用 setTimeout 与下载 Promise 脱钩，弹窗出问题不会被当成“下载失败”而删掉安装包。
  if (auto) {
    setTimeout(() => {
      promptInstallReady().catch((error) => {
        console.error('[Esprin Nemo] 提示安装更新失败:', error);
      });
    }, 0);
  }
}

// 开始下载：auto 为 true 表示由后台自动流程发起（完成后会弹窗询问安装）
async function startDownload({ auto = false } = {}) {
  if (state.downloading) return { ok: true, alreadyRunning: true };
  if (isDownloaded()) return { ok: true, alreadyDownloaded: true };

  const update = state.update;
  if (!update || !update.asset || !update.asset.url) {
    setStatus(state.update ? 'available' : 'error');
    state.error = '没有找到可下载的安装包，请到发布页手动下载';
    broadcast();
    return { ok: false, error: state.error };
  }

  const ext = path.extname(update.asset.name) || PACKAGE_EXTENSIONS[0];
  const target = path.join(app.getPath('temp'), `EsprinNemo-Update-${update.version}${ext}`);

  // 上一次运行已经下载过同一个版本（用户当时选了“稍后”）：临时文件完整就直接复用，不重复下载
  const assetSize = update.asset.size || 0;
  if (assetSize && fs.existsSync(target)) {
    try {
      if (fs.statSync(target).size === assetSize) {
        finishDownload(target, update.version, assetSize, assetSize, { auto });
        return { ok: true, reused: true };
      }
    } catch (error) {
      // 读不到大小就当作未下载，走下面的正常下载
    }
    removeFileQuietly(target);
  }

  state.autoFlow = !!auto;
  state.downloading = true;
  state.canceled = false;
  state.error = '';
  state.progress = { received: 0, total: update.asset.size || 0, percent: 0, bytesPerSecond: 0 };
  setStatus('downloading');
  progressSentAt = 0;
  broadcast();

  const startedAt = Date.now();
  const onProgress = (received, declared) => {
    const total = declared || update.asset.size || 0;
    state.progress = describeProgress(received, total, startedAt);
    const now = Date.now();
    if (now - progressSentAt >= PROGRESS_INTERVAL_MS) {
      progressSentAt = now;
      broadcast();
    }
  };

  // 下载放到后台跑：界面立刻拿到返回值，后续进度通过 update:state 事件推送。
  // 地址可能有两条（代理 + 直连，见 githubUrls），由 downloadPackageFrom 依次尝试；
  // 体积与文件头校验也在那里逐次完成，避免把半截文件或错误页面当成安装包。
  downloadPackageFrom(githubUrls(update.asset.url), target, {
    expectedSize: update.asset.size || 0,
    ext,
    onProgress
  }).then((result) => {
    state.request = null;
    state.downloading = false;

    finishDownload(target, update.version, result.declared || update.asset.size || 0, result.received, { auto: state.autoFlow });
  }).catch((error) => {
    state.request = null;
    state.downloading = false;
    removeFileQuietly(target);
    state.progress = null;
    state.downloadedFile = '';
    state.downloadedVersion = '';

    if (state.canceled) {
      state.canceled = false;
      state.error = '';
      setStatus(state.update && compareVersions(state.update.version, currentVersion()) > 0 ? 'available' : 'idle');
      broadcast();
      return;
    }
    state.error = describeNetworkError(error);
    setStatus('error');
    broadcast();
  });

  return { ok: true };
}

/* ---------------- 安装更新 ---------------- */

async function installUpdate() {
  const file = state.downloadedFile;
  if (!file || !fs.existsSync(file)) {
    return { ok: false, error: '还没有下载好的安装包' };
  }

  // 开发运行 / 非 Windows：只能手动安装，这里打开文件所在目录
  if (!canAutoInstall()) {
    shell.showItemInFolder(file);
    return { ok: true, manual: true, file };
  }

  try {
    const child = spawn(file, ['--upgrade', '--updated', '--force-run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (error) {
    console.error('[Esprin Nemo] 启动更新安装程序失败:', error);
    return { ok: false, error: `启动安装程序失败：${asString(error && error.message)}` };
  }

  // 安装程序会等待旧进程退出（--updated 已告知它这是一次升级），因此这里主动退出应用；
  // 稍等一点时间再退，确保安装程序已经真正跑起来。
  setTimeout(() => app.quit(), 400);
  return { ok: true };
}

/* ---------------- 自动流程与弹窗 ---------------- */

// 后台自动流程：检查 → 有新版就下载 → 下载完成后询问是否立即重启安装
// 便携版没有更新功能，开发运行（bun start）也不参与自动流程：源码本来就不是通过
// 更新包分发的，设置页里的「检查更新」仍可手动使用。
async function runAutoCheck() {
  if (isPortableRun()) return;
  if (!app.isPackaged) return;
  if (!readConfigAutoUpdate()) return;
  if (state.downloading || state.checking) return;
  if (isDownloaded()) return;

  const result = await checkForUpdates();
  if (result.status !== 'available') return;
  await startDownload({ auto: true });
}

async function promptInstallReady() {
  const version = state.update ? state.update.version : '';
  const installable = canAutoInstall();

  const choice = await showDialogWindow(getOwnerWindow(), {
    type: 'info',
    icon: 'system_update',
    title: '更新已就绪',
    message: `Esprin Nemo ${version} 已下载完成`,
    detail: installable
      ? '重启应用即可完成安装：应用会先退出，安装完成后自动重新打开。'
      : '当前为开发运行，不支持自动安装，请用下载好的安装包手动升级。',
    // 「永不提醒」：勾选后关闭本窗口，就不再自动检查并下载更新
    checkbox: {
      label: '永不提醒（勾选后关闭本窗口，设置里的「自动检查并下载更新」会一并关闭）',
      checked: false
    },
    buttons: installable
      ? [
        { id: 'install', label: '立即重启安装', variant: 'primary' },
        { id: 'later', label: '稍后', cancel: true }
      ]
      : [
        { id: 'open', label: '打开安装包', variant: 'primary' },
        { id: 'later', label: '稍后', cancel: true }
      ]
  });

  if (choice.id === 'install') {
    await installUpdate();
    return;
  }
  if (choice.id === 'open') {
    shell.showItemInFolder(state.downloadedFile);
    return;
  }

  // 「稍后」与直接关闭窗口都是「这次不装」：勾了永不提醒的就顺手关掉自动更新
  if (choice.checked) disableAutoUpdate();
}

function stopAutoChecks() {
  if (firstCheckTimer) {
    clearTimeout(firstCheckTimer);
    firstCheckTimer = null;
  }
  if (checkIntervalTimer) {
    clearInterval(checkIntervalTimer);
    checkIntervalTimer = null;
  }
}

// 按配置安排自动检查：启动后延迟一次，之后按固定间隔复查
function scheduleAutoChecks() {
  stopAutoChecks();
  // 便携版没有更新功能：既不检查新版本，也不在后台下载
  if (isPortableRun()) return;
  if (!readConfigAutoUpdate()) return;

  firstCheckTimer = setTimeout(() => {
    firstCheckTimer = null;
    runAutoCheck();
  }, FIRST_CHECK_DELAY_MS);
  checkIntervalTimer = setInterval(runAutoCheck, CHECK_INTERVAL_MS);

  try {
    if (firstCheckTimer && typeof firstCheckTimer.unref === 'function') firstCheckTimer.unref();
    if (checkIntervalTimer && typeof checkIntervalTimer.unref === 'function') checkIntervalTimer.unref();
  } catch (error) {
    // unref 失败不影响功能
  }
}

/* ---------------- IPC ---------------- */

function registerUpdateIpc() {
  if (ipcRegistered) return;
  // 便携版整体移除更新功能：连 IPC 通道都不注册，渲染进程无从触发任何更新动作
  if (isPortableRun()) return;
  ipcRegistered = true;

  ipcMain.handle('update:get-info', () => {
    // 打开设置页时顺带异步读一次当前版本的发布记录：读完通过 update:state 推送过来
    ensureCurrentRelease();
    return snapshot();
  });

  // 自动更新开关：渲染进程改完后立即落盘配置，这里只需重新安排 / 停掉定时检查
  ipcMain.handle('update:set-auto', (event, payload) => {
    const enabled = !(payload && payload.enabled === false);
    if (enabled) scheduleAutoChecks();
    else stopAutoChecks();
    return snapshot();
  });

  ipcMain.handle('update:check', async () => {
    await checkForUpdates();
    await ensureCurrentRelease();
    return snapshot();
  });

  ipcMain.handle('update:download', async () => startDownload({ auto: false }));
  ipcMain.handle('update:cancel-download', () => {
    cancelDownload();
    return snapshot();
  });
  ipcMain.handle('update:install', () => installUpdate());

  // gh-proxy 加速开关：开关值由渲染进程写进 config.json（与自动更新同一套做法），
  // 这里只是回一份最新快照，让界面与下一次检查 / 下载实际采用的行为保持一致
  ipcMain.handle('update:set-gh-proxy', () => snapshot());

  ipcMain.handle('update:open-release', (event) => {
    const url = state.update && state.update.releaseUrl ? state.update.releaseUrl : RELEASE_PAGE_URL;
    shell.openExternal(url).catch((error) => {
      console.error('[Esprin Nemo] 打开发布页失败:', error);
    });
    return true;
  });

  // 项目地址：在系统浏览器里打开仓库主页
  ipcMain.handle('update:open-repo', () => {
    shell.openExternal(REPO_URL).catch((error) => {
      console.error('[Esprin Nemo] 打开项目主页失败:', error);
    });
    return true;
  });

  // 打开已下载安装包所在的目录（开发运行下手动安装用）
  ipcMain.handle('update:open-file', () => {
    if (state.downloadedFile && fs.existsSync(state.downloadedFile)) {
      shell.showItemInFolder(state.downloadedFile);
    }
    return true;
  });
}

module.exports = {
  PORTABLE_ARG,
  isPortableRun,
  configureUpdater,
  registerUpdateIpc,
  scheduleAutoChecks
};
