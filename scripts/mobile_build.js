'use strict';

const fs = require('fs');
const path = require('path');

const MODULE = 'MobileBuild';
const ROOT = path.resolve(__dirname, '..');
const MOBILE_DIR = path.join(ROOT, 'src', 'mobile');
const SCRIPT_DIR = path.join(MOBILE_DIR, 'scripts');
const STYLE_DIR = path.join(MOBILE_DIR, 'styles');
const ASSETS_DIR = path.join(ROOT, 'assets');
const MATERIAL_DIR = path.join(ROOT, 'node_modules', 'material-symbols');
const DIST_DIR = path.join(ROOT, 'dist');

const ENTRY_NAME = 'app.js';
const FONT_NAME = 'material-symbols-rounded.woff2';
const STYLE_ORDER = ['tokens.css', 'base.css', 'list.css', 'editor.css', 'settings.css'];

function log(level, message) {
    const line = `[${level}] [${MODULE}] ${message}`;
    if (level === 'ERROR' || level === 'WARN') console.error(line);
    else console.log(line);
}

function readVersion() {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
    } catch (error) {
        return '0.0.0';
    }
}

function readText(file) {
    return fs.readFileSync(file, 'utf8');
}

function readBase64(file) {
    return fs.readFileSync(file).toString('base64');
}

