const fs = require('node:fs');
const path = require('node:path');

// 主进程通过 webPreferences.additionalArguments 把解析好的数据目录传给渲染进程
const DATA_DIR_ARG = '--esprin-nemo-data-dir=';

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

function getDataDir(baseDir = __dirname, appLike = null) {
  const app = getApp(appLike);

  // 1. 安装版（打包后）：%APPDATA%/esprin_nemo/data
  if (app && app.isPackaged && typeof app.getPath === 'function') {
    return path.join(app.getPath('appData'), 'esprin_nemo', 'data');
  }

  // 2. 渲染进程：使用主进程传下来的目录，保证与主进程一致
  const argDir = getDataDirFromArgv();
  if (argDir) return argDir;

  // 3. 开发版 / 未打包：项目内 data/
  return path.join(baseDir || __dirname, 'data');
}

// 安装版首次运行时，把随应用分发的项目内 data/ 迁移到用户数据目录
function migrateLegacyData(dir, baseDir = __dirname, appLike = null) {
  const app = getApp(appLike);
  if (!app || !app.isPackaged || typeof app.getPath !== 'function') return;

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
  getDataDir,
  getDataDirFromArgv,
  ensureDataDir
};
