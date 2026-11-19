function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function safeHref(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
    if (/^[./#]/.test(value)) return value;
    return '';
}

function renderInline(text, codes) {
    let out = escapeHtml(text);

    out = out.replace(/`([^`]+)`/g, (_, code) => {
        codes.push(`<code>${code}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
    });

    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
        const href = safeHref(src);
        return href ? `<img src="${href}" alt="${alt}" loading="lazy">` : alt;
    });

    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
        const url = safeHref(href);
        return url ? `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>` : label;
    });

    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    return out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)] || '');
}

export function renderMarkdown(source) {
    const lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n');
    const codes = [];
    const blocks = [];

    let paragraph = [];
    let list = null;
    let quote = [];
    let fence = null;
    let fenceLines = [];

    const flushParagraph = () => {
        if (!paragraph.length) return;
        blocks.push(`<p>${paragraph.map((line) => renderInline(line, codes)).join('<br>')}</p>`);
        paragraph = [];
    };

    const flushList = () => {
        if (!list) return;
        const items = list.items.map((item) => {
            if (item.task !== null) {
                const checked = item.task ? ' done' : '';
                const box = `<span class="md-task${checked}">${item.task ? '✓' : ''}</span>`;
                return `<li class="task-item${checked}">${box}<span>${renderInline(item.text, codes)}</span></li>`;
            }
            return `<li>${renderInline(item.text, codes)}</li>`;
        }).join('');
        blocks.push(`<${list.tag}>${items}</${list.tag}>`);
        list = null;
    };

    const flushQuote = () => {
        if (!quote.length) return;
        const inner = quote.map((line) => renderInline(line, codes)).join('<br>');
        blocks.push(`<blockquote>${inner}</blockquote>`);
        quote = [];
    };

    const flushAll = () => {
        flushParagraph();
        flushList();
        flushQuote();
    };

    for (const rawLine of lines) {
        const line = rawLine.replace(/\t/g, '    ');

        if (fence) {
            if (/^\s*```/.test(line)) {
                const label = fence.trim();
                blocks.push(`<pre data-lang="${escapeHtml(label)}"><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
                fence = null;
                fenceLines = [];
            } else {
                fenceLines.push(rawLine);
            }
            continue;
        }

        const fenceMatch = /^\s*```(.*)$/.exec(line);
        if (fenceMatch) {
            flushAll();
            fence = fenceMatch[1] || '';
            continue;
        }

        if (!line.trim()) {
            flushAll();
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            flushAll();
            const level = heading[1].length;
            blocks.push(`<h${level}>${renderInline(heading[2].trim(), codes)}</h${level}>`);
            continue;
        }

        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
            flushAll();
            blocks.push('<hr>');
            continue;
        }

        const quoted = /^\s*>\s?(.*)$/.exec(line);
        if (quoted) {
            flushParagraph();
            flushList();
            quote.push(quoted[1]);
            continue;
        }

        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
        if (bullet || ordered) {
            flushParagraph();
            flushQuote();
            const tag = bullet ? 'ul' : 'ol';
            const text = bullet ? bullet[2] : ordered[3];
            if (!list || list.tag !== tag) {
                flushList();
                list = { tag, items: [] };
            }
            const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
            if (task) {
                list.items.push({ text: task[2], task: task[1].toLowerCase() === 'x' });
            } else {
                list.items.push({ text, task: null });
            }
            continue;
        }

        flushList();
        flushQuote();
        paragraph.push(line.trim());
    }

    if (fence) {
        blocks.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
    }
    flushAll();

    return blocks.join('\n');
}
