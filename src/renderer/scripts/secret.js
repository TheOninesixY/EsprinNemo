/* 秘密本：单篇文档的「隐藏」与「密码」。

   隐藏（isHidden）：条目仍是一份普通笔记文件，只是不再进入任何列表、搜索、统计、
   AI 提问范围与小本本，只能在「设置 → 秘密本」里找到并打开。

   密码（locked）：正文以 AES-256-GCM 加密后落盘。落盘那一步由 storage.js 的
   serializeItemFile 调 serializeSecretBody 现做密文，因此任何保存路径都写不出明文；
   标题、文件夹、标签与时间等元数据保持明文，用于在列表与秘密本里定位条目。
   口令既不落盘也不留在内存：只保留会话内的派生密钥（见 secretUnlocked），
   应用退出即全部失效，忘记口令的文档无法恢复。

   密钥派生用 PBKDF2-SHA256（轮数与盐都记在信封里），密文尾部接 GCM 认证标签：
   口令错误与文件被改动都会在解密时失败，不需要另存一份校验值。
   信封是纯文本 JSON，与网页版保持一致，同一份文档在两端都能解开。 */

const nodeCrypto = require('node:crypto');

// 密文信封：首尾各一行标记，中间一行 JSON（便于人工辨认，也便于整体替换）
const SECRET_ENVELOPE_HEAD = '-----ESPRIN SECRET-----';
const SECRET_ENVELOPE_TAIL = '-----END ESPRIN SECRET-----';
const SECRET_KDF = 'PBKDF2-SHA256';
const SECRET_CIPHER = 'AES-256-GCM';
// 口令派生轮数：解密时以信封里记录的值为准，日后调高不影响旧文档
const SECRET_ITERATIONS = 250000;
const SECRET_KEY_BYTES = 32;
const SECRET_SALT_BYTES = 16;
const SECRET_IV_BYTES = 12;
const SECRET_TAG_BYTES = 16;
const SECRET_PASSWORD_MIN = 4;

// 已解开的条目：itemId -> { key, iterations }。密钥只活在这一轮会话里，
// 条目被删除、数据目录被切换或应用退出时一并清掉
const secretUnlocked = new Map();

/* ---------------- 信封与加解密 ---------------- */

function isSecretEnvelope(text) {
    return typeof text === 'string' && text.startsWith(SECRET_ENVELOPE_HEAD);
}

// 解析信封：返回 { iterations, salt, iv, ct }（salt / iv / ct 为 Buffer），
// 格式不认识时返回 null。字段缺失或非法一律按无法识别处理，避免拿脏数据去解密
function parseSecretEnvelope(text) {
    if (!isSecretEnvelope(text)) return null;
    const body = text.slice(SECRET_ENVELOPE_HEAD.length, text.lastIndexOf(SECRET_ENVELOPE_TAIL)).trim();
    if (!body) return null;
    try {
        const payload = JSON.parse(body);
        const iterations = Number(payload && payload.iter);
        if (!Number.isFinite(iterations) || iterations < 1000) return null;
        if (payload.cipher && payload.cipher !== SECRET_CIPHER) return null;
        if (payload.kdf && payload.kdf !== SECRET_KDF) return null;
        const salt = Buffer.from(String(payload.salt || ''), 'base64');
        const iv = Buffer.from(String(payload.iv || ''), 'base64');
        const ct = Buffer.from(String(payload.ct || ''), 'base64');
        // 空正文的密文也正好是一个认证标签的长度，因此这里只要求不小于标签长度
        if (salt.length < 8 || iv.length !== SECRET_IV_BYTES || ct.length < SECRET_TAG_BYTES) return null;
        return { iterations: Math.round(iterations), salt, iv, ct };
    } catch (err) {
        return null;
    }
}

function deriveSecretKey(password, salt, iterations) {
    return nodeCrypto.pbkdf2Sync(String(password), salt, iterations, SECRET_KEY_BYTES, 'sha256');
}

