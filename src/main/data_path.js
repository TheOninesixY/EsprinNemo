const fs = require('node:fs');
const path = require('node:path');

// 主进程通过 webPreferences.additionalArguments 把解析好的数据目录传给渲染进程
const DATA_DIR_ARG = '--esprin-nemo-data-dir=';

// 数据位置记录：安装版是 %APPDATA%/esprin_nemo/data_path.json，便携版是便携版所在目录下的
// 同名文件（便携版不读取也不写入 %APPDATA% 里的那份）。记录必须放在数据目录之外
// （否则切换后就找不到记录了）；安装版的这个文件同时也是安装向导
// （见 src/win_installer/installer.nsh）读写的同一个文件。
const DEFAULT_APP_DIR_NAME = 'esprin_nemo';
const DATA_PATH_FILE_NAME = 'data_path.json';
// 需要独立 Chromium profile 的两种运行方式各自的目录名
// （profile：缓存 / Cookie / GPU 缓存 / 崩溃转储等）
const USER_DATA_DIR_NAME = 'user_data';
const DEV_USER_DATA_DIR_NAME = 'dev_user_data';

function getApp(appLike = null) {
  if (appLike) return appLike;
  try {
    // 渲染进程中 require('electron').app 不存在，会走下面的 null 分支
    return require('electron').app || null;
  } catch (error) {
    return null;
  }
}

// 便携版运行目录：electron-builder 的 portable 目标启动时会写入这两个环境变量
// （PORTABLE_EXECUTABLE_FILE 是便携版 exe 的完整路径，PORTABLE_EXECUTABLE_DIR 是它所在的目录）。
// 与 src/main/updater.js 的 isPortableRun 同源，这里自带一份，避免配置目录解析反过来依赖更新模块。
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

// 便携版运行目录的解析结果（整个进程只解析一次）：
// portableDir 非空即表示本次是便携版运行，portableDirWritable 表示该目录能否写入。
// 便携版目录写不进去时不退回安装版那套 %APPDATA% 位置：数据与位置记录都随程序目录走
// 才是「便携」的全部意义，静默改用系统盘会让用户在自己的程序目录里找不到笔记，
// 还会与安装版（或另一份便携版）的记录与数据互相覆盖；这种情况改为启动失败并弹窗告知用户
// （见本文件末尾的 getStartupBlocker 与 main.js 里的启动检查）。
// 便携版可能被放在只读位置（光盘、只读共享盘、受策略限制的程序目录）。
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

// 是否便携版运行：只看启动环境变量，与目录能否解析、能否写入完全无关。
// 便携版的位置解析一律以它为准——只要是便携版运行，就绝不使用 %APPDATA% 下的任何位置
// （目录不可写时由启动检查弹窗说明，见 getStartupBlocker），
// 目录本身能否写入另由 portableDirWritable 单独记录。
function isPortableRun() {
  return !!getPortableDir();
}

// 读取命令行传入的数据目录（仅渲染进程会带上该参数）
function getDataDirFromArgv(argv = process.argv) {
  if (!Array.isArray(argv)) return null;
  const matched = argv.find((item) => typeof item === 'string' && item.startsWith(DATA_DIR_ARG));
  if (!matched) return null;
  const dir = matched.slice(DATA_DIR_ARG.length).trim();
  return dir || null;
}

// 用户目录下的配置目录：固定为 %APPDATA%/esprin_nemo，与安装向导写记录文件的位置保持一致。
// 便携版不使用它，但它是「配置目录搬家」后迁移 AI 密钥文件时的旧位置（见 ai_secret.js）。
function getAppDataConfigDir(appLike = null) {
  const app = getApp(appLike);
  if (!app || typeof app.getPath !== 'function') return null;
  try {
    return path.join(app.getPath('appData'), DEFAULT_APP_DIR_NAME);
  } catch (error) {
    return null;
  }
}

// 实际生效的配置目录（data_path.json 与 AI 密钥文件都放在这里）：
// 便携版是便携版所在目录——配置随程序目录走、整体可搬移，也不在系统盘留痕；
// 其余运行方式是 %APPDATA%/esprin_nemo。
// 便携版目录不可写时同样返回便携版目录（配置仍是读得出来的）：宁可写入失败并在启动时弹窗说明，
// 也不改指 %APPDATA% —— 不碰系统盘上的那份配置是便携版的硬约束。
// 注意：%APPDATA% 这个分支只可能属于安装版与开发运行，便携版永远走不到这里。
function getConfigDir(appLike = null) {
  if (isPortableRun()) return resolvePortableDir();
  return getAppDataConfigDir(appLike);
}

function getLocationFile(appLike = null) {
  const configDir = getConfigDir(appLike);
  return configDir ? path.join(configDir, DATA_PATH_FILE_NAME) : null;
}

/* 需要自己一份 Chromium profile 的运行方式（便携版、开发运行）对应的 userData 目录；
   其余运行方式返回 null，调用方保持 Electron 的默认位置。

   便携版：默认的 %APPDATA%\<产品名> 里的缓存、Cookie、GPU 缓存、崩溃转储都是实打实的写入，
   「便携版不写 %APPDATA%」若只覆盖应用自己的数据文件，系统盘上照样会留下这一大堆，
   还会与安装版共用同一个 profile。

   开发运行：默认的 userData 与安装版完全相同，连带共用同一把单实例锁——
   安装版还开着（缩在托盘里）时，`bun start` 会老老实实把「再次启动」交给安装版，
   于是开发窗口一个都开不出来，现象就是「bun start 没有窗口，只有去点托盘才出来」。
   与数据目录、API Key 一样，开发运行这部分也单独一份，两者互不干扰。 */
