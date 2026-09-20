const fs = require('node:fs');
const path = require('node:path');

// 主进程通过 webPreferences.additionalArguments 把解析好的数据目录传给渲染进程
const DATA_DIR_ARG = '--esprin-nemo-data-dir=';

// 数据位置记录：%APPDATA%/esprin_nemo/data_path.json。必须放在数据目录之外（否则切换后
// 就找不到记录了），同时也是安装向导（见 src/win_installer/installer.nsh）读写的同一个文件。
const DEFAULT_APP_DIR_NAME = 'esprin_nemo';
const DATA_PATH_FILE_NAME = 'data_path.json';

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

// 配置目录：固定为 %APPDATA%/esprin_nemo，与安装向导写记录文件的位置保持一致
function getConfigDir(appLike = null) {
  const app = getApp(appLike);
  if (!app || typeof app.getPath !== 'function') return null;
  try {
    return path.join(app.getPath('appData'), DEFAULT_APP_DIR_NAME);
  } catch (error) {
    return null;
  }
}

function getLocationFile(appLike = null) {
  const configDir = getConfigDir(appLike);
  return configDir ? path.join(configDir, DATA_PATH_FILE_NAME) : null;
}

// 记录里的路径统一以正斜杠保存：安装向导（NSIS）不擅长转义反斜杠，这样两边都能安全读写
function normalizeRecordedDir(value) {
  if (typeof value !== 'string') return null;
  const dir = value.trim().replace(/\\/g, '/');
  return dir || null;
}

// 解析记录文件：应用写的是标准 JSON；安装向导写出的路径可能未转义反斜杠，
// 因此 JSON 解析失败、或结果里混进了制表符之类的转义字符时，退回按字段名提取
function parseDataDirRecord(text) {
  const matched = text.match(/"dataDir"\s*:\s*"([^"]*)"/);
  try {
    const parsed = JSON.parse(text);
    const dir = normalizeRecordedDir(parsed && parsed.dataDir);
    if (dir && !/[\u0000-\u001f]/.test(dir)) return dir;
  } catch (error) {
    // 继续走下面的宽松解析
  }
  return matched ? normalizeRecordedDir(matched[1]) : null;
}

// 读取记录的数据位置；未设置、损坏或无法可靠解码时返回 null
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
    // 解码失败时会出现替换字符（例如路径被以 ANSI 写入），此时宁可回退到默认位置
    if (dir.includes('\uFFFD')) {
      console.warn('[Esprin Nemo] 数据位置记录无法解码，已回退到默认位置:', file);
      return null;
    }
    // 记录里是正斜杠形式，这里换算成当前平台的写法
    return path.resolve(dir);
  } catch (error) {
    console.warn('[Esprin Nemo] 读取数据位置记录失败:', error);
    return null;
  }
}

// 原子写入：先写同目录下的临时文件，再改名覆盖目标文件。
// 直接覆盖写时若进程被强杀或断电，原文件会被截断成半截内容；
// 同一分区内的 rename 是原子操作，目标文件因此要么是旧内容、要么是新内容。
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
      // 清理失败不影响错误上报
    }
    throw error;
  }
}

// 写入数据位置记录；dir 为空表示删除记录（回到默认位置）
function writeStoredDataDir(dir, appLike = null) {
  // 开发运行不维护位置记录（清空记录会误删安装版的选择）
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

// 是否开发运行：bun start / npm start 走的是 `electron .`，此时应用未打包。
// 开发运行固定使用项目内 data/，不读取也不写入 data_path.json，
// 避免被安装版（或向导）记录的位置带到用户目录，令开发数据来源难以预期。
function isDevRun(appLike = null) {
  const app = getApp(appLike);
  return !(app && app.isPackaged);
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

// 兼容安装器可能写出的 UTF-16LE（带/不带 BOM）与 UTF-8 文本
function decodeTextFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le', 2);
  }
  if (buffer.includes(0)) return buffer.toString('utf16le');
  return buffer.toString('utf8');
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

  // 2. 开发运行（bun start）：固定使用项目内 data/，不读位置记录也不接受自定义位置
  if (isDevRun(appLike)) return getDefaultDataDir(baseDir, appLike);

  // 3. 记录文件中的位置（安装时选择或应用内更改）优先；不可用时回退，避免应用无法启动
  const stored = readStoredDataDir(appLike);
  if (stored) {
    if (ensureDirUsable(stored)) return stored;
    console.warn('[Esprin Nemo] 记录的数据位置不可用，已回退到默认位置:', stored);
  }

  // 4. 默认位置
  return getDefaultDataDir(baseDir, appLike);
}

// 安装版首次运行时，把随应用分发的项目内 data/ 迁移到用户数据目录
function migrateLegacyData(dir, baseDir = __dirname, appLike = null) {
  const app = getApp(appLike);
  if (isDevRun(appLike) || typeof app.getPath !== 'function') return;

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
  isDevRun,
  getConfigDir,
  getDefaultDataDir,
  writeFileAtomic,
  writeStoredDataDir,
  ensureDataDir
};
