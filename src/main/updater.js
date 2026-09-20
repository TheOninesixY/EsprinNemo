/* 应用更新：检查新版本、下载安装包，再把安装包交回安装程序完成升级。
   整个流程只用 Node 内置模块，不引入第三方依赖：
   - 检查：GET /repos/{owner}/{repo}/releases/latest（GitHub Releases API）
     取该 release 的 tag（形如 v0.0.0）与当前版本逐段比较，比当前版本高才会提醒更新。
   - 下载：取该 release 里符合命名规则的附件（Windows 要求文件名里有独立的 setup 段且以
     .exe 结尾，例如 “Esprin Nemo Setup 2.1.2.exe” 或 “en.Setup.123.exe”）
   - 安装：把安装包以
       "Esprin Nemo Setup x.y.z.exe" --upgrade --updated --force-run
     运行。--upgrade 由安装脚本（src/win_installer/installer.nsh）识别：不显示任何向导页
     与对话框，只留一个安装进度页（进度条 + “正在更新”标题），安装结束后自动重新打开应用；
     --updated / --force-run 是 electron-builder 自带的开关，用于跳过向导页并等待旧进程退出。

   便携版、开发运行（bun start）与非 Windows 平台不支持自动安装，此时只下载安装包
   并打开它所在的目录，由用户手动完成安装。 */
const { app, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { showDialogWindow } = require('./dialog_window.js');

// 更新源：仓库的 Releases 里上传安装包即可被检查到（改仓库地址时改这里）
const UPDATE_REPO = 'TheOninesixY/EsprinNemo';
const RELEASE_PAGE_URL = `https://github.com/${UPDATE_REPO}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

const USER_AGENT = 'EsprinNemo-Updater';
const REQUEST_TIMEOUT_MS = 20000;
// 重定向跟随次数与 API 响应体上限（正常响应只有几 KB）
const MAX_REDIRECTS = 5;
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

// 由 main.js 注入：读取用户配置（config.json）与取主窗口（弹窗的父窗口）
let readUserConfig = () => ({});
let getOwnerWindow = () => null;
let ipcRegistered = false;

function configureUpdater({ getConfig, getOwner } = {}) {
  if (typeof getConfig === 'function') readUserConfig = getConfig;
  if (typeof getOwner === 'function') getOwnerWindow = getOwner;
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

// 便携版：electron-builder 的 portable 目标会在启动时写入这几个环境变量
function isPortable() {
  return !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

// 能否自动安装：仅 Windows 安装版（开发运行与便携版都只能手动安装）
function canAutoInstall() {
  return process.platform === 'win32' && app.isPackaged && !isPortable();
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
    // 更新源：仓库名与发布页地址，界面上作为说明文字展示
    source: UPDATE_REPO,
    sourceUrl: RELEASE_PAGE_URL,
    autoUpdate: readConfigAutoUpdate(),
    canAutoInstall: canAutoInstall(),
    portable: isPortable(),
    packaged: app.isPackaged,
    checking: state.checking,
    downloading: state.downloading,
    downloaded: isDownloaded(),
    progress: state.progress ? { ...state.progress } : null,
    lastCheckAt: state.lastCheckAt,
    error: state.error,
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

function requestJson(url, redirects = 0) {
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
        resolve(requestJson(new URL(response.headers.location, url).href, redirects + 1));
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
      const release = await requestJson(LATEST_RELEASE_API);
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

// 下载安装包：重定向跟随 + 进度回调 + 可取消。返回 Promise，取消时以 canceled 标记拒绝
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

  // 下载放到后台跑：界面立刻拿到返回值，后续进度通过 update:state 事件推送
  downloadPackage(update.asset.url, target, onProgress).then((result) => {
    state.request = null;
    state.downloading = false;

    // 体积与文件头校验：避免把半截文件或错误页面当成安装包
    const expected = result.declared || update.asset.size || 0;
    if (expected && result.received !== expected) {
      throw new Error(`安装包不完整（${result.received}/${expected} 字节）`);
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

    finishDownload(target, update.version, expected, result.received, { auto: state.autoFlow });
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

  // 便携版 / 开发运行 / 非 Windows：只能手动安装，这里打开文件所在目录
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
// 开发运行（bun start）不参与自动流程：源码本来就不是通过更新包分发的，
// 设置页里的「检查更新」仍可手动使用。
async function runAutoCheck() {
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
      : '当前运行方式（便携版或开发运行）不支持自动安装，请用下载好的安装包手动升级。',
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
  } else if (choice.id === 'open') {
    shell.showItemInFolder(state.downloadedFile);
  }
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
  ipcRegistered = true;

  ipcMain.handle('update:get-info', () => snapshot());

  // 自动更新开关：渲染进程改完后立即落盘配置，这里只需重新安排 / 停掉定时检查
  ipcMain.handle('update:set-auto', (event, payload) => {
    const enabled = !(payload && payload.enabled === false);
    if (enabled) scheduleAutoChecks();
    else stopAutoChecks();
    return snapshot();
  });

  ipcMain.handle('update:check', async () => {
    await checkForUpdates();
    return snapshot();
  });

  ipcMain.handle('update:download', async () => startDownload({ auto: false }));
  ipcMain.handle('update:cancel-download', () => {
    cancelDownload();
    return snapshot();
  });
  ipcMain.handle('update:install', () => installUpdate());

  ipcMain.handle('update:open-release', (event) => {
    const url = state.update && state.update.releaseUrl ? state.update.releaseUrl : RELEASE_PAGE_URL;
    shell.openExternal(url).catch((error) => {
      console.error('[Esprin Nemo] 打开发布页失败:', error);
    });
    return true;
  });

  // 打开已下载安装包所在的目录（便携版 / 开发运行下手动安装用）
  ipcMain.handle('update:open-file', () => {
    if (state.downloadedFile && fs.existsSync(state.downloadedFile)) {
      shell.showItemInFolder(state.downloadedFile);
    }
    return true;
  });
}

module.exports = {
  configureUpdater,
  registerUpdateIpc,
  scheduleAutoChecks
};
