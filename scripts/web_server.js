#!/usr/bin/env node

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MODULE = 'WebServer';
const WEB_ROOT = path.resolve(__dirname, '..');
const ENTRY_PATH = '/src/renderer/main.html';
const STATIC_ALIASES = { '/sw.js': '/src/renderer/sw.js' };
const BLOCKED_PREFIXES = ['/data/', '/.git/'];
const DEFAULT_PORT = 4569;
const DEFAULT_HOST = '127.0.0.1';
const PROXY_PREFIXES = ['/sync', '/health', '/admin'];
const HTML_FALLBACK_EXTENSIONS = new Set(['', '.html', '.htm']);

const OPTION_FLAGS = {
    port: ['--port', '-p'],
    host: ['--host', '-h'],
    upstream: ['--upstream']
};

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8'
};

function readOption(name, fallback) {
    const flags = OPTION_FLAGS[name] || [`--${name}`];
    for (const flag of flags) {
        const index = process.argv.indexOf(flag);
        const inline = process.argv.find((item) => item.startsWith(`${flag}=`));
        const value = index !== -1 ? process.argv[index + 1] : (inline ? inline.slice(flag.length + 1) : '');
        if (value && !value.startsWith('-')) return value;
    }
    const fromEnv = process.env[name.toUpperCase().replace(/-/g, '_')];
    if (fromEnv) return fromEnv;
    return fallback;
}

function resolvePort() {
    const raw = readOption('port', process.env.PORT || DEFAULT_PORT);
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`端口无效 (port=${raw})`);
    }
    return port;
}

function resolveUpstream() {
    const raw = String(readOption('upstream', process.env.ESPRIN_SYNC_UPSTREAM || '')).trim();
    if (!raw) return '';
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return parsed.origin;
}

function contentTypeOf(filePath) {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function proxied(pathname) {
    return PROXY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function proxyRequest(upstream, req, res, requestUrl) {
    const target = new URL(requestUrl.pathname + requestUrl.search, upstream);
    const client = target.protocol === 'https:' ? https : http;
    const proxyReq = client.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: target.host }
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (error) => {
        console.warn(`[WARN] [${MODULE}] 上游转发失败 (upstream=${upstream} path=${requestUrl.pathname} detail=${error.message})`);
        if (res.headersSent) {
            res.destroy();
            return;
        }
        sendJson(res, 502, { error: `同步服务端不可达 (upstream=${upstream})` });
    });

    req.pipe(proxyReq);
}

function resolveSafePath(pathname) {
    if (BLOCKED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return '';
    const decoded = decodeURIComponent(pathname);
    const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    const target = path.join(WEB_ROOT, normalized);
    if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + path.sep)) return '';
    return target;
}

function shouldFallbackToIndex(pathname) {
    return HTML_FALLBACK_EXTENSIONS.has(path.extname(pathname).toLowerCase());
}

function readAppVersion() {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'package.json'), 'utf8'));
        return typeof parsed.version === 'string' ? parsed.version : '';
    } catch (error) {
        return '';
    }
}

function readReleaseNotes() {
    try {
        return fs.readFileSync(path.join(WEB_ROOT, '.github', 'releases.md'), 'utf8').trim();
    } catch (error) {
        return '';
    }
}

function faviconTag() {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'package.json'), 'utf8'));
        const relative = typeof parsed.svg_icon === 'string' && parsed.svg_icon ? parsed.svg_icon : parsed.icon;
        if (!relative) return '';
        const target = path.join(WEB_ROOT, relative);
        const mime = MIME_TYPES[path.extname(target).toLowerCase()] || 'image/png';
        return `<link rel="icon" type="${mime}" href="data:${mime};base64,${fs.readFileSync(target).toString('base64')}">`;
    } catch (error) {
        return '';
    }
}

