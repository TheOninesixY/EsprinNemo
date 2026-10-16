#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = 'SyncBuild';
const ROOT = path.resolve(__dirname, '..');
const SYNC_DIR = path.join(ROOT, 'src', 'sync');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const MANAGER_DIR = path.join(SYNC_DIR, 'manager');
const DIST_DIR = path.join(ROOT, 'dist');
const BUILD_DIR = path.join(DIST_DIR, '.sync_build');
const MATERIAL_DIR = path.join(ROOT, 'node_modules', 'material-symbols');

const WEB_FILES = ['main.html', 'boot.js', 'window_appearance.js', 'web_host.js', 'sw.js'];
const WEB_DIRS = ['styles', 'scripts', 'fonts'];
const MATERIAL_FILES = ['rounded.css', 'material-symbols-rounded.woff2'];
const MAIN_FILES = ['data_path.js', 'secret_store.js', 'sync_server.js'];

function readOption(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}

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

function collectFiles(sourceDir, targetPrefix, list = []) {
    for (const name of fs.readdirSync(sourceDir)) {
        const absolute = path.join(sourceDir, name);
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) {
            collectFiles(absolute, `${targetPrefix}/${name}`, list);
            continue;
        }
        list.push({ name: `${targetPrefix}/${name}`, absolute });
    }
    return list;
}

function buildEmbeddedAssets(version) {
    const map = new Map();
    const add = (absolute) => {
        if (!fs.existsSync(absolute)) return;
        const key = path.relative(ROOT, absolute).split(path.sep).join('/');
        map.set(key, fs.readFileSync(absolute).toString('base64'));
    };

    for (const name of WEB_FILES) add(path.join(RENDERER_DIR, name));
    for (const dir of WEB_DIRS) {
        const source = path.join(RENDERER_DIR, dir);
        if (!fs.existsSync(source)) continue;
        for (const item of collectFiles(source, dir)) add(item.absolute);
    }
    for (const name of MATERIAL_FILES) add(path.join(MATERIAL_DIR, name));
    for (const name of MAIN_FILES) add(path.join(ROOT, 'src', 'main', name));
    if (fs.existsSync(MANAGER_DIR)) {
        for (const item of collectFiles(MANAGER_DIR, 'manager')) add(item.absolute);
    }
    add(path.join(ROOT, 'src', 'assets', 'icon.svg'));
    add(path.join(ROOT, 'src', 'assets', 'icon.png'));
    add(path.join(ROOT, '.github', 'releases.md'));

    const meta = {
        name: 'esprin_sync',
        version,
        svg_icon: 'src/assets/icon.svg',
        icon: 'src/assets/icon.png'
    };
    map.set('package.json', Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8').toString('base64'));

    const lines = ['export default new Map(['];
    for (const [key, value] of map) {
        lines.push(`    [${JSON.stringify(key)}, Buffer.from(${JSON.stringify(value)}, "base64")],`);
    }
    lines.push(']);');
    lines.push('');

    const target = path.join(BUILD_DIR, 'embedded_assets.js');
    fs.writeFileSync(target, lines.join('\n'), 'utf8');
    return { target, count: map.size };
}

function writeEntry(entry) {
    const toPosix = (value) => value.split(path.sep).join('/');
    fs.writeFileSync(entry, [
        `import embedded from './embedded_assets.js';`,
        `import { setEmbeddedAssets } from '${toPosix(path.join(SYNC_DIR, 'assets.js'))}';`,
        `import { main } from '${toPosix(path.join(SYNC_DIR, 'server.js'))}';`,
        '',
        'setEmbeddedAssets(embedded);',
        'main();',
        ''
    ].join('\n'), 'utf8');
}

function compileBinary(entry, target, output) {
    const result = spawnSync('bun', ['build', entry, '--compile', '--minify', `--target=${target}`, '--outfile', output], {
        cwd: ROOT,
        encoding: 'utf8'
    });
    if (result.status !== 0 || !fs.existsSync(output)) {
        const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-1)[0] || 'unknown';
        return { ok: false, detail };
    }
    return { ok: true, detail: '' };
}

function describe(target, output) {
    const size = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
    return `${path.relative(process.cwd(), output)} (target=${target} size=${size}MB)`;
}

function main() {
    const version = readVersion();
    const packageName = `EsprinSync.v${version}`;
    const outDir = path.resolve(readOption('out', DIST_DIR));
    const bareTarget = readOption('target', process.platform === 'win32' ? 'bun-windows-x64' : 'bun-linux-x64');

    if (!fs.existsSync(SYNC_DIR)) {
        log('ERROR', `缺少服务端源码 (path=${SYNC_DIR})`);
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(BUILD_DIR, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    const embedded = buildEmbeddedAssets(version);
    const entry = path.join(BUILD_DIR, 'entry.js');
    writeEntry(entry);
    log('INFO', `已内嵌网页端与管理页 (files=${embedded.count})`);

    if (hasFlag('no-exe')) {
        log('INFO', '已跳过 Windows exe（--no-exe）');
    } else {
        const exePath = path.join(outDir, `${packageName}.exe`);
        const built = compileBinary(entry, 'bun-windows-x64', exePath);
        if (built.ok) log('INFO', `已生成 ${describe('bun-windows-x64', exePath)}`);
        else {
            log('ERROR', `Windows exe 构建失败 (detail=${built.detail})`);
            process.exitCode = 1;
        }
    }

    if (hasFlag('no-bare')) {
        log('INFO', '已跳过无扩展名可执行文件（--no-bare）');
        return;
    }

    const barePath = path.join(outDir, packageName);
    const bare = compileBinary(entry, bareTarget, barePath);
    if (bare.ok) {
        if (process.platform !== 'win32') fs.chmodSync(barePath, 0o755);
        log('INFO', `已生成 ${describe(bareTarget, barePath)}`);
    } else {
        log('ERROR', `无扩展名可执行文件构建失败 (detail=${bare.detail})`);
        process.exitCode = 1;
    }
}

main();
