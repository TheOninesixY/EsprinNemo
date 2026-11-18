const { app, nativeImage } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ARG_PREFIX = '--esprin-nemo-wallpaper=';

const REGISTRY_KEY = 'HKCU\\Control Panel\\Desktop';

const MAX_WIDTH = 2560;
const JPEG_QUALITY = 85;

const WATCH_DEBOUNCE_MS = 600;
const POLL_INTERVAL_MS = 30000;

const CACHE_FILE_NAME = 'current.jpg';

let snapshot = { url: '', signature: '', source: '', reason: 'idle' };

let watchers = [];
let pollTimer = null;
let debounceTimer = null;
let onChanged = null;

function themesDir() {
  const appData = process.env.APPDATA;
  return typeof appData === 'string' && appData ? path.join(appData, 'Microsoft', 'Windows', 'Themes') : '';
}

function registryExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'reg.exe');
  return fs.existsSync(candidate) ? candidate : 'reg.exe';
}

function expandEnv(value) {
  return String(value || '').replace(/%([^%]+)%/g, (matched, name) => process.env[name] || matched);
}

function readRegistryWallpaper() {
  if (process.platform !== 'win32') return '';
  try {
    const output = execFileSync(registryExe(), ['query', REGISTRY_KEY, '/v', 'Wallpaper'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 4000
    });
    const matched = String(output).match(/Wallpaper\s+REG_[A-Z_]+\s+(.+)/);
    return matched ? expandEnv(matched[1].trim()) : '';
  } catch (error) {
    return '';
  }
}

function fileStat(target) {
  try {
    const stat = fs.statSync(target);
    return stat.isFile() ? stat : null;
  } catch (error) {
    return null;
  }
}

function newestCachedImage(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return '';
  }
  let picked = '';
  let pickedTime = -1;
  names.forEach((name) => {
    if (!/\.(jpe?g|png|bmp)$/i.test(name)) return;
    const target = path.join(dir, name);
    const stat = fileStat(target);
    if (!stat || stat.mtimeMs <= pickedTime) return;
    picked = target;
    pickedTime = stat.mtimeMs;
  });
  return picked;
}

function candidateSources() {
  if (process.platform !== 'win32') return [];

  const seen = new Set();
  const entries = [];
  const push = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    const stat = fileStat(candidate);
    if (!stat) return;
    entries.push({ source: candidate, stat });
  };

  push(readRegistryWallpaper());

  const themed = themesDir();
  if (themed) {
    push(path.join(themed, 'TranscodedWallpaper'));
    push(newestCachedImage(path.join(themed, 'CachedFiles')));
  }

  return entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

function cacheFile() {
  return path.join(app.getPath('userData'), 'wallpaper', CACHE_FILE_NAME);
}

function writeCache(image) {
  const size = image.getSize();
  let prepared = image;
  if (size.width > MAX_WIDTH) prepared = image.resize({ width: MAX_WIDTH, quality: 'good' });

  const buffer = prepared.toJPEG(JPEG_QUALITY);
  if (!buffer || !buffer.length) return '';

  const target = cacheFile();
  const temp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, target);
  return target;
}

function decodeImage(source) {
  try {
    const buffer = fs.readFileSync(source);
    const image = nativeImage.createFromBuffer(buffer);
    return image && !image.isEmpty() ? image : null;
  } catch (error) {
    return null;
  }
}

function fail(reason, source) {
  snapshot = { url: '', signature: '', source: source || '', reason };
  return snapshot;
}

function refreshWallpaper() {
  if (process.platform !== 'win32') return fail('unsupported');

  const candidates = candidateSources();
  if (!candidates.length) return fail('missing');

  let source = '';
  let signature = '';
  let image = null;

  for (const candidate of candidates) {
    const nextSignature = `${candidate.source}\u0000${candidate.stat.mtimeMs}\u0000${candidate.stat.size}`;
    if (!image && nextSignature === snapshot.signature && snapshot.url) return snapshot;

    const decoded = decodeImage(candidate.source);
    if (!decoded) continue;
    source = candidate.source;
    signature = nextSignature;
    image = decoded;
    break;
  }

  if (!image) {
    console.warn('[WARN] [Nemo] 桌面壁纸不可用，回退主题背景');
    return fail('undecodable');
  }

  let target = '';
  try {
    target = writeCache(image);
  } catch (error) {
    console.warn('[WARN] [Nemo] 写入壁纸缓存失败，回退主题背景:', error.message);
    return fail('write-failed', source);
  }
  if (!target) {
    console.warn('[WARN] [Nemo] 壁纸缓存为空，回退主题背景:', source);
    return fail('write-failed', source);
  }

  const size = image.getSize();
  snapshot = {
    url: `${pathToFileURL(target).href}?v=${encodeURIComponent(signature)}`,
    signature,
    source,
    reason: 'ok',
    width: size.width,
    height: size.height
  };
  console.log(`[INFO] [Nemo] 桌面壁纸已就绪：${path.basename(source)}（${size.width}×${size.height}）`);
  return snapshot;
}

function getWallpaperSnapshot() {
  if (snapshot.url) return snapshot;
  return refreshWallpaper();
}

function wallpaperArg(snapshotValue) {
  const value = snapshotValue && typeof snapshotValue.url === 'string' ? snapshotValue.url.trim() : '';
  return value ? `${ARG_PREFIX}${value}` : '';
}

function notifyIfChanged(previous) {
  const next = refreshWallpaper();
  if (next.signature === previous.signature) return;
  if (typeof onChanged === 'function') onChanged(next);
}

function scheduleRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    notifyIfChanged(snapshot);
  }, WATCH_DEBOUNCE_MS);
  if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
}

function closeWatchers() {
  watchers.forEach((item) => {
    try {
      item.close();
    } catch (error) {
    }
  });
  watchers = [];
}

function watchDirs() {
  const dirs = [];
  const themed = themesDir();
  if (themed) {
    dirs.push(themed);
    dirs.push(path.join(themed, 'CachedFiles'));
  }
  return dirs.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch (error) {
      return false;
    }
  });
}

function startWallpaperWatch(handler) {
  if (typeof handler === 'function') onChanged = handler;

  if (watchers.length || pollTimer) return getWallpaperSnapshot();

  const current = refreshWallpaper();
  if (process.platform !== 'win32') return current;

  watchDirs().forEach((dir) => {
    try {
      const item = fs.watch(dir, { persistent: false }, () => scheduleRefresh());
      item.on('error', () => closeWatchers());
      watchers.push(item);
    } catch (error) {
    }
  });

  pollTimer = setInterval(() => {
    notifyIfChanged(snapshot);
  }, POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  return current;
}

function disposeWallpaper() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  closeWatchers();
  onChanged = null;
}

module.exports = {
  ARG_PREFIX,
  disposeWallpaper,
  getWallpaperSnapshot,
  startWallpaperWatch,
  wallpaperArg
};