// 加密：认证标签接在密文尾部后整体 base64，与网页版 WebCrypto 的 AES-GCM 输出同构。
// iterations 记的是派生这把密钥时实际用的轮数（会话重加密时沿用信封里的值）
function sealSecretContent(key, iv, plaintext, salt, iterations = SECRET_ITERATIONS) {
    const cipher = nodeCrypto.createCipheriv(SECRET_CIPHER, key, iv);
    const data = Buffer.concat([cipher.update(String(plaintext == null ? '' : plaintext), 'utf8'), cipher.final()]);
    const payload = {
        v: 1,
        kdf: SECRET_KDF,
        iter: iterations,
        salt: salt ? salt.toString('base64') : '',
        cipher: SECRET_CIPHER,
        iv: iv.toString('base64'),
        ct: Buffer.concat([data, cipher.getAuthTag()]).toString('base64')
    };
    return `${SECRET_ENVELOPE_HEAD}\n${JSON.stringify(payload)}\n${SECRET_ENVELOPE_TAIL}`;
}

// 用口令加密一段正文：返回信封文本与派生出的密钥、盐（盐随信封一起保存）
function encryptSecretContent(password, plaintext) {
    const salt = nodeCrypto.randomBytes(SECRET_SALT_BYTES);
    const iv = nodeCrypto.randomBytes(SECRET_IV_BYTES);
    const key = deriveSecretKey(password, salt, SECRET_ITERATIONS);
    return { envelope: sealSecretContent(key, iv, plaintext, salt), key, salt };
}

// 用口令解开信封：口令不对或密文被改动都返回 { ok: false }
function openSecretEnvelope(password, envelopeText) {
    const parsed = parseSecretEnvelope(envelopeText);
    if (!parsed) return { ok: false, error: '密文格式无法识别' };

    try {
        const key = deriveSecretKey(password, parsed.salt, parsed.iterations);
        const tag = parsed.ct.subarray(parsed.ct.length - SECRET_TAG_BYTES);
        const data = parsed.ct.subarray(0, parsed.ct.length - SECRET_TAG_BYTES);
        const decipher = nodeCrypto.createDecipheriv(SECRET_CIPHER, key, parsed.iv);
        decipher.setAuthTag(tag);
        const text = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
        return { ok: true, text, key, salt: parsed.salt, iterations: parsed.iterations };
    } catch (err) {
        return { ok: false, error: '密码不正确' };
    }
}

/* 落盘时使用的正文：条目带密码且本轮已解开时，按当前正文重新加密一份（盐沿用会话里的那份，
   每次换一个随机 IV）；未解开时 content 本身就是上次落下的密文，原样写回。
   加密条目永远走这里取正文，明文因此不会出现在磁盘上。 */
function serializeSecretBody(item) {
    const content = String((item && item.content) || '');
    if (!item || item.locked !== true) return content;
    const session = secretUnlocked.get(item.id);
    if (!session) return content;
    return sealSecretContent(session.key, nodeCrypto.randomBytes(SECRET_IV_BYTES), content, session.salt, session.iterations);
}

/* ---------------- 状态判定 ---------------- */

// 已设置密码但本轮还没解开：正文在内存里是密文，只读且不可导出
function isSecretLocked(item) {
    return !!(item && item.locked === true && item.unlocked !== true);
}

function isSecretHidden(item) {
    return !!(item && item.isHidden === true);
}

// 秘密本管理的条目：隐藏或加密，两者可以同时成立
function isSecretItem(item) {
    return !!(item && (item.locked === true || item.isHidden === true));
}

// 列表卡片、AI 提问范围与小本本只认「内容可读」的条目
function isSecretRevealed(item) {
    return !isSecretLocked(item);
}

function secretStateLabel(item) {
    const parts = [itemKindLabel(item)];
    if (isSecretHidden(item)) parts.push('已隐藏');
    if (item.locked === true) parts.push(item.unlocked === true ? '已加密 · 已解锁' : '已加密 · 未解锁');
    return parts.join(' · ');
}

/* ---------------- 会话密钥 ---------------- */

function clearSecretSession() {
    secretUnlocked.clear();
}

function forgetSecretKey(itemId) {
    secretUnlocked.delete(itemId);
}

/* ---------------- 操作 ---------------- */

