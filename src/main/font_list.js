const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 主进程字体枚举：直接解析字体文件的 name 表，拿到准确的字体族名。
// 作为渲染进程 Local Font Access API 不可用时的兜底方案（无需任何第三方依赖）。

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc']);
const MAX_NAME_TABLE_BYTES = 1 << 20; // name 表最多读取 1MB，避免异常文件撑爆内存
const MAX_FONT_FILES = 20000;
const MAX_SCAN_DEPTH = 4;

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (error) {
    return false;
  }
}

// 各平台常见字体目录
function getFontDirs() {
  const home = os.homedir();
  const dirs = [];

  if (process.platform === 'win32') {
    const winDir = process.env.WINDIR || 'C:\\Windows';
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    dirs.push(path.join(winDir, 'Fonts'));
    // 用户自行安装的字体（Windows 10 1809+）
    dirs.push(path.join(localAppData, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push(
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      path.join(home, 'Library', 'Fonts')
    );
  } else {
    dirs.push(
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      path.join(home, '.fonts'),
      path.join(home, '.local', 'share', 'fonts')
    );
  }

  return dirs.filter(isDirectory);
}

function collectFontFiles(dir, out, depth) {
  if (depth < 0 || out.length >= MAX_FONT_FILES) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_FONT_FILES) return;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFontFiles(fullPath, out, depth - 1);
    } else if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(fullPath);
    }
  }
}

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buffer, 0, length, position);
  } catch (error) {
    return buffer.subarray(0, 0);
  }
  return buffer.subarray(0, bytesRead);
}

// 解析 name 表的字符串记录，优先取排版族名（nameID 16），其次取族名（nameID 1）
function parseNameTable(table) {
  if (table.length < 6) return null;

  const count = table.readUInt16BE(2);
  const stringOffset = table.readUInt16BE(4);
  let best = null;
  let bestScore = -1;

  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    if (record + 12 > table.length) break;

    const platformID = table.readUInt16BE(record);
    const languageID = table.readUInt16BE(record + 4);
    const nameID = table.readUInt16BE(record + 6);
    if (nameID !== 1 && nameID !== 16) continue;

    const length = table.readUInt16BE(record + 8);
    const offset = table.readUInt16BE(record + 10);
    const start = stringOffset + offset;
    if (!length || start + length > table.length) continue;

    const raw = table.subarray(start, start + length);
    // Windows(3)/Unicode(0) 平台使用 UTF-16BE，Mac 平台按单字节处理
    let text = '';
    if (platformID === 3 || platformID === 0) {
      if (raw.length % 2 === 0) text = Buffer.from(raw).swap16().toString('utf16le').trim();
    } else {
      text = raw.toString('latin1').trim();
    }
    if (!text) continue;

    // 英文族名优先，排版族名优先于普通族名
    const isEnglish = languageID === 0x0409 || platformID === 0;
    const score = (nameID === 16 ? 2 : 0) + (isEnglish ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = text;
    }
  }

  return best;
}

// 读取单个字体文件（含 ttc/otc 集合）的族名
function readFontFamilies(fontPath) {
  let fd = null;
  const families = new Set();

  try {
    fd = fs.openSync(fontPath, 'r');
    const header = readAt(fd, 12, 0);
    if (header.length < 12) return families;

    const signature = header.toString('latin1', 0, 4);
    const offsets = [];

    if (signature === 'ttcf') {
      // 字体集合：每个子字体有独立的表目录，表偏移相对文件起始位置
      const numFonts = header.readUInt32BE(8);
      if (numFonts > 512) return families;
      const list = readAt(fd, numFonts * 4, 12);
      for (let i = 0; i < numFonts; i++) {
        if ((i + 1) * 4 > list.length) break;
        offsets.push(list.readUInt32BE(i * 4));
      }
    } else {
      offsets.push(0);
    }

    for (const base of offsets) {
      const subHeader = base === 0 ? header : readAt(fd, 12, base);
      if (subHeader.length < 12) continue;

      const numTables = subHeader.readUInt16BE(4);
      if (!numTables || numTables > 512) continue;
      const dir = readAt(fd, numTables * 16, base + 12);

      for (let i = 0; i < numTables; i++) {
        const entry = i * 16;
        if (entry + 16 > dir.length) break;
        if (dir.toString('latin1', entry, entry + 4) !== 'name') continue;

        const nameOffset = dir.readUInt32BE(entry + 8);
        const nameLength = dir.readUInt32BE(entry + 12);
        if (!nameLength || nameOffset <= 0) break;

        const table = readAt(fd, Math.min(nameLength, MAX_NAME_TABLE_BYTES), nameOffset);
        const family = parseNameTable(table);
        if (family) families.add(family);
        break;
      }
    }
  } catch (error) {
    // 单个字体文件解析失败不影响整体枚举
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        // 忽略
      }
    }
  }

  return families;
}

// 返回本机已安装的字体族名列表（去重、忽略大小写、按名称排序）
function listSystemFonts() {
  const files = [];
  getFontDirs().forEach((dir) => collectFontFiles(dir, files, MAX_SCAN_DEPTH));

  const seen = new Set();
  const families = [];

  files.forEach((fontPath) => {
    readFontFamilies(fontPath).forEach((family) => {
      const key = family.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      families.push(family);
    });
  });

  return families.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));
}

module.exports = { listSystemFonts };
