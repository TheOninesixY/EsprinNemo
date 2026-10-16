'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
    USERS_FILE_NAME,
    USERS_DIR_NAME,
    TOKENS_FILE_NAME,
    LEGACY_ADMIN_FILE_NAME,
    JOURNAL_NAME,
    JOURNAL_ID_NAME,
    DEFAULT_ACCOUNT_ID,
    DEFAULT_ACCOUNT_NAME,
    ACCOUNT_NAME_MAX,
    RESERVED_DIR_NAMES,
    SESSION_TTL_SECONDS,
    LOGIN_WINDOW_SECONDS,
    LOGIN_MAX_FAILURES,
    TOKEN_TOUCH_INTERVAL_SECONDS,
    MIN_PASSWORD_LENGTH,
    nowMs,
    log,
    hashPassword,
    verifyPassword,
    safeEqual,
    writeJsonAtomic,
    ensureDir,
    removeTree
} = require('./lib.js');
const { Journal } = require('./journal.js');

class UserStore {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.usersPath = path.join(dataDir, USERS_FILE_NAME);
        this.secret = '';
        this.users = [];
        this.tokens = new Map();
        this.journals = new Map();
        this.sessions = new Map();
        this.failures = new Map();
        this.load();
    }

    load() {
        ensureDir(this.dataDir);

        if (!this.loadUsersFile()) this.bootstrapUsers();

        if (!this.findUser(DEFAULT_ACCOUNT_ID)) {
            this.users.push({
                id: DEFAULT_ACCOUNT_ID,
                name: DEFAULT_ACCOUNT_NAME,
                password: '',
                admin: true,
                enabled: true,
                createdAt: nowMs(),
                lastLoginAt: 0
            });
            this.saveUsers();
            log('WARN', 'Users', `users.json 里缺少内置账户，已补回 (id=${DEFAULT_ACCOUNT_ID})`);
        }

        if (!this.secret) {
            this.secret = crypto.randomBytes(32).toString('hex');
            this.saveUsers();
        }

        this.migrateLegacyFiles();
        for (const user of this.users) this.loadTokens(user.id);
    }

    loadUsersFile() {
        let data = null;
        try {
            data = JSON.parse(fs.readFileSync(this.usersPath, 'utf8'));
        } catch (error) {
            return false;
        }
        if (!data || typeof data !== 'object' || !Array.isArray(data.users)) return false;

        const loaded = [];
        for (const item of data.users) {
            if (!item || typeof item !== 'object') continue;
            const userId = String(item.id || '').trim();
            const name = String(item.name || '').trim();
            if (!userId || !name) continue;
            loaded.push({
                id: userId,
                name,
                password: String(item.password || ''),
                admin: Boolean(item.admin),
                enabled: item.enabled !== false,
                createdAt: Number.parseInt(item.createdAt, 10) || 0,
                lastLoginAt: Number.parseInt(item.lastLoginAt, 10) || 0
            });
        }
        if (!loaded.length) return false;

        this.secret = String(data.secret || '');
        this.users = loaded;

        const builtin = this.findUser(DEFAULT_ACCOUNT_ID);
        if (builtin) {
            builtin.admin = true;
            builtin.enabled = true;
        }
        return true;
    }

    bootstrapUsers() {
        let password = '';
        let secret = '';
        const legacyPath = path.join(this.dataDir, LEGACY_ADMIN_FILE_NAME);
        try {
            const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
            if (legacy && typeof legacy === 'object') {
                password = String(legacy.password || '');
                secret = String(legacy.secret || '');
            }
        } catch (error) {
            void error;
        }

        this.secret = secret || this.secret || crypto.randomBytes(32).toString('hex');
        this.users = [{
            id: DEFAULT_ACCOUNT_ID,
            name: DEFAULT_ACCOUNT_NAME,
            password,
            admin: true,
            enabled: true,
            createdAt: nowMs(),
            lastLoginAt: 0
        }];

        const recovered = this.recoverAccountDirs();
        this.saveUsers();
        log('INFO', 'Users', `已初始化账户表: 内置账户=${DEFAULT_ACCOUNT_NAME} 沿用旧密码=${Boolean(password)} 补回账户=${recovered}`);

        if (password || secret) {
            try {
                fs.renameSync(legacyPath, `${legacyPath}.migrated`);
                log('INFO', 'Users', `旧版 ${LEGACY_ADMIN_FILE_NAME} 已归档为 ${LEGACY_ADMIN_FILE_NAME}.migrated(不再被读取)`);
            } catch (error) {
                log('WARN', 'Users', `归档旧版 ${LEGACY_ADMIN_FILE_NAME} 失败: ${error.message} (path=${legacyPath})`);
            }
        }
    }

    recoverAccountDirs() {
        const root = path.join(this.dataDir, USERS_DIR_NAME);
        if (!fs.existsSync(root)) return 0;
        let count = 0;
        for (const name of fs.readdirSync(root).sort()) {
            if (name === DEFAULT_ACCOUNT_ID) continue;
            let isDir = false;
            try {
                isDir = fs.statSync(path.join(root, name)).isDirectory();
            } catch (error) {
                isDir = false;
            }
            if (!isDir) continue;
            if (!this.validateName(name)) continue;
            this.users.push({
                id: name,
                name,
                password: '',
                admin: false,
                enabled: true,
                createdAt: nowMs(),
                lastLoginAt: 0
            });
            count += 1;
        }
        if (count) log('WARN', 'Users', `账户表缺失，已按数据目录补回 ${count} 个账户，密码需重新设置`);
        return count;
    }

    migrateLegacyFiles() {
        const targetDir = this.userDir(DEFAULT_ACCOUNT_ID);
        const moved = [];
        for (const name of [JOURNAL_NAME, JOURNAL_ID_NAME, TOKENS_FILE_NAME]) {
            const source = path.join(this.dataDir, name);
            if (!fs.existsSync(source)) continue;
            const target = path.join(targetDir, name);
            if (fs.existsSync(target)) continue;
            try {
                ensureDir(targetDir);
                fs.renameSync(source, target);
                moved.push(name);
            } catch (error) {
                log('ERROR', 'Users', `迁移旧版文件失败: ${error.message} (from=${source} to=${target})`);
            }
        }
        if (moved.length) {
            log('INFO', 'Users', `已迁移旧版单账户数据: dir=${targetDir} files=${moved.join(',')}`);
        }
    }

    saveUsers() {
        writeJsonAtomic(this.usersPath, { version: 1, secret: this.secret, users: this.users });
    }

    findUser(userId) {
        const wanted = String(userId == null ? '' : userId);
        return this.users.find((user) => user.id === wanted) || null;
    }

    findUserByName(name) {
        const wanted = String(name == null ? '' : name).trim().toLowerCase();
        if (!wanted) return null;
        return this.users.find((user) => user.name.toLowerCase() === wanted) || null;
    }

    builtinUser() {
        return this.findUser(DEFAULT_ACCOUNT_ID);
    }

    passwordSet() {
        const user = this.builtinUser();
        return Boolean(user && user.password);
    }

    setPassword(password) {
        const user = this.builtinUser();
        if (!user || user.password) return false;
        user.password = hashPassword(password);
        this.saveUsers();
        return true;
    }

    changePassword(userId, oldPassword, newPassword) {
        const user = this.findUser(userId);
        if (!user || !verifyPassword(oldPassword, user.password || '')) return false;
        user.password = hashPassword(newPassword);
        this.destroyUserSessions(user.id);
        this.saveUsers();
        return true;
    }

    resetPassword(userId, password) {
        const user = this.findUser(userId);
        if (!user) return { ok: false, error: '找不到该账户' };
        if (String(password || '').length < MIN_PASSWORD_LENGTH) {
            return { ok: false, error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` };
        }
        user.password = hashPassword(password);
        this.destroyUserSessions(user.id);
        this.saveUsers();
        return { ok: true, error: '' };
    }

    listUsers() {
        return this.sortedUsers().map((user) => this.describeUser(user));
    }

    describeUser(user) {
        const summary = this.journal(user.id).summary();
        return {
            id: user.id,
            name: user.name,
            admin: Boolean(user.admin),
            enabled: Boolean(user.enabled),
            builtIn: user.id === DEFAULT_ACCOUNT_ID,
            passwordSet: Boolean(user.password),
            createdAt: Number.parseInt(user.createdAt, 10) || 0,
            lastLoginAt: Number.parseInt(user.lastLoginAt, 10) || 0,
            tokenCount: (this.tokens.get(user.id) || []).length,
            journal: {
                ops: summary.ops,
                files: summary.files,
                deleted: summary.deleted,
                recyclable: summary.recyclable,
                size: summary.size,
                exists: summary.exists
            }
        };
    }

    sortedUsers() {
        return [...this.users].sort((left, right) => {
            const leftBuiltin = left.id !== DEFAULT_ACCOUNT_ID ? 1 : 0;
            const rightBuiltin = right.id !== DEFAULT_ACCOUNT_ID ? 1 : 0;
            if (leftBuiltin !== rightBuiltin) return leftBuiltin - rightBuiltin;
            return (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0);
        });
    }

    validateName(name, excludeId = '') {
        const text = String(name == null ? '' : name).trim();
        if (!text) return '账户名不能为空';
        if (text.length > ACCOUNT_NAME_MAX) return `账户名最多 ${ACCOUNT_NAME_MAX} 个字符`;
        if (/[/\\]/.test(text) || [...text].some((char) => char.charCodeAt(0) < 32)) {
            return '账户名不能包含斜杠或控制字符';
        }
        const existing = this.users.find((user) => user.id !== excludeId
            && user.name.toLowerCase() === text.toLowerCase());
        return existing ? '账户名已存在' : '';
    }

    makeId(name) {
        const taken = new Set(this.users.map((user) => user.id.toLowerCase()));
        const slug = String(name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 24).replace(/^[-_]+|[-_]+$/g, '');
        if (slug && !taken.has(slug) && !RESERVED_DIR_NAMES.has(slug)) return slug;
        for (let attempt = 0; attempt < 16; attempt += 1) {
            const candidate = `u_${crypto.randomBytes(6).toString('hex')}`;
            if (!taken.has(candidate.toLowerCase())) return candidate;
        }
        return `u_${crypto.randomUUID().replace(/-/g, '')}`;
    }

    createUser(name, password, isAdmin = false) {
        const text = String(name == null ? '' : name).trim();
        const error = this.validateName(text);
        if (error) return { user: null, error };
        if (String(password || '').length < MIN_PASSWORD_LENGTH) {
            return { user: null, error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` };
        }
        const user = {
            id: this.makeId(text),
            name: text,
            password: hashPassword(password),
            admin: Boolean(isAdmin),
            enabled: true,
            createdAt: nowMs(),
            lastLoginAt: 0
        };
        this.users.push(user);
        this.tokens.set(user.id, []);
        this.saveUsers();
        log('INFO', 'Users', `新建账户: name=${text} id=${user.id} admin=${user.admin}`);
        return { user: this.describeUser(user), error: '' };
    }

    updateUser(userId, { name, enabled, isAdmin } = {}) {
        const user = this.findUser(userId);
        if (!user) return { user: null, error: '找不到该账户' };
        const builtin = user.id === DEFAULT_ACCOUNT_ID;

        if (name !== undefined && String(name).trim() !== user.name) {
            if (builtin) return { user: null, error: `内置账户 ${DEFAULT_ACCOUNT_NAME} 不能改名` };
            const error = this.validateName(name, user.id);
            if (error) return { user: null, error };
            user.name = String(name).trim();
        }

        if (enabled !== undefined) {
            if (builtin && !enabled) return { user: null, error: `内置账户 ${DEFAULT_ACCOUNT_NAME} 不能停用` };
            user.enabled = Boolean(enabled);
            if (!user.enabled) this.destroyUserSessions(user.id);
        }

        if (isAdmin !== undefined) {
            if (builtin && !isAdmin) return { user: null, error: `内置账户 ${DEFAULT_ACCOUNT_NAME} 不能取消管理员` };
            user.admin = Boolean(isAdmin);
        }

        this.saveUsers();
        log('INFO', 'Users', `更新账户: name=${user.name} id=${user.id} enabled=${user.enabled} admin=${user.admin}`);
        return { user: this.describeUser(user), error: '' };
    }

    deleteUser(userId) {
        const user = this.findUser(userId);
        if (!user) return { ok: false, error: '找不到该账户' };
        if (user.id === DEFAULT_ACCOUNT_ID) {
            return { ok: false, error: `内置账户 ${DEFAULT_ACCOUNT_NAME} 不能删除` };
        }

        this.users = this.users.filter((item) => item.id !== user.id);
        this.tokens.delete(user.id);
        this.journals.delete(user.id);
        this.destroyUserSessions(user.id);
        this.saveUsers();

        const target = this.userDir(user.id);
        let dataRemoved = false;
        if (fs.existsSync(target)) {
            removeTree(target);
            dataRemoved = !fs.existsSync(target);
        }
        log('INFO', 'Users', `已删除账户: name=${user.name} id=${user.id} dataRemoved=${dataRemoved}`);
        return { ok: true, error: '' };
    }

    authenticate(name, password) {
        const text = String(name == null ? '' : name).trim();
        const user = text ? this.findUserByName(text) : this.builtinUser();
        if (!user || !verifyPassword(password, user.password || '')) {
            return { user: null, error: '账户名或密码不正确' };
        }
        if (!user.enabled) return { user: null, error: '该账户已停用' };
        user.lastLoginAt = nowMs();
        this.saveUsers();
        return { user, error: '' };
    }

    tokenRecords(userId) {
        const key = String(userId);
        if (!this.tokens.has(key)) this.tokens.set(key, []);
        return this.tokens.get(key);
    }

    tokensPath(userId) {
        return path.join(this.userDir(userId), TOKENS_FILE_NAME);
    }

    loadTokens(userId) {
        let data = null;
        try {
            data = JSON.parse(fs.readFileSync(this.tokensPath(userId), 'utf8'));
        } catch (error) {
            return;
        }
        const records = data && typeof data === 'object' ? data.tokens : null;
        if (Array.isArray(records)) {
            this.tokens.set(String(userId), records.filter((item) => item && typeof item === 'object' && item.id));
        }
    }

    saveTokens(userId) {
        ensureDir(this.userDir(userId));
        writeJsonAtomic(this.tokensPath(userId), { version: 1, tokens: this.tokenRecords(userId) });
    }

    tokenCount() {
        let total = 0;
        for (const records of this.tokens.values()) total += records.length;
        return total;
    }

    userDir(userId) {
        return path.join(this.dataDir, USERS_DIR_NAME, String(userId));
    }

    journal(userId) {
        const key = String(userId);
        if (!this.journals.has(key)) this.journals.set(key, new Journal(this.userDir(key)));
        return this.journals.get(key);
    }

    createSession(userId, ip) {
        const now = nowMs();
        for (const [key, value] of this.sessions) {
            if (now - value.lastSeenAt >= SESSION_TTL_SECONDS * 1000) this.sessions.delete(key);
        }
        const sessionId = crypto.randomBytes(32).toString('base64url');
        this.sessions.set(sessionId, { userId: String(userId), createdAt: now, lastSeenAt: now, ip });
        return sessionId;
    }

    touchSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        const now = nowMs();
        if (now - session.lastSeenAt > SESSION_TTL_SECONDS * 1000) {
            this.sessions.delete(sessionId);
            return null;
        }
        session.lastSeenAt = now;
        return session;
    }

    sessionUser(sessionId) {
        const session = this.touchSession(sessionId);
        if (!session) return { user: null, session: null };
        const user = this.findUser(session.userId);
        if (!user || !user.enabled) {
            this.destroySession(sessionId);
            return { user: null, session: null };
        }
        return { user, session };
    }

    destroySession(sessionId) {
        this.sessions.delete(sessionId);
    }

    destroyUserSessions(userId) {
        for (const [key, value] of this.sessions) {
            if (value.userId === String(userId)) this.sessions.delete(key);
        }
    }

    loginAllowed(ip) {
        const now = Date.now() / 1000;
        const history = (this.failures.get(ip) || []).filter((stamp) => now - stamp < LOGIN_WINDOW_SECONDS);
        this.failures.set(ip, history);
        return history.length < LOGIN_MAX_FAILURES;
    }

    noteLoginFailure(ip) {
        if (!this.failures.has(ip)) this.failures.set(ip, []);
        this.failures.get(ip).push(Date.now() / 1000);
    }

    digest(token) {
        return crypto.createHmac('sha256', this.secret).update(String(token), 'utf8').digest('hex');
    }

    findById(userId, tokenId) {
        return this.tokenRecords(userId).find((item) => item.id === tokenId) || null;
    }

    listTokens(userId) {
        return this.tokenRecords(userId).map((item) => {
            const copy = { ...item };
            delete copy.digest;
            return copy;
        });
    }

    createToken(userId, name, device) {
        const token = `esn_${crypto.randomBytes(24).toString('base64url')}`;
        const record = {
            id: `tk_${crypto.randomBytes(6).toString('hex')}`,
            name: String(name == null ? '' : name).trim() || '未命名设备',
            device: String(device == null ? '' : device).trim(),
            digest: this.digest(token),
            createdAt: nowMs(),
            lastUsedAt: 0,
            lastDeviceId: '',
            enabled: true
        };
        this.tokenRecords(userId).push(record);
        this.saveTokens(userId);
        return { id: record.id, token };
    }

    rotateToken(userId, tokenId) {
        const record = this.findById(userId, tokenId);
        if (!record) return null;
        const token = `esn_${crypto.randomBytes(24).toString('base64url')}`;
        record.digest = this.digest(token);
        record.lastUsedAt = 0;
        this.saveTokens(userId);
        return token;
    }

    updateToken(userId, tokenId, { name, device, enabled } = {}) {
        const record = this.findById(userId, tokenId);
        if (!record) return null;
        if (name !== undefined) record.name = String(name).trim() || record.name;
        if (device !== undefined) record.device = String(device).trim();
        if (enabled !== undefined) record.enabled = Boolean(enabled);
        this.saveTokens(userId);
        const copy = { ...record };
        delete copy.digest;
        return copy;
    }

    deleteToken(userId, tokenId) {
        const records = this.tokenRecords(userId);
        const next = records.filter((item) => item.id !== tokenId);
        if (next.length === records.length) return false;
        this.tokens.set(String(userId), next);
        this.saveTokens(userId);
        return true;
    }

    findTokenByPlain(token) {
        if (!token) return { userId: null, record: null };
        const digest = this.digest(token);
        for (const [userId, records] of this.tokens) {
            for (const item of records) {
                if (safeEqual(String(item.digest || ''), digest)) {
                    return { userId, record: item };
                }
            }
        }
        return { userId: null, record: null };
    }

    noteTokenUse(userId, record, deviceId) {
        const now = nowMs();
        let changed = false;
        if (deviceId && record.lastDeviceId !== deviceId) {
            record.lastDeviceId = deviceId;
            changed = true;
        }
        if (now - (Number.parseInt(record.lastUsedAt, 10) || 0) > TOKEN_TOUCH_INTERVAL_SECONDS * 1000) {
            record.lastUsedAt = now;
            changed = true;
        }
        if (changed) this.saveTokens(userId);
    }
}

module.exports = { UserStore };
