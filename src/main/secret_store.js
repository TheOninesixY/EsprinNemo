// 通用密钥存储（仅主进程可读）：把一段秘密交给系统级加密能力保管，目前有两位使用者——
// AI 助手的 API Key（见 ai_secret.js）与自建同步的访问令牌（见 sync_server.js）。
//
// 秘密不写进数据目录的 config.json：那是一份「可备份、可迁移、可分享」的普通数据，
// 明文口令放在里面会随复制 / 同步 / 截图外泄。这里统一按用户而非数据目录存放
//（安装版为 %APPDATA%/esprin_nemo/<文件名>，便携版为便携版目录下的同名文件），
// 因此切换数据位置后密钥依然可用：
//   - Windows：DPAPI（凭当前用户账户派生密钥）
//   - macOS：钥匙串（Keychain）
//   - Linux：libsecret（gnome-keyring / kwallet）
// 系统不支持安全存储时退化为「仅本机可读的文件权限」（0600），并如实上报状态由界面提示。
//
// 文件格式：第一行是 `${header} ${mode}`，第二行起为负载（加密时为 base64）。
// 每种秘密各用一份文件、一个 header，彼此互不干扰；开发运行（bun start）另用一份文件名，
// 避免与安装版互相覆盖。
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { getConfigDir, isDevRun } = require('./data_path.js');

const MODE_ENCRYPTED = 'encrypted';
const MODE_PLAIN = 'plain';
// 明文退化的权限：仅当前用户可读写（Windows 上由用户配置目录的 ACL 保证）
const PLAIN_FILE_MODE = 0o600;

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

// 原子写入：先写同目录下的临时文件再改名，避免进程被中断时留下半截文件。
// mode 用于密钥文件这类需要限制权限的场合（仅当前用户可读写）。
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

/* 建一份密钥存储：fileName 是安装版（与便携版）用的文件名，devFileName 是开发运行用的，
   header 写进文件第一行用于识别格式，label 出现在给用户看的提示里（如「API Key」「同步令牌」）。 */
function createSecretStore({ header, fileName, devFileName = '', label = '密钥' }) {
  // 密钥文件位置：应用配置目录（与数据位置记录 data_path.json 同级），不在数据目录内。
  // 便携版的配置目录就是便携版所在目录，因此密钥文件也随程序目录走
  function filePath(appLike = null) {
    const target = appLike || app;
    const dir = getConfigDir(target);
    if (!dir) return null;
    return path.join(dir, devFileName && isDevRun(target) ? devFileName : fileName);
  }

  // 读原始文件：返回 { mode, payload }，不存在或格式不认识时 mode 为空
  function readRaw() {
    const file = filePath();
    if (!file || !fs.existsSync(file)) return { mode: '', payload: '' };
    try {
      const text = fs.readFileSync(file, 'utf8');
      const separator = text.indexOf('\n');
      if (separator < 0) return { mode: '', payload: '' };
      const head = text.slice(0, separator).trim();
      if (!head.startsWith(header)) return { mode: '', payload: '' };
      return { mode: head.slice(header.length).trim(), payload: text.slice(separator + 1).replace(/\r?\n+$/, '') };
    } catch (error) {
      console.error('[Esprin Nemo] 读取密钥文件失败:', error);
      return { mode: '', payload: '' };
    }
  }

  // 解出秘密明文；解密失败（换了系统账户、密钥环被重置等）时按「没有」处理
  function decode(stored) {
    if (!stored.payload) return '';
    if (stored.mode === MODE_PLAIN) return stored.payload.trim();
    if (stored.mode !== MODE_ENCRYPTED) return '';
    if (!encryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(stored.payload, 'base64')).trim();
    } catch (error) {
      console.error('[Esprin Nemo] 解密密钥失败（可能更换了系统账户或密钥环）:', error);
      return '';
    }
  }

  // 读取秘密明文（没有时为空字符串）
  function read() {
    return decode(readRaw());
  }

  // 保管状态：hasKey 是否有秘密，encrypted 磁盘上是否加密存放，strong 是否为系统密钥链级加密
  function status() {
    const stored = readRaw();
    const hasKey = !!decode(stored);
    return {
      hasKey,
      encrypted: hasKey && stored.mode === MODE_ENCRYPTED,
      strong: hasKey && stored.mode === MODE_ENCRYPTED && isStronglyProtected(),
      path: filePath() || ''
    };
  }

  // 清除：删除密钥文件（没有则视为已清除）
  function clear() {
    const file = filePath();
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
      console.error('[Esprin Nemo] 删除密钥文件失败:', error);
      return { ok: false, error: `清除 ${label} 失败：${error.message}` };
    }
    return { ok: true, ...status() };
  }

  // 保存（空字符串等于清除）：能加密就加密，否则退化为仅本机可读的明文文件
  function write(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return clear();

    const file = filePath();
    if (!file) return { ok: false, error: `无法定位密钥存储位置，${label} 未保存` };

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let mode = MODE_PLAIN;
      let payload = text;
      if (encryptionAvailable()) {
        try {
          payload = safeStorage.encryptString(text).toString('base64');
          mode = MODE_ENCRYPTED;
        } catch (error) {
          console.warn(`[Esprin Nemo] 加密 ${label} 失败，改用仅本机可读的明文文件保存:`, error);
        }
      }
      writeFileAtomic(file, `${header} ${mode}\n${payload}\n`, PLAIN_FILE_MODE);
      return { ok: true, ...status() };
    } catch (error) {
      console.error('[Esprin Nemo] 保存密钥失败:', error);
      return { ok: false, error: `保存 ${label} 失败：${error.message}` };
    }
  }

  return { filePath, read, write, clear, status };
}

module.exports = {
  MODE_ENCRYPTED,
  MODE_PLAIN,
  createSecretStore,
  encryptionAvailable,
  isStronglyProtected,
  writeFileAtomic
};
