#!/usr/bin/env bun
/**
 * clean.js —— 移除 JS / Python / PowerShell 源码里的注释
 *
 * 用法：
 *   bun clean.js src/                 清理目录下所有 .js/.mjs/.cjs/.py/.ps1
 *   bun clean.js src/main/main.js     只清理指定文件
 *   bun clean.js src/ --dry           只统计，不写回
 *   bun clean.js src/ --quiet         只输出汇总
 *
 * 规则：
 *   - 只删真注释：字符串、模板字符串、正则字面量、Python 三引号、
 *     PowerShell here-string 里的斜杠注释、井号注释、块注释都原样保留
 *   - 块注释按其中包含的换行数补回换行，删除后行号不会错位
 *   - 保留 shebang（#!）与 PowerShell 的 #requires 指令
 *   - Python 的 docstring 语法上是字符串而非注释，默认保留
 */

import fs from 'node:fs';
import path from 'node:path';

const EXT_KIND = new Map([
    ['.js', 'js'],
    ['.mjs', 'js'],
    ['.cjs', 'js'],
    ['.py', 'py'],
    ['.ps1', 'ps1']
]);

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

/* ────────────────────────── 公共小工具 ────────────────────────── */

function trimTrailingSpaces(out) {
    while (out.length) {
        const last = out[out.length - 1];
        const trimmed = last.replace(/[ \t]+$/, '');
        if (trimmed === last) return;
        out[out.length - 1] = trimmed;
        if (trimmed) return;
        out.pop();
    }
}

function keepLineBreaks(out, chunk) {
    for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (ch === '\n' || ch === '\r') out.push(ch);
    }
}

/* 当前输出行的最后一个换行之后是否已经有非空白内容 */
function lineHasContent(out) {
    for (let i = out.length - 1; i >= 0; i--) {
        const chunk = out[i];
        for (let j = chunk.length - 1; j >= 0; j--) {
            const c = chunk[j];
            if (c === '\n' || c === '\r') return false;
            if (c !== ' ' && c !== '\t') return true;
        }
    }
    return false;
}

/* 注释清掉后会留下只含空白的行，整理成最多一个空行，
   并去掉文件首尾因删注释产生的空行 */
function tidyBlankLines(text) {
    const lines = text.split('\n');
    const kept = [];
    for (const line of lines) {
        const blank = line.trim() === '';
        if (blank && (!kept.length || kept[kept.length - 1].trim() === '')) continue;
        kept.push(line);
    }
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    return kept.join('\n') + (text.endsWith('\n') ? '\n' : '');
}

/* ───────────────────────────── JavaScript ───────────────────────────── */

// 这些「上一个有效记号」后面出现的 `/` 视为正则字面量的开始，而不是除号
const REGEX_ALLOWED_PREV = new Set([
    '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
    '+', '-', '*', '%', '^', '~', '<', '>', '/',
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await'
]);

const JS_IDENT = /[A-Za-z0-9_$]/;

function scanJsRegex(src, start) {
    let i = start + 1;
    let inClass = false;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n' || c === '\r') return null;
        if (inClass) {
            if (c === ']') inClass = false;
            i++;
            continue;
        }
        if (c === '[') { inClass = true; i++; continue; }
        if (c === '/') {
            i++;
            while (i < src.length && /[a-z]/i.test(src[i])) i++;
            return { text: src.slice(start, i), next: i };
        }
        i++;
    }
    return null;
}

function scanJsTemplate(src, start, stats) {
    let i = start + 1;
    let text = '`';
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { text += src.slice(i, i + 2); i += 2; continue; }
        if (c === '`') { text += '`'; return { text, next: i + 1 }; }
        if (c === '$' && src[i + 1] === '{') {
            const inner = stripJsCode(src, i + 2, true, stats);
            text += '${' + inner.text + '}';
            i = inner.next;
            continue;
        }
        text += c;
        i++;
    }
    return { text, next: src.length };
}

