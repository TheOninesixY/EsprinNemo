const fs = require('node:fs');
const path = require('node:path');

// 主进程通过 webPreferences.additionalArguments 把解析好的数据目录传给渲染进程
const DATA_DIR_ARG = '--esprin-nemo-data-dir=';

// 用户自定义数据位置的记录文件：必须放在数据目录之外（否则切换后就找不到记录了），
// 因此固定存于应用配置目录（userData）下。
const LOCATION_FILE_NAME = 'data-location.json';
const DEFAULT_APP_DIR_NAME = 'esprin_nemo';

function getApp(appLike = null) {
  if (appLike) return appLike;
  try {
    // 渲染进程中 require('electron').app 不存在，会走下面的 null 分支
    return require('electron').app || null;
  } catch (error) {
    return null;
  }
}

// 读取命令行传入的数据目录（仅渲染进程会带上该参数）
function getDataDirFromArgv(argv = process.argv) {
  if (!Array.isArray(argv)) return null;
  const matched = argv.find((item) => typeof item === 'string' && item.startsWith(DATA_DIR_ARG));
  if (!matched) return null;
  const dir = matched.slice(DATA_DIR_ARG.length).trim();
  return dir || null;
}

// 应用配置目录：优先 userData，回退到 %APPDATA%/esprin_nemo
function getConfigDir(appLike = null) {
  const app = getApp(appLike);
  if (!app || typeof app.getPath !== 'function') return null;
  try {
    return app.getPath('userData');
  } catch (error) {
    // 继续尝试 appData 回退
  }
  try {
    return path.join(app.getPath('appData'), DEFAULT_APP_DIR_NAME);
  } catch (error) {
    return null;
  }
}

function getLocationFile(appLike = null) {
  const configDir = getConfigDir(appLike);
  return configDir ? path.join(configDir, LOCATION_FILE_NAME) : null;
}

// 读取用户自定义的数据目录；未设置或文件损坏时返回 null
function readStoredDataDir(appLike = null) {
  const file = getLocationFile(appLike);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dir = parsed && typeof parsed.dataDir === 'string' ? parsed.dataDir.trim() : '';
    return dir || null;
  } catch (error) {
    console.warn('[Esprin Nemo] 读取数据位置记录失败:', error);
    return null;
  }
}

// 写入自定义数据目录；dir 为空表示清除记录（恢复默认位置）
function writeStoredDataDir(dir, appLike = null) {
  const file = getLocationFile(appLike);
  if (!file) return false;
  try {
    if (!dir) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ dataDir: dir }, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.error('[Esprin Nemo] 保存数据位置失败:', error);
    return false;
  }
}

// 目录必须可创建且可写，否则视为不可用
function ensureDirUsable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (error) {
    console.warn(`[Esprin Nemo] 数据目录不可用 ${dir}:`, error.message);
    return false;
  }
}

// 默认数据目录：安装版 %APPDATA%/esprin_nemo/data，开发版项目内 data/
function getDefaultDataDir(baseDir = __dirname, appLike = null) {
  const app = getApp(appLike);
  if (app && app.isPackaged && typeof app.getPath === 'function') {
    return path.join(app.getPath('appData'), DEFAULT_APP_DIR_NAME, 'data');
  }
  return path.join(baseDir || __dirname, 'data');
}

function getDataDir(baseDir = __dirname, appLike = null) {
  // 1. 渲染进程：直接使用主进程传下来的最终目录（主进程已完成解析与校验）
  const argDir = getDataDirFromArgv();
  if (argDir) return argDir;

  // 2. 用户在设置中自定义的位置优先；不可用时回退到默认位置，避免应用无法启动
  const stored = readStoredDataDir(appLike);
  if (stored) {
    if (path.isAbsolute(stored) && ensureDirUsable(stored)) return stored;
    console.warn('[Esprin Nemo] 自定义数据位置不可用，已回退到默认位置:', stored);
  }

  // 3. 默认位置
  return getDefaultDataDir(baseDir, appLike);
}

// 安装版首次运行时，把随应用分发的项目内 data/ 迁移到用户数据目录
function migrateLegacyData(dir, baseDir = __dirname, appLike = null) {
  const app = getApp(appLike);
  if (!app || !app.isPackaged || typeof app.getPath !== 'function') return;

  // 用户已显式指定了数据位置时不做迁移，避免把随应用分发的内容写入用户目录
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

module.exports = {
  DATA_DIR_ARG,
  getDefaultDataDir,
  writeStoredDataDir,
  ensureDataDir
};
