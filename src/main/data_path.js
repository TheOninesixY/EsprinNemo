const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR_ARG = '--esprin-nemo-data-dir=';

const DEFAULT_APP_DIR_NAME = 'esprin_nemo';
const LINUX_APP_DIR_NAME = 'EsprinNemo';
const DATA_PATH_FILE_NAME = 'data_path.json';

const USER_DATA_DIR_NAME = 'user_data';
const DEV_USER_DATA_DIR_NAME = 'dev_user_data';

function getApp(appLike = null) {
  if (appLike) return appLike;
  try {

    return require('electron').app || null;
  } catch (error) {
    return null;
  }
}

function getPortableDir() {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR;
  const file = process.env.PORTABLE_EXECUTABLE_FILE;
  const raw = (typeof dir === 'string' && dir.trim())
    || (typeof file === 'string' && file.trim() ? path.dirname(file.trim()) : '');
  if (!raw) return null;
  try {
    return path.resolve(raw);
  } catch (error) {
    return null;
  }
}

let portableDirResolved = false;
let portableDir = null;
let portableDirWritable = false;

function resolvePortableDir() {
  if (!portableDirResolved) {
    portableDirResolved = true;
    const dir = getPortableDir();
    if (dir) {
      portableDir = dir;
      portableDirWritable = ensureDirUsable(dir);
      if (!portableDirWritable) {
        console.warn('[Esprin Nemo] 便携版运行目录不可写:', dir);
      }
    }
  }
  return portableDir;
}

function isPortableRun() {
  return !!getPortableDir();
}

function getDataDirFromArgv(argv = process.argv) {
  if (!Array.isArray(argv)) return null;
  const matched = argv.find((item) => typeof item === 'string' && item.startsWith(DATA_DIR_ARG));
  if (!matched) return null;
  const dir = matched.slice(DATA_DIR_ARG.length).trim();
  return dir || null;
}

function isLinuxPlatform() {
  return process.platform === 'linux';
}

function getSystemDataHome(appLike = null) {
  if (isLinuxPlatform()) {
    const xdgDataHome = process.env.XDG_DATA_HOME;
    if (typeof xdgDataHome === 'string' && xdgDataHome.trim() && path.isAbsolute(xdgDataHome.trim())) {
      return path.resolve(xdgDataHome.trim());
    }
    try {
      const home = os.homedir();
      if (home) return path.join(home, '.local', 'share');
    } catch (error) {

    }
    return null;
  }

  const app = getApp(appLike);
  if (!app || typeof app.getPath !== 'function') return null;
  try {
    return app.getPath('appData');
  } catch (error) {
    return null;
  }
}

function getAppDataConfigDir(appLike = null) {
  const base = getSystemDataHome(appLike);
  if (!base) return null;
  return path.join(base, isLinuxPlatform() ? LINUX_APP_DIR_NAME : DEFAULT_APP_DIR_NAME);
}

function getConfigDir(appLike = null) {
  if (isPortableRun()) return resolvePortableDir();
  return getAppDataConfigDir(appLike);
}

function getLocationFile(appLike = null) {
  const configDir = getConfigDir(appLike);
  return configDir ? path.join(configDir, DATA_PATH_FILE_NAME) : null;
}

function getIsolatedUserDataDir(appLike = null) {
  const portable = resolvePortableDir();
  if (portable) return path.join(portable, USER_DATA_DIR_NAME);
  if (!isDevRun(appLike)) return null;

  const configDir = getAppDataConfigDir(appLike);
  if (!configDir) return null;
  const dir = path.join(configDir, DEV_USER_DATA_DIR_NAME);
  if (!ensureDirUsable(dir)) {
    console.warn('[Esprin Nemo] 开发运行的独立运行时目录不可用，沿用默认 profile:', dir);
    return null;
  }
  return dir;
}

function normalizeRecordedDir(value) {
  if (typeof value !== 'string') return null;
  const dir = value.trim().replace(/\\/g, '/');
  return dir || null;
}

function parseDataDirRecord(text) {
  const matched = text.match(/"dataDir"\s*:\s*"([^"]*)"/);
  try {
    const parsed = JSON.parse(text);
    const dir = normalizeRecordedDir(parsed && parsed.dataDir);
    if (dir && !/[\u0000-\u001f]/.test(dir)) return dir;
  } catch (error) {

  }
  return matched ? normalizeRecordedDir(matched[1]) : null;
}

function readStoredDataDir(appLike = null) {
  const file = getLocationFile(appLike);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const text = decodeTextFile(fs.readFileSync(file)).replace(/\uFEFF/g, '');
    const dir = parseDataDirRecord(text);
    if (!dir) {
      console.warn('[Esprin Nemo] 数据位置记录无法解析:', file);
      return null;
    }

    if (dir.includes('\uFFFD')) {
      console.warn('[Esprin Nemo] 数据位置记录无法解码，已回退到默认位置:', file);
      return null;
    }

    return path.resolve(dir);
  } catch (error) {
    console.warn('[Esprin Nemo] 读取数据位置记录失败:', error);
    return null;
  }
}