function stripJsCode(src, start, stopAtBrace, stats) {
    const out = [];
    let ws = '';
    let i = start;
    let depth = 0;
    let prev = '';

    const flush = () => { if (ws) { out.push(ws); ws = ''; } };
    const push = (s) => { flush(); out.push(s); };

    while (i < src.length) {
        const c = src[i];
        const c2 = src[i + 1];

        // 行注释
        if (c === '/' && c2 === '/') {
            ws = '';
            let j = i + 2;
            while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
            stats.removed++;
            i = j;
            continue;
        }

        // 块注释
        if (c === '/' && c2 === '*') {
            let j = i + 2;
            while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
            const end = Math.min(j + 2, src.length);
            const chunk = src.slice(i, end);
            // 先把待处理的空白落盘（含换行），避免整行注释被并到上一行
            flush();
            const atLineStart = !lineHasContent(out);
            if (/[\r\n]/.test(chunk)) {
                trimTrailingSpaces(out);
                keepLineBreaks(out, chunk);
                if (lineHasContent(out)) ws = '\n';
            } else {
                // 两侧都没空白时才补一个空格，避免把两个记号粘在一起；
                // 行首的块注释不需要补，否则会留下一个多余的行首空格
                const nextChar = src[end];
                trimTrailingSpaces(out);
                const needSpace = nextChar
                    && nextChar !== ' '
                    && nextChar !== '\t'
                    && nextChar !== '\n'
                    && nextChar !== '\r';
                if (needSpace && !atLineStart) out.push(' ');
            }
            // 行首的块注释连同其后的一小段空白一起吃掉，避免留下缩进空格
            if (atLineStart) {
                let k = end;
                while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
                i = k;
            } else {
                i = end;
            }
            stats.removed++;
            continue;
        }

        // 单/双引号字符串
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === c) { j++; break; }
                if (src[j] === '\n' || src[j] === '\r') break;
                j++;
            }
            push(src.slice(i, j));
            prev = 'str';
            i = j;
            continue;
        }

        // 模板字符串（内部 ${} 里的注释也要清掉）
        if (c === '`') {
            const res = scanJsTemplate(src, i, stats);
            push(res.text);
            prev = 'str';
            i = res.next;
            continue;
        }

        // 正则字面量 / 除号
        if (c === '/') {
            if (REGEX_ALLOWED_PREV.has(prev)) {
                const res = scanJsRegex(src, i);
                if (res) {
                    push(res.text);
                    prev = 'str';
                    i = res.next;
                    continue;
                }
            }
            push(c);
            prev = '/';
            i++;
            continue;
        }

        // 标识符 / 关键字
        if (JS_IDENT.test(c)) {
            let j = i + 1;
            while (j < src.length && JS_IDENT.test(src[j])) j++;
            const word = src.slice(i, j);
            push(word);
            prev = word;
            i = j;
            continue;
        }

        if (c === '{') {
            depth++;
            push(c);
            prev = c;
            i++;
            continue;
        }

        if (c === '}') {
            if (stopAtBrace && depth === 0) {
                flush();
                return { text: out.join(''), next: i + 1 };
            }
            depth--;
            push(c);
            prev = c;
            i++;
            continue;
        }

        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            ws += c;
            i++;
            continue;
        }

        push(c);
        prev = c;
        i++;
    }

    flush();
    return { text: out.join(''), next: src.length };
}

function stripJs(src, stats) {
    let i = 0;
    const out = [];

    if (src[0] === '\uFEFF') { out.push('\uFEFF'); i = 1; }

    // shebang 保留
    if (src.startsWith('#!', i)) {
        let j = i;
        while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
        out.push(src.slice(i, j));
        i = j;
    }

    const res = stripJsCode(src, i, false, stats);
    out.push(res.text);
    return out.join('');
}

/* ─────────────────────────────── Python ─────────────────────────────── */

function stripPy(src, stats) {
    const out = [];
    let i = 0;

    if (src[0] === '\uFEFF') { out.push('\uFEFF'); i = 1; }

    // shebang / 编码声明保留
    if (src.startsWith('#!', i)) {
        let j = i;
        while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
        out.push(src.slice(i, j));
        i = j;
    }

    while (i < src.length) {
        const c = src[i];

        // 行注释
        if (c === '#') {
            trimTrailingSpaces(out);
            let j = i + 1;
            while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
            stats.removed++;
            i = j;
            continue;
        }

        // 字符串（含三引号、r/b/f/u 前缀，前缀本身会落在普通文本里）
        if (c === '"' || c === "'") {
            const triple = src[i + 1] === c && src[i + 2] === c;
            let j = i + (triple ? 3 : 1);
            while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue; }
                if (triple) {
                    if (src[j] === c && src[j + 1] === c && src[j + 2] === c) { j += 3; break; }
                } else {
                    if (src[j] === c) { j++; break; }
                    if (src[j] === '\n' || src[j] === '\r') break;
                }
                j++;
            }
            out.push(src.slice(i, j));
            i = j;
            continue;
        }

        // 普通文本整段推进
        let j = i + 1;
        while (j < src.length && src[j] !== '#' && src[j] !== '"' && src[j] !== "'") j++;
        out.push(src.slice(i, j));
        i = j;
    }

    return out.join('');
}

/* ──────────────────────────── PowerShell ──────────────────────────── */

