// AI 助手 API Key 的独立存储（仅主进程可读）。
//
// 密钥不写进数据目录的 config.json：数据目录是「可备份、可迁移、可分享」的一份普通数据，
// 明文密钥放在里面会随复制/同步/截图外泄。这里改为交给系统级加密能力保管，并按用户而非
// 数据目录存放（安装版为 %APPDATA%/esprin_nemo/ai_key.bin，便携版为便携版目录下的同名文件），
// 因此切换数据位置后密钥依然可用：
//   - Windows：DPAPI（凭当前用户账户派生密钥）
//   - macOS：钥匙串（Keychain）
//   - Linux：libsecret（gnome-keyring / kwallet）
// 系统不支持安全存储时退化为「仅本机可读的文件权限」（0600），并如实上报状态由界面提示。
//
// 渲染进程既不写也不读明文：它只能查询「有没有保存」「怎么保管的」，以及提交一个新的密钥。

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { getAppDataConfigDir, getConfigDir, isDevRun } = require('./data_path.js');

const KEY_FILE_NAME = 'ai_key.bin';
// 开发运行（bun start）单独一份：避免与安装版互相覆盖同一个密钥文件
const DEV_KEY_FILE_NAME = 'ai_key.dev.bin';
// 文件头：第一行标记格式版本与存储方式，第二行起为负载（加密时为 base64）
const FILE_HEADER = 'esprin-nemo-ai-key/1';
const MODE_ENCRYPTED = 'encrypted';
const MODE_PLAIN = 'plain';
// 明文退化的权限：仅当前用户可读写（Windows 上由用户配置目录的 ACL 保证）
const PLAIN_FILE_MODE = 0o600;

// 密钥文件位置：应用配置目录（与数据位置记录 data_path.json 同级），不在数据目录内。
// 便携版的配置目录就是便携版所在目录，密钥文件因此也随程序目录走
function keyFilePath(appLike = null) {
  const target = appLike || app;
  const dir = getConfigDir(target);
  if (!dir) return null;
  return path.join(dir, isDevRun(target) ? DEV_KEY_FILE_NAME : KEY_FILE_NAME);
}

function encryptionAvailable() {
  try {
    return typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable();
  } catch (error) {
    return false;
  }
}

// 具体后端：dpapi / keychain / gnome_libsecret / kwallet / basic_text …
function storageBackend() {
  try {
    return typeof safeStorage.getSelectedStorageBackend === 'function'
      ? String(safeStorage.getSelectedStorageBackend() || '')
      : '';
  } catch (error) {
    return '';
  }
}

// basic_text 表示系统没提供密钥环（Electron 用固定密钥加密，等同于没有保护），不算安全存储
function isStronglyProtected() {
  return encryptionAvailable() && storageBackend() !== 'basic_text';
}

// 读原始文件：返回 { mode, payload }，不存在或格式不认识时 mode 为空
function readStored() {
  const file = keyFilePath();
  if (!file || !fs.existsSync(file)) return { mode: '', payload: '' };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const separator = text.indexOf('\n');
    if (separator < 0) return { mode: '', payload: '' };
    const header = text.slice(0, separator).trim();
    if (!header.startsWith(FILE_HEADER)) return { mode: '', payload: '' };
    const mode = header.slice(FILE_HEADER.length).trim();
    return { mode, payload: text.slice(separator + 1).replace(/\r?\n+$/, '') };
  } catch (error) {
    console.error('[Esprin Nemo] 读取 AI 密钥文件失败:', error);
    return { mode: '', payload: '' };
  }
}

// 解出密钥明文；解密失败（换了系统账户、密钥环被重置等）时按「没有密钥」处理
function decodeStored(stored) {
  if (!stored.payload) return '';
  if (stored.mode === MODE_PLAIN) return stored.payload.trim();
  if (stored.mode !== MODE_ENCRYPTED) return '';
  if (!encryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(stored.payload, 'base64')).trim();
  } catch (error) {
    console.error('[Esprin Nemo] 解密 AI 密钥失败（可能更换了系统账户或密钥环）:', error);
    return '';
  }
}

// 读取密钥明文
function readApiKey() {
  return decodeStored(readStored());
}

// 原子写入：先写同目录下的临时文件再改名，避免进程被中断时留下半截文件。
// 传入 mode 时用于密钥文件这类需要限制权限的场合（仅当前用户可读写）。
function writeFileAtomic(file, text, mode) {
  const tempPath = `${file}.tmp`;
  try {
    fs.writeFileSync(tempPath, text, mode ? { encoding: 'utf8', mode } : 'utf8');
    fs.renameSync(tempPath, file);
    if (mode) {
      // 已存在的文件不受 mode 选项影响，补一次 chmod（Windows 上无效，忽略即可）
      try {
        fs.chmodSync(file, mode);
      } catch (error) {
        // 忽略
      }
    }
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      // 清理失败不影响错误上报
    }
    throw error;
  }
}

// 刚完成过一次明文迁移时置位：界面据此提示一次「密钥已改存到安全存储」
let pendingMigrationNotice = false;

