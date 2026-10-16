'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SERVER_NAME = 'EsprinSync';
const SERVER_VERSION = 1;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8686;

const CONFIG_NAME = 'config.json';
const JOURNAL_NAME = 'journal.log';
const JOURNAL_ID_NAME = 'journal.id';
const USERS_FILE_NAME = 'users.json';
const USERS_DIR_NAME = 'users';
const TOKENS_FILE_NAME = 'tokens.json';
const SHARES_FILE_NAME = 'shares.json';
const LEGACY_ADMIN_FILE_NAME = 'admin.json';

const DEFAULT_ACCOUNT_ID = 'admin';
const DEFAULT_ACCOUNT_NAME = 'admin';
const ACCOUNT_NAME_MAX = 32;
const RESERVED_DIR_NAMES = new Set(
    ['con', 'prn', 'aux', 'nul']
        .concat(Array.from({ length: 9 }, (_, index) => `com${index + 1}`))
        .concat(Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`))
);

const ADMIN_COOKIE_NAME = 'esprin_admin';
const SYNC_PATH = '/sync';
const ADMIN_PATH = '/admin';
const API_PREFIX = `${ADMIN_PATH}/api`;
const HEALTH_PATH = '/health';

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 60;
const LOGIN_MAX_FAILURES = 10;
const TOKEN_TOUCH_INTERVAL_SECONDS = 60;
const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 2000;
const MAX_DATA_CHARS = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const FORBIDDEN_PATH_PARTS = new Set(['..']);

const PBKDF2_ITERATIONS = 200000;
const PBKDF2_SALT_BYTES = 16;

const RECYCLE_HOLD_SECONDS = 15 * 60;
const RECYCLE_POOL_LIMIT = 500;
const RECYCLE_CLAIM_MAX = 8;

const SHARE_PREFIX = 'shared';
const SHARE_STATUS_PENDING = 'pending';
const SHARE_STATUS_ACCEPTED = 'accepted';

const ITEM_PATH_PATTERN = /^(notes|todos)\/([A-Za-z0-9_-]{1,64})\.md$/;
const SHARED_PATH_PATTERN = /^shared\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\.md$/;
const NOTE_META_OPEN = '<!--EsprinData';
const NOTE_TITLE_LINE_PATTERN = /^[ \t]*title:[ \t]*(.*)$/m;

const ASSET_CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8'
};

function nowMs() {
    return Date.now();
}

function pad(value) {
    return String(value).padStart(2, '0');
}

function journalDownloadName() {
    const now = new Date();
    return `esprin-journal-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
        + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.log`;
}

function sha256Text(text) {
    return `sha256:${crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

function log(level, component, message) {
    const line = `[${level}] [${component}] ${message}\n`;
    if (level === 'WARN' || level === 'ERROR') process.stderr.write(line);
    else process.stdout.write(line);
}

function normalizeRelativePath(value) {
    const text = String(value == null ? '' : value).trim().replace(/\\/g, '/');
    if (!text || text.startsWith('/')) return '';
    const parts = text.split('/').filter((part) => part !== '' && part !== '.');
    if (!parts.length || parts.some((part) => FORBIDDEN_PATH_PARTS.has(part))) return '';
    return parts.join('/');
}

function noteTitleFromData(data, encoding = 'utf8') {
    if (typeof data !== 'string' || encoding === 'base64') return '';
    const text = data.replace(/^\ufeff/, '');
    let body = text;
    if (text.startsWith(NOTE_META_OPEN)) {
        const cut = text.indexOf('-->');
        const block = cut === -1 ? text : text.slice(0, cut);
        body = cut === -1 ? '' : text.slice(cut + 3);
        const matched = NOTE_TITLE_LINE_PATTERN.exec(block);
        if (matched) {
            let raw = String(matched[1] || '').trim();
            if (raw.startsWith('"')) {
                try {
                    const parsed = JSON.parse(raw);
                    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim().slice(0, 60);
                } catch (error) {
                    raw = raw.replace(/^"+|"+$/g, '');
                }
            }
            if (raw) return raw.slice(0, 60);
        }
    }

    for (const line of body.split(/\r?\n/)) {
        let cleaned = line.trim().replace(/^#+/, '').trim();
        if (/^([-*+]>?)\s/.test(cleaned)) cleaned = cleaned.slice(2).trim();
        if (cleaned) return cleaned.slice(0, 60);
    }
    return '';
}

function clampInt(value, fallback, minimum, maximum) {
    const number = Number.parseInt(value, 10);
    const base = Number.isFinite(number) ? number : fallback;
    return Math.max(minimum, Math.min(base, maximum));
}

function hashPassword(password, iterations = PBKDF2_ITERATIONS, salt) {
    const useSalt = salt || crypto.randomBytes(PBKDF2_SALT_BYTES);
    const digest = crypto.pbkdf2Sync(String(password), useSalt, iterations, 32, 'sha256');
    return `pbkdf2_sha256$${iterations}$${useSalt.toString('hex')}$${digest.toString('hex')}`;
}

function verifyPassword(password, stored) {
    try {
        const parts = String(stored).split('$');
        if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
        const iterations = Number.parseInt(parts[1], 10);
        if (!Number.isFinite(iterations) || iterations <= 0) return false;
        const salt = Buffer.from(parts[2], 'hex');
        const expected = Buffer.from(parts[3], 'hex');
        const digest = crypto.pbkdf2Sync(String(password), salt, iterations, expected.length || 32, 'sha256');
        return digest.length === expected.length && crypto.timingSafeEqual(digest, expected);
    } catch (error) {
        return false;
    }
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function writeJsonAtomic(target, value) {
    try {
        const temp = `${target}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.renameSync(temp, target);
    } catch (error) {
        log('ERROR', 'Store', `写入失败: ${error.message} (path=${target})`);
    }
}

function readJsonFile(target) {
    try {
        return JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
        return null;
    }
}

function ensureDir(target) {
    try {
        fs.mkdirSync(target, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}

function removeTree(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
        log('ERROR', 'Store', `删除目录失败: ${error.message} (path=${target})`);
    }
}

function lanAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const item of interfaces[name] || []) {
            if (item.family === 'IPv4' && !item.internal) return item.address;
        }
    }
    return '';
}

module.exports = {
    SERVER_NAME,
    SERVER_VERSION,
    DEFAULT_HOST,
    DEFAULT_PORT,
    CONFIG_NAME,
    JOURNAL_NAME,
    JOURNAL_ID_NAME,
    USERS_FILE_NAME,
    USERS_DIR_NAME,
    TOKENS_FILE_NAME,
    SHARES_FILE_NAME,
    LEGACY_ADMIN_FILE_NAME,
    DEFAULT_ACCOUNT_ID,
    DEFAULT_ACCOUNT_NAME,
    ACCOUNT_NAME_MAX,
    RESERVED_DIR_NAMES,
    ADMIN_COOKIE_NAME,
    SYNC_PATH,
    ADMIN_PATH,
    API_PREFIX,
    HEALTH_PATH,
    SESSION_TTL_SECONDS,
    LOGIN_WINDOW_SECONDS,
    LOGIN_MAX_FAILURES,
    TOKEN_TOUCH_INTERVAL_SECONDS,
    MIN_PASSWORD_LENGTH,
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
    MAX_DATA_CHARS,
    MAX_BODY_BYTES,
    PBKDF2_ITERATIONS,
    PBKDF2_SALT_BYTES,
    RECYCLE_HOLD_SECONDS,
    RECYCLE_POOL_LIMIT,
    RECYCLE_CLAIM_MAX,
    SHARE_PREFIX,
    SHARE_STATUS_PENDING,
    SHARE_STATUS_ACCEPTED,
    ITEM_PATH_PATTERN,
    SHARED_PATH_PATTERN,
    NOTE_META_OPEN,
    ASSET_CONTENT_TYPES,
    nowMs,
    journalDownloadName,
    sha256Text,
    log,
    normalizeRelativePath,
    noteTitleFromData,
    clampInt,
    hashPassword,
    verifyPassword,
    safeEqual,
    writeJsonAtomic,
    readJsonFile,
    ensureDir,
    removeTree,
    lanAddress
};
