#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const MODULE = 'WebBuild';
const ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = ROOT;
const ENTRY = 'src/renderer/main.html';
const PACKAGE_FILE = path.join(ROOT, 'package.json');

function faviconFile() {
    try {
        const parsed = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
        const relative = typeof parsed.svg_icon === 'string' && parsed.svg_icon ? parsed.svg_icon : parsed.icon;
        return typeof relative === 'string' && relative ? path.join(ROOT, relative) : '';
    } catch (error) {
        return '';
    }
}

function defaultOutPath() {
    const version = readPackageVersion();
    return path.join(ROOT, 'dist', version ? `EsprinNemo.Web.v${version}.html` : 'EsprinNemo.Web.html');
}

const ASSET_MIME_TYPES = {
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const dataUriCache = new Map();
const stats = { styles: 0, scripts: 0, assets: 0 };

let entryDir = WEB_ROOT;
let lastAudit = null;

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function readOption(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function attributeOf(tag, name) {
    const matched = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return matched ? matched[1] : '';
}

function toDataUri(filePath) {
    const absolute = path.resolve(filePath);
    if (dataUriCache.has(absolute)) return dataUriCache.get(absolute);

    const mime = ASSET_MIME_TYPES[path.extname(absolute).toLowerCase()];
    if (!mime) throw new Error(`资源类型不支持内联 (path=${absolute})`);

    const uri = `data:${mime};base64,${fs.readFileSync(absolute).toString('base64')}`;
    dataUriCache.set(absolute, uri);
    stats.assets += 1;
    return uri;
}

function localTargetOf(reference, baseDir) {
    if (!reference || /^(data:|https?:|blob:|\/\/|#)/i.test(reference)) return '';
    const cleaned = decodeURIComponent(reference.split(/[?#]/)[0]);
    const absolute = path.resolve(baseDir, cleaned);
    if (!absolute.startsWith(WEB_ROOT + path.sep)) return '';
    return fs.existsSync(absolute) ? absolute : '';
}

function inlineCssUrls(css, cssDir) {
    return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (matched, quote, reference) => {
        const target = localTargetOf(reference.trim(), cssDir);
        if (!target) return matched;
        return `url("${toDataUri(target)}")`;
    });
}

function inlineStyles(html) {
    return html.replace(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi, (tag) => {
        const target = localTargetOf(attributeOf(tag, 'href'), entryDir);
        if (!target) return tag;
        const css = inlineCssUrls(fs.readFileSync(target, 'utf8'), path.dirname(target));
        stats.styles += 1;
        return `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`;
    });
}

function inlineScripts(html) {
    return html.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, _before, source) => {
        const target = localTargetOf(source, entryDir);
        if (!target) return tag;
        const code = fs.readFileSync(target, 'utf8');
        stats.scripts += 1;
        return `<script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`;
    });
}

function inlineIcons(html) {
    if (/<link\b[^>]*\brel\s*=\s*["']icon["']/i.test(html)) return html;
    const target = faviconFile();
    if (!target || !fs.existsSync(target)) return html;
    const mime = ASSET_MIME_TYPES[path.extname(target).toLowerCase()];
    const tag = `<link rel="icon" type="${mime}" href="${toDataUri(target)}">`;
    return html.replace(/<\/head>/i, `${tag}\n</head>`);
}

const RESOURCE_TAG_PATTERN = /<(?:link|script|img|iframe|embed|source|track|audio|video|object|use|input)\b[^>]*>/gi;
const URL_ATTRIBUTE_PATTERN = /\b(href|src|srcset|poster|xlink:href|data)\s*=\s*["']([^"']*)["']/gi;
const INLINE_REFERENCE_PATTERN = /^(?:data:|blob:|#)/i;
const SCRIPT_BLOCK_PATTERN = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_PATTERN = /<style\b[^>]*>[\s\S]*?<\/style>/gi;

function brief(value) {
    return String(value).replace(/\s+/g, ' ').slice(0, 48);
}

function collectMarkupReferences(markup) {
    const found = [];
    markup.replace(RESOURCE_TAG_PATTERN, (tag) => {
        const name = (tag.match(/^<([a-z]+)/i) || [])[1] || 'tag';
        URL_ATTRIBUTE_PATTERN.lastIndex = 0;
        let matched;
        while ((matched = URL_ATTRIBUTE_PATTERN.exec(tag))) {
            const value = matched[2].trim();
            if (!value || INLINE_REFERENCE_PATTERN.test(value)) continue;
            found.push(`<${name} ${matched[1]}="${brief(value)}">`);
        }
        return tag;
    });
    return found;
}

function collectStyleReferences(css) {
    const found = [];
    css.replace(/@import\s+[^;]+;/gi, (matched) => {
        found.push(brief(matched));
        return matched;
    });
    css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (matched, _quote, reference) => {
        if (!INLINE_REFERENCE_PATTERN.test(String(reference).trim())) found.push(`url(${brief(reference)})`);
        return matched;
    });
    return found;
}

function auditSelfContained(html) {
    const withoutScripts = html.replace(SCRIPT_BLOCK_PATTERN, '<script></script>');
    const styleBlocks = withoutScripts.match(STYLE_BLOCK_PATTERN) || [];
    const markup = withoutScripts.replace(STYLE_BLOCK_PATTERN, '<style></style>');

    const external = collectMarkupReferences(markup);
    styleBlocks.forEach((block) => external.push(...collectStyleReferences(block)));

    return {
        external,
        scriptTags: (html.match(/<script\b/gi) || []).length,
        pendingScripts: (withoutScripts.match(/<script\b[^>]*\bsrc\s*=/gi) || []).length,
        pendingLinks: (markup.match(/<link\b[^>]*\bhref\s*=\s*["'](?!#|data:)/gi) || []).length,
        styleBlocks: styleBlocks.length
    };
}

function readPackageVersion() {
    try {
        const parsed = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
        return typeof parsed.version === 'string' ? parsed.version : '';
    } catch (error) {
        return '';
    }
}

function readReleaseNotes() {
    try {
        return fs.readFileSync(path.join(ROOT, '.github', 'releases.md'), 'utf8').trim();
    } catch (error) {
        return '';
    }
}

function readModuleSources() {
    const sources = {};
    ['data_path.js', 'secret_store.js', 'sync_server.js'].forEach((name) => {
        try {
            sources[`src/main/${name}`] = fs.readFileSync(path.join(ROOT, 'src', 'main', name), 'utf8');
        } catch (error) {
            console.warn(`[WARN] [${MODULE}] 无法内联 src/main/${name}，网页版的同步将不可用 (detail=${error.message})`);
        }
    });
    return sources;
}

function injectVersion(html) {
    const payload = { version: readPackageVersion(), notes: readReleaseNotes() };
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    const sources = JSON.stringify(readModuleSources()).replace(/</g, '\\u003c');
    const tag = `<script>window.__esprinVersion=${JSON.stringify(payload.version)};window.__esprinReleaseNotes=${json};window.__esprinSources=${sources};</script>\n`;
    return html.replace(/<script\b/i, `${tag}$&`);
}

function build(source) {
    let html = inlineIcons(source);
    html = inlineStyles(html);
    html = inlineScripts(html);

    const audit = auditSelfContained(html);
    if (audit.scriptTags !== stats.scripts) {
        console.warn(`[WARN] [${MODULE}] 脚本标签数与内联数不一致 (tags=${audit.scriptTags} inlined=${stats.scripts})，自包含审计结果可能不完整`);
    }
    if (audit.external.length || audit.pendingScripts || audit.pendingLinks) {
        const samples = audit.external.slice(0, 3).join(' | ');
        throw new Error(`产物仍存在外部引用 (markup=${audit.external.length} scripts=${audit.pendingScripts} links=${audit.pendingLinks})${samples ? `：${samples}` : ''}`);
    }

    lastAudit = audit;
    return injectVersion(html);
}

function main() {
    const outPath = path.resolve(readOption('out', defaultOutPath()));
    const entryPath = path.join(WEB_ROOT, ENTRY);

    if (!fs.existsSync(entryPath)) {
        console.error(`[ERROR] [${MODULE}] 缺少入口文件 (path=${entryPath})`);
        process.exitCode = 1;
        return;
    }

    try {
        const startedAt = Date.now();
        entryDir = path.dirname(entryPath);
        const html = build(fs.readFileSync(entryPath, 'utf8'));
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, html, 'utf8');

        const size = Buffer.byteLength(html);
        console.log(`[INFO] [${MODULE}] 内联完成 (styles=${stats.styles} scripts=${stats.scripts} assets=${stats.assets})`);
        console.log(`[INFO] [${MODULE}] 自包含检查通过 (外部引用=0 未内联样式=0 未内联脚本=0 内联样式块=${lastAudit ? lastAudit.styleBlocks : 0})`);
        console.log(`[INFO] [${MODULE}] 输出 ${path.relative(process.cwd(), outPath)} (size=${formatSize(size)} cost=${Date.now() - startedAt}ms)`);
    } catch (error) {
        console.error(`[ERROR] [${MODULE}] 打包失败 (detail=${error.message})`);
        process.exitCode = 1;
    }
}

main();