async function askNewSecretPassword() {
    const password = await showPasswordPrompt('设置密码后正文将加密保存', {
        title: '设置密码',
        icon: 'lock',
        label: `密码（至少 ${SECRET_PASSWORD_MIN} 位）`,
        placeholder: '输入密码...',
        confirmLabel: '下一步',
        detail: '密码不会被保存，也无法找回：忘记密码后这篇文档的正文无法恢复。'
            + '标题、文件夹、标签与时间等元数据保持明文，正文以 AES-256-GCM 加密后落盘。'
    });
    if (password === null) return null;
    if (password.length < SECRET_PASSWORD_MIN) {
        showToast(`设置失败：密码至少 ${SECRET_PASSWORD_MIN} 位`);
        return null;
    }

    const repeat = await showPasswordPrompt('请再次输入同一密码', {
        title: '设置密码',
        icon: 'lock',
        label: '确认密码',
        placeholder: '再次输入密码...',
        confirmLabel: '设置密码'
    });
    if (repeat === null) return null;
    if (repeat !== password) {
        showToast('设置失败：两次输入的密码不一致');
        return null;
    }
    return password;
}

// 隐藏 / 取消隐藏：条目仍留在数据目录里，只是不再进入各处的列表
function toggleItemHidden(itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    item.isHidden = !isSecretHidden(item);
    saveItem(item);
    renderApp();
    showToast(item.isHidden ? '已隐藏：可在「设置 → 秘密本」中找回' : '已取消隐藏');
}

async function setItemPassword(itemId) {
    const item = getItemById(itemId);
    if (!item || item.locked === true) return;

    // 正在编辑的条目可能还有没落盘的输入：先写进内存，免得把旧正文加密进去
    if (State.activeNoteId === itemId) flushPendingSave();

    const password = await askNewSecretPassword();
    if (password === null) return;

    const sealed = encryptSecretContent(password, item.content || '');
    const plaintext = item.content || '';

    // 先按「已加密且未解锁」落盘一份密文，再把内存切回明文与已解锁状态：
    // 保存走的序列化函数只看 locked 与会话密钥，因此磁盘上留下的永远是密文
    item.locked = true;
    item.unlocked = false;
    item.content = sealed.envelope;
    saveItem(item);

    secretUnlocked.set(item.id, { key: sealed.key, salt: sealed.salt, iterations: SECRET_ITERATIONS });
    item.content = plaintext;
    item.unlocked = true;

    renderApp();
    showToast('已设置密码：正文以密文保存，关闭应用后需要重新输入密码');
}

async function unlockItem(itemId) {
    const item = getItemById(itemId);
    if (!item || !isSecretLocked(item)) return false;

    const password = await showPasswordPrompt(`输入《${itemDisplayTitle(item)}》的密码`, {
        title: '解锁文档',
        icon: 'lock_open',
        label: '密码',
        placeholder: '输入密码...',
        confirmLabel: '解锁'
    });
    if (password === null) return false;

    const opened = openSecretEnvelope(password, item.content);
    if (!opened.ok) {
        showToast(`解锁失败：${opened.error}`);
        return false;
    }

    secretUnlocked.set(item.id, { key: opened.key, salt: opened.salt, iterations: opened.iterations });
    item.content = opened.text;
    item.unlocked = true;

    renderApp();
    showToast('已解锁：关闭应用或点「立即锁定」后重新上锁');
    return true;
}

// 重新上锁：按当前正文再加密一份落盘，内存里的明文与密钥一并丢弃
function lockItemNow(itemId) {
    const item = getItemById(itemId);
    if (!item || item.locked !== true) return;
    if (State.activeNoteId === itemId) flushPendingSave();

    const session = secretUnlocked.get(item.id);
    if (session) {
        item.content = sealSecretContent(
            session.key,
            nodeCrypto.randomBytes(SECRET_IV_BYTES),
            item.content || '',
            session.salt,
            session.iterations
        );
    }
    item.unlocked = false;
    secretUnlocked.delete(item.id);
    saveItem(item);
    renderApp();
    showToast('已锁定');
}