function getIsolatedUserDataDir(appLike = null) {
  const portable = resolvePortableDir();
  if (portable) return path.join(portable, USER_DATA_DIR_NAME);
  if (!isDevRun(appLike)) return null;
  /* 开发运行的隔离目录不是硬要求（便携版才是）：建不出来 / 写不进去时老老实实退回默认 profile。
     默认 profile 大不了与安装版共用，而指一个写不进去的目录会让 Chromium 直接起不来 */
  const configDir = getAppDataConfigDir(appLike);
  if (!configDir) return null;
  const dir = path.join(configDir, DEV_USER_DATA_DIR_NAME);
  if (!ensureDirUsable(dir)) {
    console.warn('[Esprin Nemo] 开发运行的独立运行时目录不可用，沿用默认 profile:', dir);
    return null;
  }
  return dir;
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

// 读取记录的数据位置；未设置、损坏或无法可靠解码时返回 null。
// 便携版读的是便携版目录下的同名文件，因此既不会读到 %APPDATA% 里的那份记录，
// 也不会把安装版（或上次在其他目录运行）的选择带过来。
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

// 目录必须可创建且可写，否则视为不可用。
// 只做 mkdir + access 并不足以判定可写：目录的只读属性、ACL、只读盘 / 只读共享盘
// 都可能被放过，而「目录不可写」在便携版下直接决定应用能否启动，
// 因此这里实际落一个空文件探一探，探完立刻删掉。
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
      // 探测文件删不掉不影响判定结果
    }
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

// 默认数据目录：便携版是便携版所在目录下的 data/，安装版 %APPDATA%/esprin_nemo/data，
// 开发版项目内 data/
function getDefaultDataDir(baseDir = __dirname, appLike = null) {
  // 便携版与安装版的分岔同样以「是否便携版运行」为准，不依赖目录能否写入：
  // 便携版目录写不进去时可能连 data/ 都建不出来，但那也不该把数据引到 %APPDATA% 去
  if (isPortableRun()) return path.join(resolvePortableDir(), 'data');
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

  // 3. 记录文件中的位置（安装时选择或应用内更改）优先；不可用时回退到默认位置，
  //    免得记着一个连不上的位置就完全无法启动。
  //    便携版读的是便携版目录下的记录（见 readStoredDataDir），默认位置也已经是运行目录下的 data/；
  //    若记录与默认位置都写不进去，不在这里改用别的位置，而是由启动检查拦下并弹窗说明（见 getStartupBlocker）
  const stored = readStoredDataDir(appLike);
  if (stored) {
    if (ensureDirUsable(stored)) return stored;
    console.warn('[Esprin Nemo] 记录的数据位置不可用，已回退到默认位置:', stored);
  }

  // 4. 默认位置
  return getDefaultDataDir(baseDir, appLike);
}

// 安装版首次运行时，把随应用分发的项目内 data/ 迁移到用户数据目录。
// 便携版的目标目录就是便携版所在目录下的 data/，而这里的 baseDir 是解压出来的临时目录，
// 打包时并不包含 data/（见 package.json 的 build.files），因此不会发生搬迁。
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

/* 启动前置检查：返回 null 表示可以正常启动；否则返回描述阻塞原因的对象，
   由 main.js 用与界面同一套的窗口式弹窗说明原因，并给出「重新选择路径」的出路
   （用户坚持不改就退出，见 main.js 的 resolveStartupBlock / abortStartup）。

   只有便携版会命中：安装版与开发运行的数据位置本就不随程序目录走，
   目录不可写时按原有顺序回退即可（安装版有 %APPDATA% 兜底，开发运行固定项目内 data/）。
   便携版则相反——数据与位置记录都随程序目录走才是「便携」的全部意义，
   目录写不进去时改投 %APPDATA%（或悄悄改用别的数据目录）会让用户在便携版目录里
   找不到自己的笔记，还会与安装版（或另一份便携版）的记录、数据互相覆盖，
   因此宁可启动失败也要把真实原因说清楚。

   返回对象的 kind 取值为：
   portable-dir  便携版所在目录不可写（位置记录与 AI 密钥也在这里）
   recorded-dir  位置记录指向的目录不可用
   data-dir      便携版目录下的默认数据目录建不出来 / 写不进去 */
function getStartupBlocker(baseDir = __dirname, appLike = null) {
  // 开发运行固定使用项目内 data/，与便携版标记无关
  if (isDevRun(appLike)) return null;

  const portable = resolvePortableDir();
  if (!portable) return null;

  const recordFile = getLocationFile(appLike) || '';

  // 便携版目录本身写不进去：位置记录 data_path.json 与 AI 密钥文件都无处可写
  if (!portableDirWritable) {
    return {
      kind: 'portable-dir',
      reason: '便携版所在目录无法写入',
      dir: portable,
      // 数据本身可能已被指到别处（记录仍在便携版目录里，读得出来），弹窗里如实显示
      dataDir: readStoredDataDir(appLike) || path.join(portable, 'data'),
      recordFile
    };
  }

  // 位置记录里的自定义位置不可用：不改用默认位置，否则用户看到的是「笔记全没了」
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

  // 便携版目录可写，但它下面的数据目录建不出来 / 写不进去
  // （例如同名的 data 是个文件、或该子目录被单独设成只读）
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
  isPortableRun,
  getConfigDir,
  getAppDataConfigDir,
  getLocationFile,
  getIsolatedUserDataDir,
  getDefaultDataDir,
  writeFileAtomic,
  writeStoredDataDir,
  getStartupBlocker,
  ensureDataDir
};