function resolveScript(spec) {
    const name = spec.replace(/^\.\//, '');
    const target = path.join(SCRIPT_DIR, name);
    if (!fs.existsSync(target)) return '';
    return target;
}

function collectModules(entryName) {
    const modules = new Map();

    const visit = (name) => {
        if (modules.has(name)) return;
        const file = path.join(SCRIPT_DIR, name);
        if (!fs.existsSync(file)) {
            log('ERROR', `缺少脚本 (path=${file})`);
            return;
        }
        const source = readText(file);
        modules.set(name, source);

        const importPattern = /import\s*\{[\s\S]*?\}\s*from\s*['"]([^'"]+)['"];?/g;
        let matched = importPattern.exec(source);
        while (matched) {
            const target = resolveScript(matched[1]);
            if (!target) {
                log('ERROR', `${name} 引用了不存在的模块 (spec=${matched[1]})`);
            } else {
                visit(path.basename(target));
            }
            matched = importPattern.exec(source);
        }
    };

    visit(entryName);

    const ordered = [];
    const seen = new Set();
    const emit = (name) => {
        if (seen.has(name)) return;
        seen.add(name);
        const source = modules.get(name) || '';
        const importPattern = /import\s*\{[\s\S]*?\}\s*from\s*['"]([^'"]+)['"];?/g;
        const deps = [];
        let matched = importPattern.exec(source);
        while (matched) {
            const target = resolveScript(matched[1]);
            if (target) deps.push(path.basename(target));
            matched = importPattern.exec(source);
        }
        deps.forEach(emit);
        ordered.push(name);
    };
    emit(entryName);

    return ordered.map((name) => ({ name, source: modules.get(name) }));
}

function transformModule(source) {
    const exported = [];
    let code = source;

    code = code.replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?/g, (match, names, spec) => {
        const id = spec.replace(/^\.\//, '').trim();
        const cleaned = names.replace(/\s+/g, ' ').trim();
        return `const { ${cleaned} } = __require(${JSON.stringify(id)});`;
    });

    code = code.replace(/import\s*['"]([^'"]+)['"];?/g, (match, spec) => {
        const id = spec.replace(/^\.\//, '').trim();
        return `__require(${JSON.stringify(id)});`;
    });

    code = code.replace(/^export\s+(async\s+function|function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm, (match, kind, name) => {
        exported.push(name);
        return `${kind} ${name}`;
    });

    code = code.replace(/^export\s*\{([\s\S]*?)\};?/gm, (match, names) => {
        names.split(',').forEach((piece) => {
            const text = piece.trim();
            if (!text) return;
            const local = text.split(/\s+as\s+/)[0].trim();
            if (local) exported.push(local);
        });
        return '';
    });

    const tail = exported.map((name) => `    exports[${JSON.stringify(name)}] = ${name};`).join('\n');
    return `${code}\n${tail}`;
}

function buildBundle(modules) {
    const parts = [];

    parts.push('(function () {');
    parts.push('"use strict";');
    parts.push('var __modules = {};');
    parts.push('var __cache = {};');
    parts.push('function __require(id) {');
    parts.push('    if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id];');
    parts.push('    var factory = __modules[id];');
    parts.push('    if (!factory) throw new Error("模块缺失: " + id);');
    parts.push('    var exports = {};');
    parts.push('    __cache[id] = exports;');
    parts.push('    factory(exports, __require);');
    parts.push('    return exports;');
    parts.push('}');

    for (const item of modules) {
        parts.push(`__modules[${JSON.stringify(item.name)}] = function (exports, __require) {`);
        parts.push(transformModule(item.source));
        parts.push('};');
    }

    parts.push(`__require(${JSON.stringify(ENTRY_NAME)});`);
    parts.push('})();');

    return parts.join('\n').replace(/<\/script/gi, '<\\/script');
}

function buildStyles() {
    const fontFile = path.join(MATERIAL_DIR, FONT_NAME);
    if (!fs.existsSync(fontFile)) {
        log('ERROR', `缺少图标字体 (path=${fontFile})`);
    }
    const fontData = fs.existsSync(fontFile)
        ? `data:font/woff2;base64,${readBase64(fontFile)}`
        : '';

    const materialCss = readText(path.join(MATERIAL_DIR, 'rounded.css'))
        .replace(/url\(\s*["']?\.\/material-symbols-rounded\.woff2["']?\s*\)/g, `url("${fontData}")`);

    const blocks = [`<style data-part="material-symbols">\n${materialCss}\n</style>`];

    for (const name of STYLE_ORDER) {
        const file = path.join(STYLE_DIR, name);
        if (!fs.existsSync(file)) {
            log('ERROR', `缺少样式 (path=${file})`);
            continue;
        }
        blocks.push(`<style data-part="${name}">\n${readText(file)}\n</style>`);
    }

    return blocks.join('\n');
}

function brandSvg() {
    const file = path.join(ASSETS_DIR, 'tray.svg');
    if (!fs.existsSync(file)) {
        log('ERROR', `缺少品牌图标 (path=${file})`);
        return '';
    }
    return readText(file)
        .replace(/fill="(?!none)[^"]*"/g, 'fill="currentColor"')
        .replace(/<svg([^>]*)>/, '<svg$1 class="app-brand-icon" aria-hidden="true" width="17" height="17">')
        .trim();
}

function faviconTag() {
    const file = path.join(ASSETS_DIR, 'icon.svg');
    if (!fs.existsSync(file)) return '';
    return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${readBase64(file)}">`;
}

function buildHtml() {
    const entry = path.join(MOBILE_DIR, 'index.html');
    if (!fs.existsSync(entry)) {
        log('ERROR', `缺少入口页面 (path=${entry})`);
        return null;
    }

    let html = readText(entry);

    html = html.replace(/\s*<link rel="manifest"[^>]*>\n?/i, '\n    ');
    html = html.replace(/\s*<link rel="stylesheet" href="\/node_modules\/material-symbols\/rounded\.css">\n?/i, '\n    ');
    for (const name of STYLE_ORDER) {
        const pattern = new RegExp(`\\s*<link rel="stylesheet" href="\\./styles/${name.replace('.', '\\.')}">\\n?`, 'i');
        html = html.replace(pattern, '\n    ');
    }
    html = html.replace(/<\/head>/i, `    ${faviconTag()}\n</head>`);

    const icon = brandSvg();
    if (icon) {
        html = html.replace(
            /<span class="app-brand-icon" id="app-brand-icon"><\/span>/,
            `<span class="app-brand-icon" id="app-brand-icon">${icon}</span>`
        );
    }

    const modules = collectModules(ENTRY_NAME);
    if (!modules.length) {
        log('ERROR', '脚本模块为空');
        return null;
    }

    const scriptTag = new RegExp(`\\s*<script type="module" src="\\./scripts/${ENTRY_NAME.replace('.', '\\.')}"></script>\\n?`, 'i');
    html = html.replace(scriptTag, '\n    <script>\n' + buildBundle(modules) + '\n    </script>\n');

    html = html.replace('</head>', `${buildStyles()}\n</head>`);

    return html;
}

function main() {
    const version = readVersion();
    const html = buildHtml();
    if (html === null) {
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(DIST_DIR, { recursive: true });
    const output = path.join(DIST_DIR, `EsprinNemo_Mobile_v${version}.html`);
    fs.writeFileSync(output, html, 'utf8');

    const size = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2);
    const external = (html.match(/<(?:link|script)[^>]+(?:href|src)="(?!data:|#)/gi) || []).length;

    log('INFO', `已生成 ${path.relative(ROOT, output)} (version=${version} size=${size}MB)`);
    if (external) log('WARN', `仍有 ${external} 处外部引用，单文件可能不完整`);
    else log('INFO', '全部资源已内联，无外部引用');
}

main();
