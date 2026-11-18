const SAFE_LINK_SCHEME = /^(?:https?|mailto|tel):$/;

const LINK_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/;

const LINK_INVISIBLE_PATTERN = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g;

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

function escapeLinkAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function sanitizeLinkUrl(raw) {
    const decoded = decodeLinkEntities(raw).trim();
    if (!decoded) return '';
    const compact = decoded.replace(LINK_INVISIBLE_PATTERN, '').toLowerCase();
    const scheme = compact.match(LINK_SCHEME_PATTERN);
    if (scheme && !SAFE_LINK_SCHEME.test(scheme[0])) return '';
    return escapeLinkAttribute(decoded);
}
function resolveMediaSrc(raw) {
    const decoded = decodeLinkEntities(raw).trim();
    if (!decoded) return '';
    const compact = decoded.replace(LINK_INVISIBLE_PATTERN, '').toLowerCase();
    const scheme = compact.match(LINK_SCHEME_PATTERN);
    if (scheme) {
        if (scheme[0] === 'http:' || scheme[0] === 'https:' || scheme[0] === 'data:' || scheme[0] === 'file:') {
            return escapeLinkAttribute(decoded);
        }
        return '';
    }
    return escapeLinkAttribute(decoded);
}

const marked = {
    parse(value = '') {
        if (!value) return '';
        const CODE_BLOCK_TOKEN = (i) => `@@ESPRINCODEBLOCK${i}@@`;
        const INLINE_CODE_TOKEN = (i) => `@@ESPRININLINECODE${i}@@`;
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
        text = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

text = text
            .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
            .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
            .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
            .replace(/^### (.*)$/gm, '<h3>$1</h3>')
            .replace(/^## (.*)$/gm, '<h2>$1</h2>')
            .replace(/^# (.*)$/gm, '<h1>$1</h1>');

text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr>');

text = text.replace(
            /(^[ \t]*\|?[^\r\n|]*(?:\|[^\r\n|]*)+[ \t]*\|?[ \t]*\r?\n)(^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*\r?\n)((?:^[ \t]*\|?[^\r\n|]*(?:\|[^\r\n|]*)+[ \t]*\|?[ \t]*(?:\r?\n|$))*)/gm,
            (block, headerRow, dividerRow, bodyRows) => {

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

                return `\n\n<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>\n\n`;
            }
        );

text = text.replace(/(?:^&gt; ?[^\r\n]*(?:\r?\n|$))+/gm, (block) => {
            const inner = block
                .split(/\r?\n/)
                .filter(line => line.length > 0)
                .map(line => line.replace(/^&gt; ?/, ''))
                .join('<br>');
            return `<blockquote><p>${inner}</p></blockquote>\n`;
        });

text = text.replace(/^- \[ \] (.*)$/gm, '<li class="task-item"><input type="checkbox" disabled> $1</li>');
        text = text.replace(/^- \[x\] (.*)$/gm, '<li class="task-item"><input type="checkbox" checked disabled> $1</li>');
        text = text.replace(/^[-*+] (.*)$/gm, '<li>$1</li>');
        text = text.replace(/^\d+\. (.*)$/gm, '<li class="ordered">$1</li>');

text = text.replace(/(?:<li class="ordered">.*?<\/li>\s*)+/g, '<ol>$&</ol>');
        text = text.replace(/(?:<li>.*?<\/li>\s*|<li class="task-item">.*?<\/li>\s*)+/g, '<ul>$&</ul>');

text = text
            .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.+?)__/g, '<strong>$1</strong>')
            .replace(/\*([^\*\n]+?)\*/g, '<em>$1</em>')

.replace(/(^|[^\w])_([^_\n]+?)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>')
            .replace(/~~(.+?)~~/g, '<del>$1</del>')

            .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
                const src = resolveMediaSrc(url);
                const safeAlt = escapeLinkAttribute(alt || '');
                const rawUrl = escapeLinkAttribute(url || '');
                return src
                    ? `<img class="md-image" src="${src}" alt="${safeAlt}" data-src="${rawUrl}" loading="lazy" />`
                    : safeAlt;
            })

            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
                const safeUrl = sanitizeLinkUrl(url);
                return safeUrl
                    ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" data-raw-href="${escapeLinkAttribute(url)}">${label}</a>`
                    : label;
            });

text = text.replace(/[ \t]*@@ESPRINCODEBLOCK(\d+)@@[ \t]*/g, (match, idx) => `\n\n@@ESPRINCODEBLOCK${idx}@@\n\n`);
        const paragraphs = text.split(/(?:\r?\n){2,}/);
        text = paragraphs.map(p => {
            p = p.trim();
            if (!p) return '';

            if (/^(?:@@ESPRINCODEBLOCK\d+@@\s*)+$/.test(p)) {
                return p;
            }

            if (/^<(?:h[1-6]|ul|ol|blockquote|hr|pre|div|table)/i.test(p)) {
                return p;
            }
            return `<p>${p.replace(/\r?\n/g, '<br>')}</p>`;
        }).filter(Boolean).join('\n');

inlineCodes.forEach((code, idx) => {
            text = text.replace(INLINE_CODE_TOKEN(idx), () => code);
        });
        codeBlocks.forEach((block, idx) => {
            text = text.replace(CODE_BLOCK_TOKEN(idx), () => block);
        });

        return text;
    }
};
