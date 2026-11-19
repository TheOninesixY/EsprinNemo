#!/usr/bin/env node

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const MODULE = 'WebsiteServe';
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, '.github', 'pages');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ttf': 'font/ttf',
    '.woff2': 'font/woff2'
};

function readOption(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function log(level, message) {
    const line = `[${level}] [${MODULE}] ${message}`;
    if (level === 'ERROR' || level === 'WARN') console.error(line);
    else console.log(line);
}

function resolveTarget(pathname) {
    let decoded = '/';
    try {
        decoded = decodeURIComponent(pathname);
    } catch (error) {
        return null;
    }
    if (decoded === '/' || decoded === '') decoded = '/index.html';
    if (decoded.includes('..') || decoded.includes('\0')) return null;
    const target = path.resolve(SITE, `.${decoded}`);
    if (target !== SITE && !target.startsWith(SITE + path.sep)) return null;
    return target;
}

const host = readOption('host', '127.0.0.1');
const port = Number.parseInt(readOption('port', '8080'), 10) || 8080;

if (!fs.existsSync(path.join(SITE, 'index.html'))) {
    log('ERROR', `缺少站点入口 (path=${path.join(SITE, 'index.html')})`);
    process.exit(1);
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

        res.writeHead(200, {
            'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
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
    log('INFO', `官网预览地址: http://${host}:${port}/`);
    log('INFO', `站点目录: ${path.relative(ROOT, SITE)}`);
});

server.on('error', (error) => {
    log('ERROR', `启动失败: ${error.message}`);
    process.exitCode = 1;
});
