const { app, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { showDialogWindow } = require('./dialog_window.js');

const UPDATE_REPO = 'EsprinProject/Nemo';

const REPO_URL = `https://github.com/${UPDATE_REPO}`;
const RELEASE_PAGE_URL = `${REPO_URL}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

const releaseTagApi = (tag) => `https://api.github.com/repos/${UPDATE_REPO}/releases/tags/${encodeURIComponent(tag)}`;

const GH_PROXY_PREFIX = 'https://gh-proxy.com/';

const PROXYABLE_URL_PATTERN = /^https?:\/\/(?:[\w.-]+\.)?(?:github\.com|githubusercontent\.com)\//i;

const USER_AGENT = 'EsprinNemo-Updater';
const REQUEST_TIMEOUT_MS = 20000;

const MAX_REDIRECTS = 8;
const MAX_API_BYTES = 2 * 1024 * 1024;

const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

const FIRST_CHECK_DELAY_MS = 12000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const PROGRESS_INTERVAL_MS = 300;

const SETUP_SEGMENT_PATTERN = /(^|[.\s_\-])setup([.\s_\-]|$)/i;
const EXE_FILE_PATTERN = /\.exe$/i;
const APPIMAGE_FILE_PATTERN = /\.appimage$/i;

const state = {
  status: 'idle',
  checking: false,
  downloading: false,

  request: null,
  canceled: false,

  update: null,

  currentRelease: null,

  currentReleaseStatus: 'idle',
  currentReleaseError: '',
  downloadedFile: '',

  downloadedVersion: '',
  progress: null,
  error: '',
  lastCheckAt: 0,

  autoFlow: false
};

let firstCheckTimer = null;
let checkIntervalTimer = null;
let progressSentAt = 0;

let readUserConfig = () => ({});
let getOwnerWindow = () => null;
let writeUserConfig = () => false;
let ipcRegistered = false;

function configureUpdater({ getConfig, getOwner, setConfig } = {}) {
  if (typeof getConfig === 'function') readUserConfig = getConfig;
  if (typeof getOwner === 'function') getOwnerWindow = getOwner;
  if (typeof setConfig === 'function') writeUserConfig = setConfig;
}

function asString(value) {
  return value == null ? '' : String(value);
}

function normalizeVersion(value) {
  const matched = asString(value).trim().replace(/^[vV]/, '').match(/^\d+(?:\.\d+)*/);
  return matched ? matched[0] : '';
}

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

const PORTABLE_ARG = '--esprin-nemo-portable';

function isLinuxPlatform() {
  return process.platform === 'linux';
}

function isPortableRun() {
  return !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

function canAutoInstall() {
  return app.isPackaged && !isPortableRun() && !isLinuxPlatform();
}

function readConfigAutoUpdate() {
  try {
    const config = readUserConfig();
    return !(config && config.autoUpdate === false);
  } catch (error) {
    return true;
  }
}

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

    repoUrl: REPO_URL,
    autoUpdate: readConfigAutoUpdate(),

    ghProxyEnabled: readConfigGhProxy(),
    canAutoInstall: canAutoInstall(),
    packaged: app.isPackaged,
    checking: state.checking,
    downloading: state.downloading,
    downloaded: isDownloaded(),
    progress: state.progress ? { ...state.progress } : null,
    lastCheckAt: state.lastCheckAt,
    error: state.error,

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

function notifyAutoUpdateDisabled() {
  const win = getOwnerWindow();
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send('update:auto-disabled', { reason: 'muted' });
}

function disableAutoUpdate() {
  stopAutoChecks();
  const saved = writeUserConfig({ autoUpdate: false });
  if (!saved) console.error('[Esprin Nemo] 关闭自动更新失败：配置未能写入');
  notifyAutoUpdateDisabled();
  broadcast();
}

function isRedirectStatus(code) {
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

function describeNetworkError(error) {
  const code = error && error.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析更新源地址，请检查网络连接';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') return '连接更新源失败，请稍后重试';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return '更新源的 HTTPS 证书校验失败';
  return asString(error && error.message) || '检查更新失败';
}

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

function ghProxyUrl(url) {
  const target = asString(url);
  return PROXYABLE_URL_PATTERN.test(target) ? `${GH_PROXY_PREFIX}${target}` : '';
}

function githubUrls(url) {
  const direct = asString(url);
  if (!readConfigGhProxy()) return [direct];
  const proxied = ghProxyUrl(direct);
  return proxied ? [proxied, direct] : [direct];
}

async function requestGithubJson(url, { allowNotFound = false } = {}) {
  const urls = githubUrls(url);
  let lastError = null;

  for (let i = 0; i < urls.length; i++) {
    try {

      return await requestJson(urls[i], 0, { allowNotFound });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('请求更新源失败');
}

function hasPackageExtension(name) {
  const lower = asString(name).toLowerCase();
  return isLinuxPlatform() ? APPIMAGE_FILE_PATTERN.test(lower) : lower.endsWith('.exe');
}

function isPackageName(name) {
  const value = asString(name);
  if (isLinuxPlatform()) return APPIMAGE_FILE_PATTERN.test(value);
  return EXE_FILE_PATTERN.test(value) && SETUP_SEGMENT_PATTERN.test(value);
}

function pickAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return list.find((asset) => asset && asset.browser_download_url && isPackageName(asset.name)) || null;
}

let pendingCheck = null;

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

let pendingCurrentRelease = null;

function ensureCurrentRelease() {
  if (pendingCurrentRelease) return pendingCurrentRelease;

  const version = currentVersion();
  if (!version) return Promise.resolve(snapshot());

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

  const attempt = (retry) => {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch (error) {
      if (retry) setTimeout(() => attempt(false), 800);
    }
  };
  attempt(true);
}

function downloadDir() {
  if (isLinuxPlatform()) {
    try {
      const dir = app.getPath('downloads');
      if (dir) return dir;
    } catch (error) {

    }
  }
  return app.getPath('temp');
}

function downloadPackage(url, target, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {

    let file = null;
    const closeFile = () => {
      if (!file) return;
      try {
        file.destroy();
      } catch (error) {

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

function verifyPackage(target, expected, received, ext) {
  if (expected && received !== expected) {
    throw new Error(`安装包不完整（${received}/${expected} 字节）`);
  }
  const head = Buffer.alloc(4);
  const handle = fs.openSync(target, 'r');
  try {
    fs.readSync(handle, head, 0, 4, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (ext === '.exe' && head.subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new Error('下载到的文件不是有效的安装包');
  }
  if (APPIMAGE_FILE_PATTERN.test(ext) && head.toString('binary') !== '\x7fELF') {
    throw new Error('下载到的文件不是有效的 AppImage');
  }
  if (APPIMAGE_FILE_PATTERN.test(ext)) {
    fs.chmodSync(target, 0o755);
  }
}

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

      removeFileQuietly(target);
      if (i < urls.length - 1) {

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

  }
  return true;
}

function finishDownload(target, version, total, received, { auto = false } = {}) {
  state.downloadedFile = target;
  state.downloadedVersion = version;
  state.progress = { received, total: total || received, percent: 100, bytesPerSecond: 0 };
  setStatus('downloaded');
  broadcast();

if (auto) {
    setTimeout(() => {
      promptInstallReady().catch((error) => {
        console.error('[Esprin Nemo] 提示安装更新失败:', error);
      });
    }, 0);
  }
}

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

  const ext = path.extname(update.asset.name) || (isLinuxPlatform() ? '.AppImage' : '.exe');
  const target = path.join(downloadDir(), `EsprinNemo-Update-${update.version}${ext}`);

const assetSize = update.asset.size || 0;
  if (assetSize && fs.existsSync(target)) {
    try {
      if (fs.statSync(target).size === assetSize) {
        finishDownload(target, update.version, assetSize, assetSize, { auto });
        return { ok: true, reused: true };
      }
    } catch (error) {

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

async function installUpdate() {
  const file = state.downloadedFile;
  if (!file || !fs.existsSync(file)) {
    return { ok: false, error: '还没有下载好的安装包' };
  }

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

setTimeout(() => app.quit(), 400);
  return { ok: true };
}

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
      : (isLinuxPlatform()
        ? '当前系统不支持自动安装：请用文件管理器把下载好的 AppImage 放到你平时运行的位置并覆盖旧文件，再重新启动。'
        : '当前为开发运行，不支持自动安装，请用下载好的安装包手动升级。'),

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

function scheduleAutoChecks() {
  stopAutoChecks();

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

  }
}

function registerUpdateIpc() {
  if (ipcRegistered) return;

  if (isPortableRun()) return;
  ipcRegistered = true;

  ipcMain.handle('update:get-info', () => {

    ensureCurrentRelease();
    return snapshot();
  });

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

ipcMain.handle('update:set-gh-proxy', () => snapshot());

  ipcMain.handle('update:open-release', (event) => {
    const url = state.update && state.update.releaseUrl ? state.update.releaseUrl : RELEASE_PAGE_URL;
    shell.openExternal(url).catch((error) => {
      console.error('[Esprin Nemo] 打开发布页失败:', error);
    });
    return true;
  });

ipcMain.handle('update:open-repo', () => {
    shell.openExternal(REPO_URL).catch((error) => {
      console.error('[Esprin Nemo] 打开项目主页失败:', error);
    });
    return true;
  });

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