function injectVersion(html) {
    const payload = { version: readAppVersion(), notes: readReleaseNotes() };
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    const tag = `<script>window.__esprinVersion=${JSON.stringify(payload.version)};window.__esprinReleaseNotes=${json};</script>\n`;
    const withGlobals = html.replace(/<script\b/i, `${tag}$&`);
    const icon = faviconTag();
    return icon ? withGlobals.replace(/<\/head>/i, `${icon}\n</head>`) : withGlobals;
}

function serveFile(filePath, res, options = {}) {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return false;

    const headers = {
        'Content-Type': contentTypeOf(filePath),
        'Cache-Control': 'no-cache, no-store, must-revalidate'
    };

    if (options.injectVersion) {
        const html = injectVersion(fs.readFileSync(filePath, 'utf8'));
        headers['Content-Length'] = Buffer.byteLength(html);
        res.writeHead(200, headers);
        res.end(html);
        return true;
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
    return true;
}

function redirect(res, location) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
}

function serveStatic(pathname, res) {
    if (pathname === '/') {
        redirect(res, ENTRY_PATH);
        return;
    }

    const alias = STATIC_ALIASES[pathname];
    const target = alias ? path.join(WEB_ROOT, alias) : resolveSafePath(pathname);
    if (!target) {
        sendJson(res, 400, { error: '路径非法' });
        return;
    }

    const entryFile = path.join(WEB_ROOT, ENTRY_PATH);

    try {
        if (fs.existsSync(target) && serveFile(target, res, { injectVersion: target === entryFile })) return;
    } catch (error) {
        console.warn(`[WARN] [${MODULE}] 读取失败 (path=${pathname} detail=${error.message})`);
    }

    if (shouldFallbackToIndex(pathname)) {
        try {
            if (serveFile(entryFile, res, { injectVersion: true })) return;
        } catch (error) {
            console.warn(`[WARN] [${MODULE}] 入口页回退失败 (detail=${error.message})`);
        }
    }

    sendJson(res, 404, { error: `资源不存在 (path=${pathname})` });
}

function createServer(upstream) {
    return http.createServer((req, res) => {
        const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (proxied(requestUrl.pathname)) {
            if (!upstream) {
                sendJson(res, 404, { error: `未配置同步上游 (path=${requestUrl.pathname})` });
                return;
            }
            proxyRequest(upstream, req, res, requestUrl);
            return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: `方法不支持 (method=${req.method})` });
            return;
        }

        serveStatic(requestUrl.pathname, res);
    });
}

function main() {
    if (!fs.existsSync(path.join(WEB_ROOT, ENTRY_PATH))) {
        console.error(`[ERROR] [${MODULE}] 缺少入口文件 (path=${path.join(WEB_ROOT, ENTRY_PATH)})`);
        process.exitCode = 1;
        return;
    }

    let port;
    let upstream;
    try {
        port = resolvePort();
        upstream = resolveUpstream();
    } catch (error) {
        console.error(`[ERROR] [${MODULE}] 参数无效 (detail=${error.message})`);
        process.exitCode = 1;
        return;
    }

    const host = readOption('host', process.env.HOST || DEFAULT_HOST);
    const server = createServer(upstream);

    server.on('error', (error) => {
        if (error && error.code === 'EADDRINUSE') {
            console.error(`[ERROR] [${MODULE}] 端口已被占用 (host=${host} port=${port})：另一个开发服务器仍在运行，先结束该进程或改用 --port`);
            process.exitCode = 1;
            return;
        }
        console.error(`[ERROR] [${MODULE}] 启动失败 (host=${host} port=${port} detail=${error.message})`);
        process.exitCode = 1;
    });

    server.listen(port, host, () => {
        console.log(`[INFO] [${MODULE}] 监听 http://${host}:${port}${ENTRY_PATH} (root=${path.relative(process.cwd(), WEB_ROOT)})`);
        console.log(`[INFO] [${MODULE}] 同步接口转发 ${upstream ? `-> ${upstream}` : '未启用 (ESPRIN_SYNC_UPSTREAM)'}`);
    });

    const shutdown = () => {
        server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main();
