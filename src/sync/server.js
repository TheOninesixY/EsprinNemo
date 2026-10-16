'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const lib = require('./lib.js');
const assets = require('./assets.js');
const { UserStore } = require('./store.js');

const ADMIN_ASSET_PATHS = new Set(['/app.css', '/app.js', '/Main.svg', '/Main.new.svg']);
const ADMIN_ASSET_PREFIXES = ['/fonts/'];

function sendJson(res, status, payload, headers = {}) {
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        ...headers
    });
    res.end(body);
}

function sendRaw(res, status, body, contentType, headers = {}) {
    res.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': body.length,
        ...headers
    });
    res.end(body);
}

function parseCookies(header) {
    const result = {};
    for (const part of String(header || '').split(';')) {
        const cut = part.indexOf('=');
        if (cut === -1) continue;
        result[part.slice(0, cut).trim()] = part.slice(cut + 1).trim();
    }
    return result;
}

function sameOrigin(req) {
    const origin = String(req.headers.origin || '');
    if (!origin) return true;
    try {
        const parsed = new URL(origin);
        return Boolean(parsed.host) && parsed.host === String(req.headers.host || '');
    } catch (error) {
        return false;
    }
}

function readJsonBody(req, body) {
    if (!body.length || body.length > lib.MAX_BODY_BYTES) return null;
    try {
        return JSON.parse(body.toString('utf8'));
    } catch (error) {
        return null;
    }
}

