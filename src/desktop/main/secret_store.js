const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { getConfigDir, isDevRun } = require('./data_path.js');

const MODE_ENCRYPTED = 'encrypted';
const MODE_PLAIN = 'plain';

const PLAIN_FILE_MODE = 0o600;

function encryptionAvailable() {
  try {
    return typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable();
  } catch (error) {
    return false;
  }
}

function storageBackend() {
  try {
    return typeof safeStorage.getSelectedStorageBackend === 'function'
      ? String(safeStorage.getSelectedStorageBackend() || '')
      : '';
  } catch (error) {
    return '';
  }
}

function isStronglyProtected() {
  return encryptionAvailable() && storageBackend() !== 'basic_text';
}

function writeFileAtomic(file, text, mode) {
  const tempPath = `${file}.tmp`;
  try {
    fs.writeFileSync(tempPath, text, mode ? { encoding: 'utf8', mode } : 'utf8');
    fs.renameSync(tempPath, file);
    if (mode) {

      try {
        fs.chmodSync(file, mode);
      } catch (error) {

      }
    }
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (cleanupError) {

    }
    throw error;
  }
}

function createSecretStore({ header, fileName, devFileName = '', label = '密钥' }) {

function filePath(appLike = null) {
    const target = appLike || app;
    const dir = getConfigDir(target);
    if (!dir) return null;
    return path.join(dir, devFileName && isDevRun(target) ? devFileName : fileName);
  }

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

function read() {
    return decode(readRaw());
  }

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
