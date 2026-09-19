/* 轻量 Markdown 渲染器（代码块、引用块、列表、任务清单、标题、链接、粗斜体、水平线、行内代码） */

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

        // 6. 引用块解析（支持多行连续引用）
        text = text.replace(/(?:^&gt; ?[^\r\n]*(?:\r?\n|$))+/gm, (block) => {
            const inner = block
                .split(/\r?\n/)
                .filter(line => line.length > 0)
                .map(line => line.replace(/^&gt; ?/, ''))
                .join('<br>');
            return `<blockquote><p>${inner}</p></blockquote>\n`;
        });

        // 7. 任务清单与普通列表项
        text = text.replace(/^- \[ \] (.*)$/gm, '<li class="task-item"><input type="checkbox" disabled> $1</li>');
        text = text.replace(/^- \[x\] (.*)$/gm, '<li class="task-item"><input type="checkbox" checked disabled> $1</li>');
        text = text.replace(/^[-*+] (.*)$/gm, '<li>$1</li>');
        text = text.replace(/^\d+\. (.*)$/gm, '<li class="ordered">$1</li>');

        // 将连续的 <li> 包裹在 <ul> 或 <ol> 中
        text = text.replace(/(<li class="ordered">[\s\S]*?<\/li>)(?=(?:\s*<li class="ordered">)|\b)/g, '$1');
        text = text.replace(/(?:<li class="ordered">.*?<\/li>\s*)+/g, '<ol>$&</ol>');
        text = text.replace(/(?:<li>.*?<\/li>\s*|<li class="task-item">.*?<\/li>\s*)+/g, '<ul>$&</ul>');

        // 8. 粗体、斜体、删除线与链接
        text = text
            .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.+?)__/g, '<strong>$1</strong>')
            .replace(/\*([^\*\n]+?)\*/g, '<em>$1</em>')
            .replace(/_([^_\n]+?)_/g, '<em>$1</em>')
            .replace(/~~(.+?)~~/g, '<del>$1</del>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

        // 9. 段落与换行处理
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

        // 10. 恢复行内代码与代码块
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