function createRequestHandler(users, token) {
    function sessionCookie(sessionId) {
        return `${lib.ADMIN_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lib.SESSION_TTL_SECONDS}`;
    }

    function expiredCookie() {
        return `${lib.ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    }

    function currentUser(req) {
        const sessionId = parseCookies(req.headers.cookie)[lib.ADMIN_COOKIE_NAME] || '';
        if (!sessionId) return null;
        return users.sessionUser(sessionId).user;
    }

    function authorizeApi(req) {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const value = header.slice(7).trim();
            if (token && lib.safeEqual(value, token)) {
                return {
                    record: { id: '', name: '启动参数 --token', device: '', builtin: true, userId: lib.DEFAULT_ACCOUNT_ID },
                    error: ''
                };
            }
            const found = users.findTokenByPlain(value);
            if (!found.record) {
                return { record: null, error: '令牌无效（请在管理后台确认，或看看是不是刚重置过）' };
            }
            if (found.record.enabled === false) return { record: null, error: '该令牌已在管理后台停用' };
            const user = users.findUser(found.userId);
            if (!user || !user.enabled) return { record: null, error: '该令牌所属的账户已停用' };
            return {
                record: {
                    id: found.record.id,
                    name: found.record.name || '',
                    device: found.record.device || '',
                    builtin: false,
                    userId: found.userId,
                    userName: user.name,
                    tokenRecord: found.record
                },
                error: ''
            };
        }

        if (sameOrigin(req)) {
            const user = currentUser(req);
            if (user) {
                return {
                    record: { id: '', name: `登录会话 ${user.name}`, device: '', builtin: false, userId: user.id, userName: user.name },
                    error: ''
                };
            }
        }

        return { record: null, error: '缺少凭据（请先登录，客户端请在设置里填写访问令牌）' };
    }

    function sendStaticAsset(res, root, relative) {
        const target = path.resolve(root, String(relative || '').replace(/^\/+/, ''));
        if (!target.startsWith(path.resolve(root) + path.sep)) {
            sendJson(res, 404, { ok: false, error: '找不到文件' });
            return;
        }
        const body = assets.readAsset(target);
        if (!body) {
            sendJson(res, 404, { ok: false, error: '找不到文件' });
            return;
        }
        const extension = path.extname(target).toLowerCase();
        sendRaw(res, 200, body, lib.ASSET_CONTENT_TYPES[extension] || 'application/octet-stream',
            { 'Cache-Control': 'no-store' });
    }

    function sendJournalAttachment(res, journal) {
        if (!fs.existsSync(journal.path)) {
            sendJson(res, 404, { ok: false, error: '日志文件还不存在：该账户还没有同步过任何内容' });
            return;
        }
        let stat = null;
        try {
            stat = fs.statSync(journal.path);
        } catch (error) {
            sendJson(res, 500, { ok: false, error: '读取日志失败' });
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Length': stat.size,
            'Content-Disposition': `attachment; filename="${lib.journalDownloadName()}"`,
            'Cache-Control': 'no-store'
        });
        fs.createReadStream(journal.path).pipe(res);
    }

    function resolveAccount(raw, fallback) {
        const text = String(raw == null ? '' : raw).trim();
        if (!text) return { userId: fallback, error: '' };
        const user = users.findUser(text) || users.findUserByName(text);
        if (!user) return { userId: null, error: '找不到该账户' };
        return { userId: user.id, error: '' };
    }

    function handleAdminGet(req, res, pathname, query) {
        if (pathname === `${lib.API_PREFIX}/status`) {
            const user = currentUser(req);
            sendJson(res, 200, {
                ok: true,
                version: lib.SERVER_VERSION,
                passwordSet: users.passwordSet(),
                loggedIn: Boolean(user),
                admin: Boolean(user && user.admin),
                user: user ? { id: user.id, name: user.name, admin: Boolean(user.admin) } : null,
                accountCount: users.users.length,
                tokenCount: users.tokenCount()
            });
            return;
        }

        const current = currentUser(req);
        if (!current) {
            sendJson(res, 401, { ok: false, error: '请先登录管理后台' });
            return;
        }
        if (!current.admin) {
            sendJson(res, 403, { ok: false, error: '该账户没有管理权限' });
            return;
        }

        const account = query.get('user') || '';

        if (pathname === `${lib.API_PREFIX}/users`) {
            sendJson(res, 200, { ok: true, users: users.listUsers() });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/journal` || pathname === `${lib.API_PREFIX}/journal/download`) {
            const resolved = resolveAccount(account, current.id);
            if (!resolved.userId) {
                sendJson(res, 404, { ok: false, error: resolved.error });
                return;
            }
            const journal = users.journal(resolved.userId);
            if (pathname.endsWith('/download')) {
                sendJournalAttachment(res, journal);
                return;
            }
            sendJson(res, 200, { ok: true, user: resolved.userId, ...journal.summary() });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/tokens`) {
            const resolved = resolveAccount(account, current.id);
            if (!resolved.userId) {
                sendJson(res, 404, { ok: false, error: resolved.error });
                return;
            }
            sendJson(res, 200, { ok: true, user: resolved.userId, tokens: users.listTokens(resolved.userId) });
            return;
        }

        sendJson(res, 404, { ok: false, error: '未知接口' });
    }

    function handleAdminPost(req, res, pathname, payload, body) {
        const bodyJson = payload || {};

        if (pathname === `${lib.API_PREFIX}/setup-password`) {
            const password = String(bodyJson.password || '');
            if (password.length < lib.MIN_PASSWORD_LENGTH) {
                sendJson(res, 400, { ok: false, error: `密码至少 ${lib.MIN_PASSWORD_LENGTH} 位` });
                return;
            }
            if (!users.setPassword(password)) {
                sendJson(res, 400, { ok: false, error: '管理密码已经设置过了，请用现有密码登录' });
                return;
            }
            const sessionId = users.createSession(lib.DEFAULT_ACCOUNT_ID, req.socket.remoteAddress || '');
            lib.log('INFO', 'Auth', `内置账户已设密码: name=${lib.DEFAULT_ACCOUNT_NAME}`);
            sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(sessionId) });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/login`) {
            const ip = req.socket.remoteAddress || '';
            if (!users.loginAllowed(ip)) {
                sendJson(res, 429, { ok: false, error: '尝试次数过多，请稍后再试' });
                return;
            }
            const result = users.authenticate(bodyJson.name, bodyJson.password);
            if (!result.user) {
                users.noteLoginFailure(ip);
                sendJson(res, 401, { ok: false, error: result.error });
                return;
            }
            if (bodyJson.requireAdmin && !result.user.admin) {
                sendJson(res, 403, { ok: false, error: '该账户不是管理员，无法进入管理后台' });
                return;
            }
            const sessionId = users.createSession(result.user.id, ip);
            lib.log('INFO', 'Auth', `登录成功: name=${result.user.name} admin=${result.user.admin} ip=${ip}`);
            sendJson(res, 200, {
                ok: true,
                user: { id: result.user.id, name: result.user.name, admin: Boolean(result.user.admin) }
            }, { 'Set-Cookie': sessionCookie(sessionId) });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/tokens/generate`) {
            const ip = req.socket.remoteAddress || '';
            if (!users.loginAllowed(ip)) {
                sendJson(res, 429, { ok: false, error: '尝试次数过多，请稍后再试' });
                return;
            }
            const password = String(bodyJson.password || '');
            if (!password) {
                sendJson(res, 400, { ok: false, error: '请填写账户密码' });
                return;
            }
            const result = users.authenticate(bodyJson.name, password);
            if (!result.user) {
                users.noteLoginFailure(ip);
                sendJson(res, 401, { ok: false, error: result.error });
                return;
            }
            const created = users.createToken(result.user.id, bodyJson.tokenName, bodyJson.device);
            lib.log('INFO', 'Auth', `为账户签发访问令牌: name=${result.user.name} tokenId=${created.id} ip=${ip}`);
            sendJson(res, 200, {
                ok: true,
                id: created.id,
                token: created.token,
                user: { id: result.user.id, name: result.user.name, admin: Boolean(result.user.admin) },
                tokens: users.listTokens(result.user.id)
            });
            return;
        }

        const current = currentUser(req);
        if (!current) {
            sendJson(res, 401, { ok: false, error: '请先登录' });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/logout`) {
            users.destroySession(parseCookies(req.headers.cookie)[lib.ADMIN_COOKIE_NAME] || '');
            sendJson(res, 200, { ok: true }, { 'Set-Cookie': expiredCookie() });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/password`) {
            const newPassword = String(bodyJson.newPassword || '');
            if (newPassword.length < lib.MIN_PASSWORD_LENGTH) {
                sendJson(res, 400, { ok: false, error: `新密码至少 ${lib.MIN_PASSWORD_LENGTH} 位` });
                return;
            }
            if (!users.changePassword(current.id, String(bodyJson.oldPassword || ''), newPassword)) {
                sendJson(res, 400, { ok: false, error: '当前密码不正确' });
                return;
            }
            const sessionId = users.createSession(current.id, req.socket.remoteAddress || '');
            sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(sessionId) });
            return;
        }

        if (!current.admin) {
            sendJson(res, 403, { ok: false, error: '该账户没有管理权限' });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/users/create`) {
            const created = users.createUser(bodyJson.name, bodyJson.password, Boolean(bodyJson.admin));
            if (!created.user) {
                sendJson(res, 400, { ok: false, error: created.error });
                return;
            }
            sendJson(res, 200, { ok: true, user: created.user, users: users.listUsers() });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/users/update`) {
            const updated = users.updateUser(String(bodyJson.id || ''), {
                name: bodyJson.name,
                enabled: bodyJson.enabled,
                isAdmin: bodyJson.admin
            });
            if (!updated.user) {
                sendJson(res, 400, { ok: false, error: updated.error });
                return;
            }
            sendJson(res, 200, { ok: true, user: updated.user, users: users.listUsers() });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/users/password`) {
            const done = users.resetPassword(String(bodyJson.id || ''), bodyJson.password);
            if (!done.ok) {
                sendJson(res, 400, { ok: false, error: done.error });
                return;
            }
            sendJson(res, 200, { ok: true, users: users.listUsers() });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/users/delete`) {
            const removed = users.deleteUser(String(bodyJson.id || ''));
            if (!removed.ok) {
                sendJson(res, 400, { ok: false, error: removed.error });
                return;
            }
            sendJson(res, 200, { ok: true, users: users.listUsers() });
            return;
        }

        const resolved = resolveAccount(bodyJson.user, current.id);
        if (!resolved.userId) {
            sendJson(res, 404, { ok: false, error: resolved.error });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/tokens`) {
            const created = users.createToken(resolved.userId, bodyJson.name, bodyJson.device);
            sendJson(res, 200, {
                ok: true,
                id: created.id,
                token: created.token,
                user: resolved.userId,
                tokens: users.listTokens(resolved.userId)
            });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/tokens/rotate`) {
            const token = users.rotateToken(resolved.userId, String(bodyJson.id || ''));
            if (!token) {
                sendJson(res, 404, { ok: false, error: '找不到该令牌' });
                return;
            }
            sendJson(res, 200, { ok: true, token, tokens: users.listTokens(resolved.userId) });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/tokens/update`) {
            const record = users.updateToken(resolved.userId, String(bodyJson.id || ''), {
                name: bodyJson.name,
                device: bodyJson.device,
                enabled: bodyJson.enabled
            });
            if (!record) {
                sendJson(res, 404, { ok: false, error: '找不到该令牌' });
                return;
            }
            sendJson(res, 200, { ok: true, tokens: users.listTokens(resolved.userId) });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/tokens/delete`) {
            if (!users.deleteToken(resolved.userId, String(bodyJson.id || ''))) {
                sendJson(res, 404, { ok: false, error: '找不到该令牌' });
                return;
            }
            sendJson(res, 200, { ok: true, tokens: users.listTokens(resolved.userId) });
            return;
        }

        if (pathname === `${lib.API_PREFIX}/journal/compact`) {
            const compacted = users.journal(resolved.userId).compact();
            sendJson(res, 200, {
                ok: true,
                user: resolved.userId,
                ...compacted,
                journal: users.journal(resolved.userId).summary()
            });
            return;
        }

        sendJson(res, 404, { ok: false, error: '未知接口' });
    }

    function handleGet(req, res, url, query) {
        const pathname = url.pathname;

        if (pathname === `${lib.SYNC_PATH}/health`) {
            const payload = {
                ok: true,
                name: lib.SERVER_NAME,
                version: lib.SERVER_VERSION,
                journalId: '',
                latestSeq: 0,
                account: '',
                authRequired: true,
                syncPath: lib.SYNC_PATH,
                webPath: '/',
                adminPath: lib.ADMIN_PATH
            };
            const auth = authorizeApi(req);
            if (auth.record) {
                const journal = users.journal(auth.record.userId);
                payload.journalId = journal.journalId;
                payload.latestSeq = journal.latestSeq;
                payload.account = auth.record.userName || lib.DEFAULT_ACCOUNT_NAME;
            }
            sendJson(res, 200, payload);
            return;
        }

        if (pathname === lib.HEALTH_PATH) {
            sendJson(res, 200, {
                ok: true,
                name: lib.SERVER_NAME,
                version: lib.SERVER_VERSION,
                syncPath: lib.SYNC_PATH,
                webPath: '/',
                adminPath: lib.ADMIN_PATH,
                apiPath: lib.API_PREFIX,
                passwordSet: users.passwordSet(),
                tokenCount: users.tokenCount(),
                accountCount: users.users.length,
                defaultAccount: lib.DEFAULT_ACCOUNT_NAME,
                authRequired: true
            });
            return;
        }

        if (pathname === '/' || pathname === '/index.html') {
            const entry = assets.readWebEntry();
            sendRaw(res, entry.ok ? 200 : 503, Buffer.from(entry.html, 'utf8'),
                'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
            return;
        }

        if (pathname === '/node_modules/material-symbols/material-symbols-rounded.woff2'
            || pathname === '/node_modules/material-symbols/rounded.css') {
            const target = assets.resolveAsset(pathname);
            sendStaticAsset(res, assets.webBase(), target ? path.relative(assets.webBase(), target) : '');
            return;
        }

        if (pathname.startsWith('/src/main/')) {
            const target = assets.resolveAsset(pathname);
            sendStaticAsset(res, assets.webBase(), target ? path.relative(assets.webBase(), target) : '');
            return;
        }

        if (pathname.startsWith('/styles/') || pathname.startsWith('/scripts/') || pathname.startsWith('/fonts/')
            || pathname === '/boot.js' || pathname === '/window_appearance.js' || pathname === '/web_host.js'
            || pathname === '/sw.js') {
            const target = assets.resolveAsset(pathname);
            sendStaticAsset(res, assets.rendererDir(), target ? path.relative(assets.rendererDir(), target) : '');
            return;
        }

        if (pathname.startsWith(`${lib.API_PREFIX}/`)) {
            handleAdminGet(req, res, pathname, query);
            return;
        }

        if (pathname === lib.ADMIN_PATH || pathname.startsWith(`${lib.ADMIN_PATH}/`)) {
            const rest = pathname.slice(lib.ADMIN_PATH.length);
            if (rest === '' || rest === '/' || rest === `/${assets.ENTRY_NAME}` || rest === '/index.html') {
                sendRaw(res, 200, Buffer.from(assets.readManagerEntry(), 'utf8'),
                    'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
                return;
            }
            if (ADMIN_ASSET_PATHS.has(rest) || ADMIN_ASSET_PREFIXES.some((prefix) => rest.startsWith(prefix))) {
                sendStaticAsset(res, assets.managerDir(), rest);
                return;
            }
            sendJson(res, 404, { ok: false, error: '找不到文件' });
            return;
        }

        const auth = authorizeApi(req);
        if (!auth.record) {
            sendJson(res, 401, { ok: false, error: auth.error });
            return;
        }

        const journal = users.journal(auth.record.userId);

        if (pathname === `${lib.SYNC_PATH}/ops`) {
            const since = lib.clampInt(query.get('since'), 0, 0, Number.MAX_SAFE_INTEGER);
            const limit = lib.clampInt(query.get('limit'), lib.DEFAULT_PAGE_LIMIT, 1, lib.MAX_PAGE_LIMIT);
            const ops = journal.readOps(since, limit);
            sendJson(res, 200, {
                ok: true,
                latestSeq: journal.latestSeq,
                ops,
                hasMore: ops.length > 0 && ops[ops.length - 1].seq < journal.latestSeq
            });
            return;
        }

        if (pathname === `${lib.SYNC_PATH}/ids`) {
            const limit = lib.clampInt(query.get('limit'), lib.RECYCLE_POOL_LIMIT, 1, lib.RECYCLE_POOL_LIMIT);
            const pool = journal.recyclable(limit);
            sendJson(res, 200, { ok: true, count: pool.length, ids: pool });
            return;
        }

        if (pathname === `${lib.SYNC_PATH}/state`) {
            sendJson(res, 200, { ok: true, journalId: journal.journalId, ...journal.state() });
            return;
        }

        if (pathname === `${lib.SYNC_PATH}/file`) {
            const target = lib.normalizeRelativePath(query.get('path'));
            if (!target) {
                sendJson(res, 400, { ok: false, error: '路径不合法' });
                return;
            }
            const entry = journal.readFile(target);
            if (!entry) {
                sendJson(res, 404, { ok: false, error: '没有该文件（可能已被删除）' });
                return;
            }
            sendJson(res, 200, {
                ok: true,
                path: target,
                hash: entry.hash || '',
                encoding: entry.encoding || 'utf8',
                data: entry.data || '',
                seq: entry.seq || 0
            });
            return;
        }

        if (pathname.startsWith(`${lib.SYNC_PATH}/shares`)) {
            sendJson(res, 501, { ok: false, error: '团队笔记（共享）尚未移植到 JS 版服务端' });
            return;
        }

        sendJson(res, 404, { ok: false, error: '未知接口' });
    }

    function handlePost(req, res, url, body) {
        const pathname = url.pathname;
        const payload = readJsonBody(req, body);

        if (pathname.startsWith(`${lib.API_PREFIX}/`)) {
            handleAdminPost(req, res, pathname, payload, body);
            return;
        }

        const auth = authorizeApi(req);
        if (!auth.record) {
            sendJson(res, 401, { ok: false, error: auth.error });
            return;
        }

        const journal = users.journal(auth.record.userId);

        if (pathname === `${lib.SYNC_PATH}/ops`) {
            if (!payload || !Array.isArray(payload.ops)) {
                sendJson(res, 400, { ok: false, error: '请求体需要 {device, ops:[...]}' });
                return;
            }
            if (!payload.ops.length) {
                sendJson(res, 200, { ok: true, latestSeq: journal.latestSeq, accepted: [] });
                return;
            }

            const boundDevice = String(auth.record.device || '');
            const device = boundDevice || String(payload.device || '');
            const own = [];
            const accepted = [];

            for (const raw of payload.ops) {
                if (!raw || typeof raw !== 'object') {
                    accepted.push({ opId: '', seq: 0, error: '操作格式不正确' });
                    continue;
                }
                const item = boundDevice ? { ...raw, device: undefined } : { ...raw };
                if (boundDevice) delete item.device;
                const shared = lib.SHARED_PATH_PATTERN.exec(lib.normalizeRelativePath(item.path));
                if (shared) {
                    accepted.push({
                        opId: String(item.opId || ''),
                        seq: 0,
                        error: '这条共享笔记不存在或已被撤销，请在设置里刷新「团队笔记」'
                    });
                    continue;
                }
                own.push(item);
            }

            if (own.length) accepted.push(...journal.appendMany(device, own));

            if (auth.record.tokenRecord != null) {
                users.noteTokenUse(auth.record.userId, auth.record.tokenRecord, String(payload.device || ''));
            }

            const deletedPaths = own.filter((item) => item.op === 'del').map((item) => item.path);
            if (deletedPaths.length) {
                const compacted = journal.compact(deletedPaths);
                if (compacted.removed) {
                    lib.log('INFO', 'Journal', `彻底删除后整理日志: 抹掉 ${compacted.removed} 行，保留 ${compacted.kept} 行 (account=${auth.record.userId})`);
                }
            }

            const rejected = accepted.filter((item) => item.error);
            sendJson(res, 200, {
                ok: rejected.length === 0,
                error: rejected.length ? rejected[0].error : '',
                latestSeq: journal.latestSeq,
                accepted
            });
            return;
        }

        if (pathname === `${lib.SYNC_PATH}/ids/claim`) {
            const source = payload && typeof payload === 'object' ? payload : {};
            const kind = source.kind === 'notes' || source.kind === 'todos' ? source.kind : '';
            const count = lib.clampInt(source.count, 1, 1, lib.RECYCLE_CLAIM_MAX);
            const since = source.since === undefined || source.since === null
                ? null
                : lib.clampInt(source.since, 0, 0, Number.MAX_SAFE_INTEGER);
            const device = String(source.device || auth.record.device || '');
            const claimed = journal.claimRecyclable(device, kind, count, since);
            sendJson(res, 200, {
                ok: true,
                count: claimed.picked.length,
                pending: claimed.pending,
                ids: claimed.picked
            });
            return;
        }

        if (pathname.startsWith(`${lib.SYNC_PATH}/shares`)) {
            sendJson(res, 501, { ok: false, error: '团队笔记（共享）尚未移植到 JS 版服务端' });
            return;
        }

        sendJson(res, 404, { ok: false, error: '未知接口' });
    }

    return function handler(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const query = url.searchParams;
        const chunks = [];
        let size = 0;

        const origin = String(req.headers.origin || '');
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        if (origin) res.setHeader('Access-Control-Max-Age', '600');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > lib.MAX_BODY_BYTES) {
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            const body = Buffer.concat(chunks);
            try {
                if (req.method === 'GET' || req.method === 'HEAD') {
                    handleGet(req, res, url, query);
                    return;
                }
                if (req.method === 'POST') {
                    handlePost(req, res, url, body);
                    return;
                }
                sendJson(res, 405, { ok: false, error: `方法不支持 (method=${req.method})` });
            } catch (error) {
                lib.log('ERROR', 'HTTP', `处理请求失败: ${error.message} (path=${url.pathname})`);
                if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务端处理失败' });
                else res.end();
            }
        });

        req.on('error', () => {
            if (!res.headersSent) sendJson(res, 400, { ok: false, error: '请求读取失败' });
        });
    };
}

function readConfig(dataDir) {
    const configPath = path.join(dataDir, lib.CONFIG_NAME);
    const data = lib.readJsonFile(configPath);
    if (!data || typeof data !== 'object') return { host: '', port: 0, path: configPath };
    const port = Number.parseInt(data.port, 10);
    return {
        host: typeof data.host === 'string' ? data.host : '',
        port: Number.isFinite(port) ? port : 0,
        path: configPath
    };
}

function parseArgs(argv) {
    const options = { host: '', port: 0, data: './data', token: process.env.ESPRIN_TOKEN || '', webDir: '', selftest: false };
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        const next = () => {
            index += 1;
            return argv[index] || '';
        };
        if (item === '--host' || item === '-h') options.host = next();
        else if (item === '--port' || item === '-p') options.port = Number.parseInt(next(), 10) || 0;
        else if (item === '--data' || item === '-d') options.data = next();
        else if (item === '--token') options.token = next();
        else if (item === '--web-dir') options.webDir = next();
        else if (item === '--selftest') options.selftest = true;
        else if (item === '--help') options.help = true;
    }
    return options;
}

function startServer({ host, port, dataDir, token }) {
    const users = new UserStore(dataDir);
    const server = http.createServer(createRequestHandler(users, token));
    return new Promise((resolve, reject) => {
        server.once('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                reject(new Error(`端口已被占用 (host=${host} port=${port})：先结束占用该端口的进程，或改用 --port`));
                return;
            }
            reject(error);
        });
        server.listen(port, host, () => resolve({ server, users }));
    });
}

async function selftest() {
    const os = require('os');
    const crypto = require('crypto');
    const dir = path.join(os.tmpdir(), `esprin-sync-selftest-${crypto.randomBytes(4).toString('hex')}`);
    lib.ensureDir(dir);
    const checks = [];
    const check = (name, ok, detail = '') => {
        checks.push({ name, ok, detail });
        lib.log(ok ? 'INFO' : 'ERROR', 'Selftest', `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    };

    const token = `esn_${crypto.randomBytes(12).toString('hex')}`;
    const started = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    const port = started.server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const call = async (method, target, body, useToken = true) => {
        const headers = { 'Content-Type': 'application/json' };
        if (useToken) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base}${target}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (error) {
            json = null;
        }
        return { status: response.status, json, text };
    };

    try {
        const health = await call('GET', '/health', undefined, false);
        check('GET /health 返回服务信息', health.status === 200 && health.json && health.json.name === lib.SERVER_NAME);

        const page = await call('GET', '/', undefined, false);
        check('GET / 返回网页端页面', page.status === 200 && page.text.includes('<!DOCTYPE html>'), `status=${page.status}`);

        const unauthorized = await call('GET', '/sync/state', undefined, false);
        check('无凭据访问 /sync/state 返回 401', unauthorized.status === 401);

        const put = await call('POST', '/sync/ops', {
            device: 'selftest',
            ops: [{ opId: 'op-1', op: 'put', path: 'notes/abcdefghij.md', data: 'hello', encoding: 'utf8' }]
        });
        check('POST /sync/ops 受理 put', put.status === 200 && put.json && put.json.accepted[0].seq === 1, JSON.stringify(put.json));

        const again = await call('POST', '/sync/ops', {
            device: 'selftest',
            ops: [{ opId: 'op-1', op: 'put', path: 'notes/abcdefghij.md', data: 'hello', encoding: 'utf8' }]
        });
        check('重复 opId 返回 duplicate', again.json && again.json.accepted[0].duplicate === true);

        const state = await call('GET', '/sync/state');
        check('GET /sync/state 反映最新序号', state.json && state.json.latestSeq === 1);
        check('GET /sync/state 记录文件哈希', state.json && Boolean(state.json.files['notes/abcdefghij.md']));

        const ops = await call('GET', '/sync/ops?since=0&limit=10');
        check('GET /sync/ops 能拉回操作', ops.json && ops.json.ops.length === 1 && ops.json.ops[0].path === 'notes/abcdefghij.md');

        const file = await call('GET', '/sync/file?path=notes/abcdefghij.md');
        check('GET /sync/file 返回内容', file.json && file.json.data === 'hello');

        const del = await call('POST', '/sync/ops', {
            device: 'selftest',
            ops: [{ opId: 'op-2', op: 'del', path: 'notes/abcdefghij.md' }]
        });
        check('POST /sync/ops 受理 del', del.json && del.json.ok === true);

        const ids = await call('GET', '/sync/ids?limit=10');
        check('GET /sync/ids 回收池有该 ID', ids.json && ids.json.count === 1 && ids.json.ids[0].id === 'abcdefghij');

        const claim = await call('POST', '/sync/ids/claim', { device: 'selftest', kind: 'notes', count: 1, since: 999 });
        check('POST /sync/ids/claim 领取该 ID', claim.json && claim.json.count === 1 && claim.json.ids[0].id === 'abcdefghij');

        const badPath = await call('POST', '/sync/ops', {
            device: 'selftest',
            ops: [{ opId: 'op-3', op: 'put', path: '../escape.md', data: 'x' }]
        });
        check('非法路径被拒', badPath.json && badPath.json.accepted[0].error === '路径不合法');

        const admin = await call('GET', '/admin/api/status', undefined, false);
        check('GET /admin/api/status 可用', admin.status === 200 && admin.json && admin.json.passwordSet === false);

        const setup = await call('POST', '/admin/api/setup-password', { password: 'selftest123' }, false);
        check('POST /admin/api/setup-password 设置管理密码', setup.status === 200);

        const login = await call('POST', '/admin/api/login', { name: 'admin', password: 'selftest123', requireAdmin: true }, false);
        check('POST /admin/api/login 登录成功', login.status === 200 && login.json.user.admin === true);

        const badLogin = await call('POST', '/admin/api/login', { name: 'admin', password: 'wrong-password' }, false);
        check('错误密码被拒', badLogin.status === 401);
    } catch (error) {
        check('自测执行', false, error.message);
    } finally {
        started.server.close();
        lib.removeTree(dir);
    }

    const failed = checks.filter((item) => !item.ok);
    lib.log(failed.length ? 'ERROR' : 'INFO', 'Selftest', `结果: 通过 ${checks.length - failed.length}/${checks.length}`);
    return failed.length ? 1 : 0;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        process.stdout.write([
            'EsprinSync 同步服务端（操作日志）',
            '  --host <addr>    监听地址，默认取 config.json 的 host，再不行 127.0.0.1（局域网共享可写 0.0.0.0）',
            '  --port <port>    监听端口，默认取 config.json 的 port，再不行 8686',
            '  --data <dir>     数据目录：账户表与各账户的日志、令牌都在这里（默认 ./data）',
            '  --token <token>  访问令牌，等同内置账户的一份令牌（也可用环境变量 ESPRIN_TOKEN）',
            '  --web-dir <dir>  网页端所在目录（含 src/renderer），默认自动查找仓库根或服务端同级的 web/',
            '  --selftest       跑一遍内置自测后退出',
            ''
        ].join('\n'));
        return 0;
    }

    if (options.selftest) return selftest();

    const dataDir = path.resolve(options.data);
    lib.ensureDir(dataDir);

    if (options.webDir) assets.setWebBase(options.webDir);
    else assets.setWebBase(assets.detectWebBase(__dirname));

    const config = readConfig(dataDir);
    const host = options.host || config.host || lib.DEFAULT_HOST;
    const port = options.port || config.port || lib.DEFAULT_PORT;
    const hostSource = options.host ? '--host' : config.host ? 'config' : 'default';
    const portSource = options.port ? '--port' : config.port ? 'config' : 'default';

    let started = null;
    try {
        started = await startServer({ host, port, dataDir, token: options.token });
    } catch (error) {
        lib.log('ERROR', 'Server', `启动失败: ${error.message}`);
        return 1;
    }

    const { server, users } = started;
    const journal = users.journal(lib.DEFAULT_ACCOUNT_ID);
    const address = server.address();
    const boundPort = address.port;
    const urlHost = address.address === '0.0.0.0' || address.address === '::' || !address.address
        ? lib.lanAddress() || lib.DEFAULT_HOST
        : address.address;
    const web = assets.webClientSummary();

    lib.log('INFO', 'Server', `启动 ${lib.SERVER_NAME} v${lib.SERVER_VERSION}`);
    lib.log('INFO', 'Server', `dataDir=${dataDir} config=${config.path} configFound=${fs.existsSync(config.path)}`);
    lib.log('INFO', 'Server', `listen=${address.address}:${boundPort} hostSource=${hostSource} portSource=${portSource}`);
    lib.log('INFO', 'Sync', `endpoint=${lib.SYNC_PATH}/* origin=http://${urlHost}:${boundPort}`);
    lib.log('INFO', 'Storage', `journal=${journal.path} journalId=${journal.journalId} ops=${journal.count} latestSeq=${journal.latestSeq}`);
    lib.log('INFO', 'Web', `endpoint=/ dir=${web.base} entry=${assets.entryPath()} version=${web.version || '-'} missing=${web.missing.join(',') || '-'}`);
    lib.log('INFO', 'Admin', `endpoint=${lib.ADMIN_PATH} api=${lib.API_PREFIX} passwordSet=${users.passwordSet()}`);
    lib.log('INFO', 'Auth', `tokenSource=${options.token ? '--token' : 'accounts'} accountCount=${users.users.length} tokenCount=${users.tokenCount()}`);
    if (!users.passwordSet() && !users.tokenCount() && !options.token) {
        lib.log('WARN', 'Auth', `未配置任何凭据：同步接口一律返回 401 (action=打开 ${lib.ADMIN_PATH} 设置管理密码或创建访问令牌)`);
    }

    const shutdown = () => {
        lib.log('INFO', 'Server', '已停止');
        server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return new Promise((resolve) => {
        server.on('close', () => resolve(0));
    });
}

if (require.main === module) {
    main().then((code) => {
        if (code) process.exitCode = code;
    });
}

module.exports = { createRequestHandler, startServer, main, selftest, parseArgs, readConfig };
