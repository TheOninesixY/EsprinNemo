// AI 助手 API Key 的独立存储（仅主进程可读）：密钥文件本身由通用密钥存储读写
//（见 secret_store.js，自建同步的访问令牌用的是同一套实现、另一份文件），本文件只保留 AI 这一侧的
// 业务：旧版明文密钥的收编，以及配置目录搬家时的密钥文件迁移。
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
const { app } = require('electron');
const { getAppDataConfigDir, isDevRun } = require('./data_path.js');
const { createSecretStore, writeFileAtomic } = require('./secret_store.js');

const KEY_FILE_NAME = 'ai_key.bin';
// 开发运行（bun start）单独一份：避免与安装版互相覆盖同一个密钥文件
const DEV_KEY_FILE_NAME = 'ai_key.dev.bin';

/* 密钥的加密、落盘与保管状态都交给通用密钥存储：文件第一行标记格式版本与存储方式
   （esprin-nemo-ai-key/1），第二行起为负载（加密时为 base64），格式与旧版完全一致 */
const store = createSecretStore({
  header: 'esprin-nemo-ai-key/1',
  fileName: KEY_FILE_NAME,
  devFileName: DEV_KEY_FILE_NAME,
  label: 'API Key'
});

// 密钥文件位置：应用配置目录（与数据位置记录 data_path.json 同级），不在数据目录内。
// 便携版的配置目录就是便携版所在目录，密钥文件因此也随程序目录走
function keyFilePath(appLike = null) {
  return store.filePath(appLike);
}

// 读取密钥明文（没有时为空字符串）
function readApiKey() {
  return store.read();
}

// 刚完成过一次明文迁移时置位：界面据此提示一次「密钥已改存到安全存储」
let pendingMigrationNotice = false;

// 密钥保管状态：hasKey 是否有密钥，encrypted 磁盘上是否加密存放，strong 是否为系统密钥链级加密；
// migrated 只在刚完成过一次明文迁移时为 true，供界面提示一次
function keyStatus() {
  const migrated = pendingMigrationNotice;
  pendingMigrationNotice = false;
  return { ...store.status(), migrated };
}

// 清除密钥：删除密钥文件（没有则视为已清除）
function clearApiKey() {
  const result = store.clear();
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, ...keyStatus() };
}

// 保存密钥（空字符串等于清除）
function writeApiKey(apiKey) {
  const saved = store.write(apiKey);
  if (!saved.ok) return { ok: false, error: saved.error };
  return { ok: true, ...keyStatus() };
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
