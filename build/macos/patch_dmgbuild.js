const fs = require('node:fs');
const path = require('node:path');

const MODULE = 'DmgPatch';
const ROOT = path.resolve(__dirname, '..', '..');
const CORE_FILE = path.join(ROOT, 'node_modules', 'dmg-builder', 'vendor', 'dmgbuild', 'core.py');

const TARGET = 'background_bmk = Bookmark.for_file(background_file)';
const PATCHED = 'background_bmk = None';

function log(level, message) {
    const line = `[Desktop:${level}] ${MODULE}：${message}`;
    if (level === 'ERROR' || level === 'WARN') console.error(line);
    else console.log(line);
}

function main() {
    if (!fs.existsSync(CORE_FILE)) {
        log('WARN', `未找到 dmgbuild 源码，跳过背景补丁 (path=${CORE_FILE})`);
        return;
    }

    const source = fs.readFileSync(CORE_FILE, 'utf8');
    if (source.includes(TARGET)) {
        fs.writeFileSync(CORE_FILE, source.replace(TARGET, PATCHED), 'utf8');
        log('INFO', '已应用 macOS 26 的 DMG 背景兼容补丁');
        return;
    }

    if (source.includes(PATCHED)) {
        log('INFO', 'DMG 背景兼容补丁已存在');
        return;
    }

    log('WARN', 'dmgbuild 中没有找到背景 bookmark 代码，补丁未应用');
}

main();