async function removeItemPassword(itemId) {
    const item = getItemById(itemId);
    if (!item || item.locked !== true) return;
    if (State.activeNoteId === itemId) flushPendingSave();

    let plaintext = '';
    if (item.unlocked === true) {
        // 本轮已解锁：会话密钥已经证明过口令，不再问第二遍
        plaintext = item.content || '';
    } else {
        const password = await showPasswordPrompt(`解除《${itemDisplayTitle(item)}》的密码`, {
            title: '解除密码',
            icon: 'key_off',
            label: '密码',
            placeholder: '输入密码...',
            confirmLabel: '解除密码',
            detail: '验证通过后正文恢复为明文保存，该文档不再需要密码即可打开。'
        });
        if (password === null) return;

        const opened = openSecretEnvelope(password, item.content);
        if (!opened.ok) {
            showToast(`解除失败：${opened.error}`);
            return;
        }
        plaintext = opened.text;
    }

    item.content = plaintext;
    item.locked = false;
    item.unlocked = false;
    secretUnlocked.delete(item.id);
    saveItem(item);
    renderApp();
    showToast('已解除密码：正文恢复为明文保存');
}

// 需要正文明文的动作（导出 Markdown 等）先走这里：未解锁时先弹密码框
async function ensureItemRevealed(itemId) {
    const item = getItemById(itemId);
    if (!item || !isSecretLocked(item)) return !!item;
    return unlockItem(itemId);
}

/* ---------------- 设置页：秘密本 ---------------- */

function secretActionButton(label, title, variant, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `settings-btn${variant ? ` ${variant}` : ''}`;
    btn.textContent = label;
    if (title) btn.title = title;
    btn.onclick = onClick;
    return btn;
}

function createSecretRow(item) {
    const row = document.createElement('div');
    row.className = 'secret-item';

    const main = document.createElement('div');
    main.className = 'secret-item-main';

    const icon = document.createElement('span');
    icon.className = 'ms-icon sm';
    icon.textContent = item.locked === true ? (item.unlocked === true ? 'lock_open' : 'lock') : 'visibility_off';

    const text = document.createElement('div');
    text.className = 'secret-item-text';

    const title = document.createElement('span');
    title.className = 'secret-item-title';
    title.textContent = itemDisplayTitle(item);

    const meta = document.createElement('span');
    meta.className = 'secret-item-meta';
    meta.textContent = `${secretStateLabel(item)} · 修改于 ${formatDate(item.updatedAt)}`;

    text.append(title, meta);
    main.append(icon, text);

    const actions = document.createElement('div');
    actions.className = 'settings-actions';

    actions.appendChild(secretActionButton('打开', '在标签页打开该文档', '', () => {
        openTab(item.id);
        renderApp();
    }));

    if (isSecretHidden(item)) {
        actions.appendChild(secretActionButton('取消隐藏', '重新出现在列表与搜索中', '', () => toggleItemHidden(item.id)));
    }

    if (isSecretLocked(item)) {
        actions.appendChild(secretActionButton('解锁', '输入密码后查看与编辑正文', 'primary', () => unlockItem(item.id)));
    } else if (item.locked === true) {
        actions.appendChild(secretActionButton('立即锁定', '清除内存里的明文与密钥', '', () => lockItemNow(item.id)));
    }

    actions.appendChild(item.locked === true
        ? secretActionButton('解除密码', '验证密码后改为明文保存', '', () => removeItemPassword(item.id))
        : secretActionButton('设置密码', '加密正文，打开时需要输入密码', '', () => setItemPassword(item.id)));

    row.append(main, actions);
    return row;
}

function syncSecretSettingsUI() {
    const container = document.getElementById('secret-list');
    if (!container) return;

    const items = [...State.notes, ...State.todos]
        .filter(isSecretItem)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    container.innerHTML = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'secret-empty';
        empty.textContent = '暂无隐藏或已加密的文档：在列表里右键一篇笔记或待办即可设置。';
        container.appendChild(empty);
    } else {
        items.forEach(item => container.appendChild(createSecretRow(item)));
    }

    const status = document.getElementById('secret-status');
    if (status) {
        const hidden = items.filter(isSecretHidden).length;
        const locked = items.filter(item => item.locked === true).length;
        const opened = items.filter(item => item.locked === true && item.unlocked === true).length;
        status.textContent = `共 ${items.length} 条：隐藏 ${hidden} 条 · 加密 ${locked} 条（本轮已解锁 ${opened} 条）`;
    }
}

function initSecretSettings() {
    const refreshBtn = document.getElementById('btn-secret-refresh');
    if (refreshBtn) {
        refreshBtn.onclick = () => {
            syncSecretSettingsUI();
            showToast('已刷新秘密本');
        };
    }
}
