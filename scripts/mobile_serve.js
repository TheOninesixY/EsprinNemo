'use strict';

// 移动端本地预览服务器（仅开发用）。
// 把 src/mobile 当作文档根目录对外提供，模拟 WebView / 手机浏览器加载同一套静态文件。
//   bun scripts/mobile_serve.js [--port 8899] [--host 127.0.0.1]

const fs = require('fs');
const http = require('http');
const path = require('path');

const MODULE = 'MobileServe';
const ROOT = path.resolve(__dirname, '..', 'src', 'mobile');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
};

const ROOT_DIR = path.resolve(__dirname, '..');

function readOption(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

const host = readOption('host', '127.0.0.1');
const port = Number.parseInt(readOption('port', '8899'), 10) || 8899;

function resolveTarget(pathname) {
    let decoded = '/';
    try {
        decoded = decodeURIComponent(pathname);
    } catch (error) {
        return null;
    }
    if (decoded === '/' || decoded === '') decoded = '/index.html';

    if (decoded.startsWith('/node_modules/material-symbols/')) {
        const target = path.resolve(ROOT_DIR, `.${decoded}`);
        const base = path.join(ROOT_DIR, 'node_modules', 'material-symbols');
        if (target !== base && !target.startsWith(base + path.sep)) return null;
        return target;
    }

    if (decoded.startsWith('/assets/')) {
        const target = path.resolve(ROOT_DIR, `.${decoded}`);
        const base = path.join(ROOT_DIR, 'assets');
        if (target !== base && !target.startsWith(base + path.sep)) return null;
        return target;
    }

    const target = path.resolve(ROOT, `.${decoded}`);
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
    return target;
}

const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end('Method Not Allowed');
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const target = resolveTarget(url.pathname);

    if (!target) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    fs.stat(target, (error, stat) => {
        if (error || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }

        const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': stat.size,
            'Cache-Control': 'no-store'
        });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        fs.createReadStream(target).pipe(res);
    });
});

server.listen(port, host, () => {
    process.stdout.write(`[INFO] [${MODULE}] 移动端预览地址: http://${host}:${port}/\n`);
    process.stdout.write(`[INFO] [${MODULE}] 文档根目录: ${ROOT}\n`);
});

server.on('error', (error) => {
    process.stderr.write(`[ERROR] [${MODULE}] 启动失败: ${error.message}\n`);
    process.exitCode = 1;
});
