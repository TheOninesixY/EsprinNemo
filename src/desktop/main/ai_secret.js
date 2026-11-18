const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { getAppDataConfigDir, isDevRun } = require('./data_path.js');
const { createSecretStore, writeFileAtomic } = require('./secret_store.js');

const KEY_FILE_NAME = 'ai_key.bin';

const DEV_KEY_FILE_NAME = 'ai_key.dev.bin';

const store = createSecretStore({
  header: 'esprin-nemo-ai-key/1',
  fileName: KEY_FILE_NAME,
  devFileName: DEV_KEY_FILE_NAME,
  label: 'API Key'
});

function keyFilePath(appLike = null) {
  return store.filePath(appLike);
}

function readApiKey() {
  return store.read();
}

let pendingMigrationNotice = false;

function keyStatus() {
  const migrated = pendingMigrationNotice;
  pendingMigrationNotice = false;
  return { ...store.status(), migrated };
}

function clearApiKey() {
  const result = store.clear();
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, ...keyStatus() };
}

function writeApiKey(apiKey) {
  const saved = store.write(apiKey);
  if (!saved.ok) return { ok: false, error: saved.error };
  return { ok: true, ...keyStatus() };
}

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
