'use strict';

const fs = require('fs');
const path = require('path');

const { log } = require('./lib.js');

const INDEX_NAME = 'index.html';
const RENDERER_REL = path.join('src', 'renderer');
const ENTRY_NAME = 'main.html';
const RENDERER_FILES = new Set(['boot.js', 'window_appearance.js', 'web_host.js', 'sw.js']);
const RENDERER_PREFIXES = ['styles/', 'scripts/', 'fonts/'];
const NODE_PREFIX = 'node_modules/material-symbols/';
const MAIN_SOURCE_FILES = ['src/main/data_path.js', 'src/main/secret_store.js', 'src/main/sync_server.js'];

let webBase = path.resolve(__dirname, '..', '..');
let embedded = null;
const SELF_ROOT = path.resolve(__dirname, '..', '..');

function embeddedKey(from, target) {
    return path.relative(from, target).split(path.sep).join('/');
}

function detectWebBase(serverDir) {
    const candidates = [
        process.env.ESPRIN_WEB_DIR,
        path.join(serverDir, 'web'),
        path.resolve(__dirname, '..', '..')
    ];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const resolved = path.resolve(candidate);
        const entry = path.join(resolved, RENDERER_REL, ENTRY_NAME);
        if (fs.existsSync(entry) || (embedded && embedded.get(embeddedKey(resolved, entry)) !== undefined)) return resolved;
    }
    return path.resolve(__dirname, '..', '..');
}

function setWebBase(dir) {
    webBase = path.resolve(dir);
}

function setEmbeddedAssets(map) {
    embedded = map instanceof Map ? map : new Map(Object.entries(map || {}));
}

function rendererDir() {
    return path.join(webBase, RENDERER_REL);
}

function entryPath() {
    return path.join(rendererDir(), ENTRY_NAME);
}

function readFileOrEmbedded(target) {
    try {
        return fs.readFileSync(target);
    } catch (error) {
        if (!embedded) return null;
        const candidates = [target, embeddedKey(webBase, target), embeddedKey(SELF_ROOT, target)];
        for (const candidate of candidates) {
            const value = embedded.get(candidate);
            if (value === undefined) continue;
            return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
        }
        return null;
    }
}

function resolveAsset(urlPath) {
    const relative = String(urlPath || '').replace(/^\/+/, '');
    if (!relative || relative.includes('..')) return '';
    if (RENDERER_FILES.has(relative) || RENDERER_PREFIXES.some((prefix) => relative.startsWith(prefix))) {
        return path.join(rendererDir(), relative);
    }
    if (MAIN_SOURCE_FILES.includes(relative)) return path.join(webBase, relative);
    if (relative.startsWith(NODE_PREFIX)) return path.join(webBase, relative);
    return '';
}

function readPackageMeta() {
    const data = (() => {
        const body = readFileOrEmbedded(path.join(webBase, 'package.json'));
        if (!body) return null;
        try {
            return JSON.parse(body.toString('utf8'));
        } catch (error) {
            return null;
        }
    })();
    if (!data) return {};
    const icon = typeof data.svg_icon === 'string' && data.svg_icon ? data.svg_icon : data.icon;
    return {
        version: typeof data.version === 'string' ? data.version : '',
        icon: typeof icon === 'string' ? icon : '',
        repoUrl: typeof data.repository === 'object' && data.repository ? String(data.repository.url || '') : ''
    };
}

function readReleaseNotes() {
    const body = readFileOrEmbedded(path.join(webBase, '.github', 'releases.md'));
    return body ? body.toString('utf8').trim() : '';
}

function buildInjection() {
    const meta = readPackageMeta();
    const payload = { version: meta.version, notes: readReleaseNotes() };
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    return `<script>window.__esprinVersion=${JSON.stringify(meta.version)};window.__esprinReleaseNotes=${json};</script>\n`;
}

function faviconTag() {
    const meta = readPackageMeta();
    if (!meta.icon) return '';
    const target = path.join(webBase, meta.icon);
    const body = readFileOrEmbedded(target);
    if (!body) return '';
    const extension = path.extname(target).toLowerCase();
    const mime = extension === '.svg' ? 'image/svg+xml' : extension === '.png' ? 'image/png' : 'image/x-icon';
    return `<link rel="icon" type="${mime}" href="data:${mime};base64,${body.toString('base64')}">`;
}

function readWebEntry() {
    const body = readFileOrEmbedded(entryPath());
    if (!body) {
        return {
            ok: false,
            html: `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>缺少网页端</title></head>
<body style="font:14px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;padding:40px;background:#0d1117;color:#f0f6fc">
<h1 style="font-size:18px;margin-bottom:12px">找不到网页端的页面文件</h1>
<p style="color:#8b949e">服务端读取入口页面的位置：</p>
<p><code style="background:#21262d;padding:6px 10px;border-radius:6px;display:inline-block">${entryPath()}</code></p>
<p style="color:#8b949e">把 Nemo 仓库的 src/renderer 放进来（或打包时随产物一起分发），也可以启动时用 --web-dir 指定</p>
</body></html>`
        };
    }

    let html = body.toString('utf8');
    const tag = buildInjection();
    html = html.replace(/<script\b/i, `${tag}$&`);
    const icon = faviconTag();
    if (icon) html = html.replace(/<\/head>/i, `${icon}\n</head>`);
    return { ok: true, html };
}

function webClientReady() {
    return readFileOrEmbedded(entryPath()) !== null;
}

function webClientSummary() {
    const meta = readPackageMeta();
    const missing = [];
    for (const relative of [ENTRY_NAME, 'styles/tokens.css', 'scripts/app.js', 'web_host.js']) {
        if (!readFileOrEmbedded(path.join(rendererDir(), relative))) missing.push(relative);
    }
    const font = readFileOrEmbedded(path.join(webBase, 'node_modules', 'material-symbols', 'material-symbols-rounded.woff2'));
    if (!font) missing.push('node_modules/material-symbols/material-symbols-rounded.woff2');
    return { version: meta.version, base: webBase, missing };
}

function managerDir() {
    return path.join(__dirname, 'manager');
}

function readManagerEntry() {
    const target = path.join(managerDir(), INDEX_NAME);
    const body = readFileOrEmbedded(target);
    if (body) return body.toString('utf8');
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>缺少管理页面</title></head>
<body style="font:14px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;padding:40px;background:#0d1117;color:#f0f6fc">
<h1 style="font-size:18px;margin-bottom:12px">找不到管理后台的页面文件</h1>
<p><code style="background:#21262d;padding:6px 10px;border-radius:6px;display:inline-block">${target}</code></p>
</body></html>`;
}

function readAsset(target) {
    return readFileOrEmbedded(target);
}

module.exports = {
    ENTRY_NAME,
    detectWebBase,
    setWebBase,
    setEmbeddedAssets,
    webBase: () => webBase,
    rendererDir,
    entryPath,
    resolveAsset,
    readWebEntry,
    webClientReady,
    webClientSummary,
    managerDir,
    readManagerEntry,
    readAsset
};