// 密钥保管状态：hasKey 是否有密钥，encrypted 磁盘上是否加密存放，strong 是否为系统密钥链级加密
function keyStatus() {
  const stored = readStored();
  const hasKey = !!decodeStored(stored);
  const migrated = pendingMigrationNotice;
  pendingMigrationNotice = false;
  return {
    hasKey,
    encrypted: hasKey && stored.mode === MODE_ENCRYPTED,
    strong: hasKey && stored.mode === MODE_ENCRYPTED && isStronglyProtected(),
    migrated,
    path: keyFilePath() || ''
  };
}

// 清除密钥：删除密钥文件（没有则视为已清除）
function clearApiKey() {
  const file = keyFilePath();
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (error) {
    console.error('[Esprin Nemo] 删除 AI 密钥文件失败:', error);
    return { ok: false, error: `清除 API Key 失败：${error.message}` };
  }
  return { ok: true, ...keyStatus() };
}

// 保存密钥（空字符串等于清除）
function writeApiKey(apiKey) {
  const value = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!value) return clearApiKey();

  const file = keyFilePath();
  if (!file) return { ok: false, error: '无法定位密钥存储位置，API Key 未保存' };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let mode = MODE_PLAIN;
    let payload = value;
    if (encryptionAvailable()) {
      try {
        payload = safeStorage.encryptString(value).toString('base64');
        mode = MODE_ENCRYPTED;
      } catch (error) {
        console.warn('[Esprin Nemo] 加密 API Key 失败，改用仅本机可读的明文文件保存:', error);
      }
    }
    writeFileAtomic(file, `${FILE_HEADER} ${mode}\n${payload}\n`, PLAIN_FILE_MODE);
    return { ok: true, ...keyStatus() };
  } catch (error) {
    console.error('[Esprin Nemo] 保存 AI 密钥失败:', error);
    return { ok: false, error: `保存 API Key 失败：${error.message}` };
  }
}

// 配置目录搬家时（便携版把配置目录从 %APPDATA%/esprin_nemo 换到便携版所在目录），
// 把旧位置的那份密钥文件搬到新位置：加密密钥由系统凭当前账户派生（DPAPI / 钥匙串），
// 同一台机器上换个路径不影响解密，因此直接复制即可，用户不必重新填一遍 Key。
// 新位置已有密钥、或旧位置没有密钥时什么都不做（旧文件原样保留，不删不覆盖）。
function adoptLegacyKeyFile() {
  const target = keyFilePath();
  const legacyDir = getAppDataConfigDir(app);
  if (!target || !legacyDir) return false;

  const legacyFile = path.join(legacyDir, isDevRun(app) ? DEV_KEY_FILE_NAME : KEY_FILE_NAME);
  if (path.resolve(legacyFile) === path.resolve(target)) return false;
  if (fs.existsSync(target) || !fs.existsSync(legacyFile)) return false;

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(legacyFile, target);
    return true;
  } catch (error) {
    console.warn('[Esprin Nemo] 迁移旧位置的 AI 密钥文件失败:', error);
    return false;
  }
}

// 从已解析的 config.json 中收编旧版明文密钥：写进密钥链，再把明文从配置里抹掉。
// 密钥链里已有密钥时以密钥链为准，只清理配置文件。返回当前生效的密钥（没有则空字符串）。
function adoptLegacyApiKey(config, configFile) {
  const ai = config && typeof config === 'object' && config.ai && typeof config.ai === 'object' ? config.ai : null;
  const legacyKey = ai && typeof ai.apiKey === 'string' ? ai.apiKey.trim() : '';
  if (!legacyKey) return '';

  let stored = readApiKey();
  if (!stored) {
    const saved = writeApiKey(legacyKey);
    if (!saved.ok) {
      console.error('[Esprin Nemo] 迁移 API Key 失败，config.json 中的明文暂未清理:', saved.error);
      return '';
    }
    stored = readApiKey();
    pendingMigrationNotice = true;
    console.warn('[Esprin Nemo] API Key 迁移：config.json 中的明文密钥已收进本机安全存储');
  }

  stripApiKeyFromConfig(config, configFile);
  return stored;
}

// 把一个 API Key 从配置对象里去掉并原子写回：保持与渲染进程一致的 2 空格缩进，不追加结尾换行
function stripApiKeyFromConfig(config, configFile) {
  if (!configFile || !config || typeof config !== 'object') return false;
  if (!config.ai || typeof config.ai !== 'object' || !('apiKey' in config.ai)) return false;
  delete config.ai.apiKey;
  try {
    writeFileAtomic(configFile, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('[Esprin Nemo] 清理 config.json 中的明文 API Key 失败:', error);
    return false;
  }
}

// 自行读取并迁移配置文件里的明文密钥（应用启动、切换数据目录时调用）
function migrateApiKeyFromConfig(configFile) {
  if (!configFile || !fs.existsSync(configFile)) return '';
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    console.error('[Esprin Nemo] 解析 config.json 失败，跳过 API Key 迁移:', error);
    return '';
  }
  return adoptLegacyApiKey(config, configFile);
}

module.exports = {
  keyFilePath,
  keyStatus,
  readApiKey,
  writeApiKey,
  clearApiKey,
  adoptLegacyKeyFile,
  adoptLegacyApiKey,
  migrateApiKeyFromConfig
};