function stripPs1(src, stats) {
    const out = [];
    let i = 0;

    if (src[0] === '\uFEFF') { out.push('\uFEFF'); i = 1; }

    const atLineStart = (pos) => {
        let k = pos - 1;
        while (k >= 0 && src[k] !== '\n' && src[k] !== '\r') {
            if (src[k] !== ' ' && src[k] !== '\t') return false;
            k--;
        }
        return true;
    };

    while (i < src.length) {
        const c = src[i];
        const c2 = src[i + 1];

        // 行首指令保留（#requires、#!）
        if (c === '#' && atLineStart(i) && (c2 === '!' || src.startsWith('#requires', i))) {
            let j = i;
            while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
            out.push(src.slice(i, j));
            i = j;
            continue;
        }

        // 块注释 <# ... #>
        if (c === '<' && c2 === '#') {
            let j = i + 2;
            while (j < src.length && !(src[j] === '#' && src[j + 1] === '>')) j++;
            const end = Math.min(j + 2, src.length);
            const chunk = src.slice(i, end);
            trimTrailingSpaces(out);
            if (/[\r\n]/.test(chunk)) keepLineBreaks(out, chunk);
            else out.push(' ');
            stats.removed++;
            i = end;
            continue;
        }

        // 行注释
        if (c === '#') {
            trimTrailingSpaces(out);
            let j = i + 1;
            while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
            stats.removed++;
            i = j;
            continue;
        }

        // here-string @" ... "@ / @' ... '@
        if (c === '@' && (c2 === '"' || c2 === "'")) {
            const quote = c2;
            const term = quote + '@';
            let k = i + 2;
            while (k < src.length && src[k] !== '\n' && src[k] !== '\r') k++;
            let end = src.length;
            while (k < src.length) {
                let ls = k;
                while (ls < src.length && (src[ls] === ' ' || src[ls] === '\t')) ls++;
                if (src.startsWith(term, ls)) { end = ls + term.length; break; }
                const nl = src.indexOf('\n', k);
                if (nl === -1) break;
                k = nl + 1;
            }
            out.push(src.slice(i, end));
            i = end;
            continue;
        }

        // 单引号字符串：'' 表示一个单引号
        if (c === "'") {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
                if (src[j] === "'") { j++; break; }
                j++;
            }
            out.push(src.slice(i, j));
            i = j;
            continue;
        }

        // 双引号字符串：反引号转义
        if (c === '"') {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === '`') { j += 2; continue; }
                if (src[j] === '"') { j++; break; }
                j++;
            }
            out.push(src.slice(i, j));
            i = j;
            continue;
        }

        // 反引号转义（行尾续行等），成对跳过
        if (c === '`' && i + 1 < src.length) {
            out.push(src.slice(i, i + 2));
            i += 2;
            continue;
        }

        out.push(c);
        i++;
    }

    return out.join('');
}

/* ─────────────────────────────── 驱动 ─────────────────────────────── */

const STRIPPERS = { js: stripJs, py: stripPy, ps1: stripPs1 };

function stripByKind(kind, text) {
    const stats = { removed: 0 };
    const code = tidyBlankLines(STRIPPERS[kind](text, stats));
    return { code, removed: stats.removed };
}

function* walk(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        console.warn(`跳过（无法读取）: ${dir} — ${err.message}`);
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            yield* walk(full);
        } else if (entry.isFile()) {
            yield full;
        }
    }
}

function collect(targets) {
    const files = [];
    for (const target of targets) {
        const abs = path.resolve(target);
        let stat;
        try {
            stat = fs.statSync(abs);
        } catch {
            console.warn(`跳过（不存在）: ${target}`);
            continue;
        }
        if (stat.isDirectory()) {
            for (const file of walk(abs)) {
                if (EXT_KIND.has(path.extname(file).toLowerCase())) files.push(file);
            }
        } else if (EXT_KIND.has(path.extname(abs).toLowerCase())) {
            files.push(abs);
        }
    }
    return [...new Set(files)].sort();
}

function main() {
    const argv = process.argv.slice(2);
    const dry = argv.includes('--dry') || argv.includes('-n');
    const quiet = argv.includes('--quiet') || argv.includes('-q');
    const targets = argv.filter((arg) => !arg.startsWith('-'));

    if (!targets.length || argv.includes('--help') || argv.includes('-h')) {
        console.log(`用法: bun clean.js <文件或目录> [...] [--dry] [--quiet]

  清除 JS / Python / PowerShell 源码中的注释。
  支持扩展名: ${[...EXT_KIND.keys()].join(' ')}

  --dry, -n     只统计，不写回文件
  --quiet, -q   只输出汇总`);
        process.exit(targets.length ? 0 : 1);
    }

    const files = collect(targets);
    if (!files.length) {
        console.log('没有找到可清理的文件。');
        return;
    }

    let changed = 0;
    let removedTotal = 0;
    let failed = 0;

    for (const file of files) {
        const kind = EXT_KIND.get(path.extname(file).toLowerCase());
        const original = fs.readFileSync(file, 'utf8');
        const { code, removed } = stripByKind(kind, original);

        if (removed === 0) continue;
        removedTotal += removed;

        if (code !== original) {
            changed++;
            if (!dry) {
                try {
                    fs.writeFileSync(file, code, 'utf8');
                } catch (err) {
                    failed++;
                    console.error(`写入失败: ${file} — ${err.message}`);
                    continue;
                }
            }
            if (!quiet) {
                console.log(`${dry ? '[dry] ' : ''}${path.relative(process.cwd(), file)}  (-${removed})`);
            }
        }
    }

    console.log(
        `\n${dry ? '预览' : '完成'}：扫描 ${files.length} 个文件，` +
        `${changed} 个有注释${dry ? '（未写入）' : '已清理'}，` +
        `共移除 ${removedTotal} 处注释` +
        (failed ? `，${failed} 个写入失败` : '')
    );
}

main();