function writeFileAtomic(filePath, text) {
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, text, 'utf8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (cleanupError) {

    }
    throw error;
  }
}

function writeStoredDataDir(dir, appLike = null) {

  if (isDevRun(appLike)) {
    console.warn('[Esprin Nemo] 开发运行下忽略数据位置记录的写入');
    return false;
  }
  const file = getLocationFile(appLike);
  if (!file) return false;
  try {
    if (!dir) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record = { dataDir: path.resolve(dir).replace(/\\/g, '/') };
    writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch (error) {
    console.error('[Esprin Nemo] 保存数据位置失败:', error);
    return false;
  }
}

function isDevRun(appLike = null) {
  const app = getApp(appLike);
  return !(app && app.isPackaged);
}

function ensureDirUsable(dir) {
  const probe = dir ? path.join(dir, `.esprin-nemo-write-test-${process.pid}-${Date.now()}`) : null;
  try {
    if (!dir) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, '');
    return true;
  } catch (error) {
    console.warn(`[Esprin Nemo] 数据目录不可用 ${dir}:`, error.message);
    return false;
  } finally {
    try {
      if (probe && fs.existsSync(probe)) fs.unlinkSync(probe);
    } catch (error) {

    }
  }
}

function decodeTextFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le', 2);
  }
  if (buffer.includes(0)) return buffer.toString('utf16le');
  return buffer.toString('utf8');
}

function getDefaultDataDir(baseDir = __dirname, appLike = null) {

if (isPortableRun()) return path.join(resolvePortableDir(), 'data');
  const app = getApp(appLike);
  if (app && app.isPackaged) {
    const configDir = getAppDataConfigDir(appLike);
    if (configDir) return path.join(configDir, 'data');
  }
  return path.join(baseDir || __dirname, 'data');
}

function getDataDir(baseDir = __dirname, appLike = null) {

  const argDir = getDataDirFromArgv();
  if (argDir) return argDir;

if (isDevRun(appLike)) return getDefaultDataDir(baseDir, appLike);

const stored = readStoredDataDir(appLike);
  if (stored) {
    if (ensureDirUsable(stored)) return stored;
    console.warn('[Esprin Nemo] 记录的数据位置不可用，已回退到默认位置:', stored);
  }

return getDefaultDataDir(baseDir, appLike);
}

function migrateLegacyData(dir, baseDir = __dirname, appLike = null) {
  const app = getApp(appLike);
  if (isDevRun(appLike) || typeof app.getPath !== 'function') return;

if (readStoredDataDir(appLike)) return;

  const legacyDir = path.join(baseDir || __dirname, 'data');
  if (legacyDir === dir || !fs.existsSync(legacyDir)) return;

  try {
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
      fs.cpSync(legacyDir, dir, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn('[Esprin Nemo] 迁移旧数据失败:', error);
  }
}

function ensureDataDir(baseDir = __dirname, appLike = null) {
  const dir = getDataDir(baseDir, appLike);
  fs.mkdirSync(dir, { recursive: true });
  migrateLegacyData(dir, baseDir, appLike);
  return dir;
}

function getStartupBlocker(baseDir = __dirname, appLike = null) {

  if (isDevRun(appLike)) return null;

  const portable = resolvePortableDir();
  if (!portable) return null;

  const recordFile = getLocationFile(appLike) || '';

if (!portableDirWritable) {
    return {
      kind: 'portable-dir',
      reason: '便携版所在目录无法写入',
      dir: portable,

      dataDir: readStoredDataDir(appLike) || path.join(portable, 'data'),
      recordFile
    };
  }

const stored = readStoredDataDir(appLike);
  if (stored && !ensureDirUsable(stored)) {
    return {
      kind: 'recorded-dir',
      reason: '记录的数据位置无法写入',
      dir: portable,
      dataDir: stored,
      recordFile
    };
  }

const dir = getDataDir(baseDir, appLike);
  if (!ensureDirUsable(dir)) {
    return {
      kind: 'data-dir',
      reason: '数据目录无法创建或写入',
      dir: portable,
      dataDir: dir,
      recordFile
    };
  }
  return null;
}

module.exports = {
  DATA_DIR_ARG,
  isDevRun,
  isLinuxPlatform,
  isPortableRun,
  getConfigDir,
  getAppDataConfigDir,
  getSystemDataHome,
  getLocationFile,
  getIsolatedUserDataDir,
  getDefaultDataDir,
  writeFileAtomic,
  writeStoredDataDir,
  getStartupBlocker,
  ensureDataDir
};
