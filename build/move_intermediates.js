const fs = require('node:fs');
const path = require('node:path');

const MODULE = 'BuildCache';
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const CACHE_DIR = path.join(DIST_DIR, 'cache', 'electron_builder');

const INTERMEDIATES = [
    'builder-debug.yml',
    'builder-effective-config.yaml',
    '.icon-icns',
    'mac',
    'mac-arm64',
    'mac-x64',
    'mac-universal',
    'win-unpacked',
    'win-ia32-unpacked',
    'win-arm64-unpacked',
    'linux-unpacked',
    'linux-arm64-unpacked'
];

function log(level, message) {
    const line = `[${level}] [${MODULE}] ${message}`;
    if (level === 'ERROR' || level === 'WARN') console.error(line);
    else console.log(line);
}

function moveInto(entry) {
    const source = path.join(DIST_DIR, entry);
    if (!fs.existsSync(source)) return false;

    const target = path.join(CACHE_DIR, entry);
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(source, target);
        return true;
    } catch (error) {
        log('WARN', `移动中间产物失败 ${entry}: ${error.message}`);
        return false;
    }
}

function main() {
    if (!fs.existsSync(DIST_DIR)) {
        log('INFO', '没有 dist 目录，跳过');
        return;
    }

    const moved = INTERMEDIATES.filter(moveInto);
    if (moved.length) {
        log('INFO', `已把 ${moved.length} 项中间产物移入 dist/cache/electron_builder (${moved.join(', ')})`);
    } else {
        log('INFO', '没有需要移动的中间产物');
    }
}

main();
