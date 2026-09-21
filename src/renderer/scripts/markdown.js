/* 轻量 Markdown 渲染器（代码块、引用块、列表、任务清单、标题、链接、粗斜体、水平线、行内代码） */

/* ---------------- 链接地址安全 ---------------
   笔记正文与 AI 生成的回答都会被解析成 HTML 后塞进 innerHTML，而渲染进程开着 Node 集成，
   因此链接协议必须在这里卡死：只放行 http(s) / mailto / tel 与不带协议的站内相对地址，
   javascript: / data: / vbscript: 等可执行协议一律降级为纯文本，避免一次点击就执行脚本。 */

// 放行的协议（小写、含冒号）
const SAFE_LINK_SCHEME = /^(?:https?|mailto|tel):$/;
// 形如 javascript: 的协议前缀
const LINK_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/;
// 协议判断前要去掉的不可见字符：空白、控制字符、零宽字符等（java&#x09;script: 这类伪装）
const LINK_INVISIBLE_PATTERN = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g;
// 实体解码：命名实体与十进制 / 十六进制实体，只解一层，避免二次解码把无害文本变成危险协议
const LINK_ENTITY_PATTERN = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g;
const LINK_NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0'
};

function decodeLinkEntities(value) {
    return String(value).replace(LINK_ENTITY_PATTERN, (match, dec, hex, name) => {
        if (dec) {
            const code = Number(dec);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        if (hex) {
            const code = parseInt(hex, 16);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        const key = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(LINK_NAMED_ENTITIES, key) ? LINK_NAMED_ENTITIES[key] : match;
    });
}

// 写回 href 前的转义：解码后可能重新出现引号或尖括号，必须再转义一次才能安全地放进属性里
function escapeLinkAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 返回可安全写入 href 的地址；协议不被放行时返回空字符串（调用方降级为纯文本）
function sanitizeLinkUrl(raw) {
    const decoded = decodeLinkEntities(raw).trim();
    if (!decoded) return '';
    const compact = decoded.replace(LINK_INVISIBLE_PATTERN, '').toLowerCase();
    const scheme = compact.match(LINK_SCHEME_PATTERN);
    if (scheme && !SAFE_LINK_SCHEME.test(scheme[0])) return '';
    return escapeLinkAttribute(decoded);
}

const marked = {
    parse(value = '') {
        if (!value) return '';

        // 占位符不能包含 * _ ~ ` [ ] 等 Markdown 语义字符，
        // 否则会被后续的加粗/斜体等正则改写，导致无法还原
        const CODE_BLOCK_TOKEN = (i) => `@@ESPRINCODEBLOCK${i}@@`;
        const INLINE_CODE_TOKEN = (i) => `@@ESPRININLINECODE${i}@@`;

        // 1. 暂存代码块，避免代码块内容被其他正则破坏
        const codeBlocks = [];
        let text = String(value).replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (match, lang, code) => {
            const id = CODE_BLOCK_TOKEN(codeBlocks.length);
            const escapedCode = code
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
            codeBlocks.push(`<pre><code class="language-${lang || 'text'}">${escapedCode}</code></pre>`);
            return id;
        });

        // 2. 暂存行内代码
        const inlineCodes = [];
        text = text.replace(/`([^`\n]+)`/g, (match, code) => {
            const id = INLINE_CODE_TOKEN(inlineCodes.length);
            const escapedCode = code
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            inlineCodes.push(`<code>${escapedCode}</code>`);
            return id;
        });

        // 3. 基础 HTML 转义
        text = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

        // 4. 标题解析
        text = text
            .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
            .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
            .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
            .replace(/^### (.*)$/gm, '<h3>$1</h3>')
            .replace(/^## (.*)$/gm, '<h2>$1</h2>')
            .replace(/^# (.*)$/gm, '<h1>$1</h1>');

        // 5. 分割线
        text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr>');

        // 6. 表格解析：表头行 + 分隔行（用 : 决定该列对齐）+ 若干表体行
        // 以「分隔行」为成立条件，正文里零星出现的竖线因此不会被误判成表格；
        // 行首行尾的竖线可有可无，两种写法都兼容
        text = text.replace(
            /(^[ \t]*\|?[^\r\n|]*(?:\|[^\r\n|]*)+[ \t]*\|?[ \t]*\r?\n)(^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*\r?\n)((?:^[ \t]*\|?[^\r\n|]*(?:\|[^\r\n|]*)+[ \t]*\|?[ \t]*(?:\r?\n|$))*)/gm,
            (block, headerRow, dividerRow, bodyRows) => {
                // 去掉首尾竖线后按 | 切列
                const splitCells = (row) => row
                    .trim()
                    .replace(/^\||\|$/g, '')
                    .split('|')
                    .map(cell => cell.trim());
                const aligns = splitCells(dividerRow).map(spec => {
                    const left = spec.startsWith(':');
                    const right = spec.endsWith(':');
                    if (left && right) return 'center';
                    if (right) return 'right';
                    if (left) return 'left';
                    return '';
                });
                const alignStyle = (index) => (aligns[index] ? ` style="text-align: ${aligns[index]}"` : '');
                const head = splitCells(headerRow)
                    .map((cell, i) => `<th${alignStyle(i)}>${cell}</th>`)
                    .join('');
                const body = bodyRows
                    .split(/\r?\n/)
                    .filter(row => row.trim())
                    .map(row => `<tr>${splitCells(row).map((cell, i) => `<td${alignStyle(i)}>${cell}</td>`).join('')}</tr>`)
                    .join('');
                // 外层容器负责窄屏横向滚动；前后补空行，避免表格被并进相邻段落
                return `\n\n<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>\n\n`;
            }
        );

        // 7. 引用块解析（支持多行连续引用）
        text = text.replace(/(?:^&gt; ?[^\r\n]*(?:\r?\n|$))+/gm, (block) => {
            const inner = block
                .split(/\r?\n/)
                .filter(line => line.length > 0)
                .map(line => line.replace(/^&gt; ?/, ''))
                .join('<br>');
            return `<blockquote><p>${inner}</p></blockquote>\n`;
        });

        // 8. 任务清单与普通列表项
        text = text.replace(/^- \[ \] (.*)$/gm, '<li class="task-item"><input type="checkbox" disabled> $1</li>');
        text = text.replace(/^- \[x\] (.*)$/gm, '<li class="task-item"><input type="checkbox" checked disabled> $1</li>');
        text = text.replace(/^[-*+] (.*)$/gm, '<li>$1</li>');
        text = text.replace(/^\d+\. (.*)$/gm, '<li class="ordered">$1</li>');

        // 将连续的 <li> 包裹在 <ul> 或 <ol> 中
        text = text.replace(/(?:<li class="ordered">.*?<\/li>\s*)+/g, '<ol>$&</ol>');
        text = text.replace(/(?:<li>.*?<\/li>\s*|<li class="task-item">.*?<\/li>\s*)+/g, '<ul>$&</ul>');

        // 9. 粗体、斜体、删除线与链接
        text = text
            .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.+?)__/g, '<strong>$1</strong>')
            .replace(/\*([^\*\n]+?)\*/g, '<em>$1</em>')
            // 下划线斜体不允许出现在单词内部，否则 snake_case_name 会被吃掉下划线；
            // 中文不被 \w 覆盖，因此「中文_强调_中文」仍按原来的方式解析
            .replace(/(^|[^\w])_([^_\n]+?)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>')
            .replace(/~~(.+?)~~/g, '<del>$1</del>')
            // 链接地址先过一遍协议白名单，不放行时只保留链接文字
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
                const safeUrl = sanitizeLinkUrl(url);
                return safeUrl
                    ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
                    : label;
            });

        // 10. 段落与换行处理
        // 让代码块占位符独占段落，保证还原后不与其他文本挤在同一个 <p> 内
        text = text.replace(/[ \t]*@@ESPRINCODEBLOCK(\d+)@@[ \t]*/g, (match, idx) => `\n\n@@ESPRINCODEBLOCK${idx}@@\n\n`);
        const paragraphs = text.split(/(?:\r?\n){2,}/);
        text = paragraphs.map(p => {
            p = p.trim();
            if (!p) return '';
            // 代码块占位符独占一段时保持原样，避免被 <p> 包裹后产生非法嵌套
            if (/^(?:@@ESPRINCODEBLOCK\d+@@\s*)+$/.test(p)) {
                return p;
            }
            // 如果块级元素开头，则不额外包 <p>
            if (/^<(?:h[1-6]|ul|ol|blockquote|hr|pre|div|table)/i.test(p)) {
                return p;
            }
            return `<p>${p.replace(/\r?\n/g, '<br>')}</p>`;
        }).filter(Boolean).join('\n');

        // 11. 恢复行内代码与代码块
        // 使用函数式替换，避免代码内容中的 $& $1 等被当作替换模式解析
        inlineCodes.forEach((code, idx) => {
            text = text.replace(INLINE_CODE_TOKEN(idx), () => code);
        });
        codeBlocks.forEach((block, idx) => {
            text = text.replace(CODE_BLOCK_TOKEN(idx), () => block);
        });

        return text;
    }
};
