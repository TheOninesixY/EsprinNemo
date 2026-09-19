/* 外观与文本：主题（跟随系统 / 浅色 / 深色）与拼写检查开关 */

function getEffectiveTheme() {
    if (State.theme === 'system') {
        return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    return State.theme;
}

function applyTheme() {
    const effective = getEffectiveTheme();
    if (effective === 'light') {
        document.documentElement.classList.add('light');
    } else {
        document.documentElement.classList.remove('light');
    }

    const themeIcon = document.getElementById('theme-icon');
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (State.theme === 'system') {
        if (themeIcon) themeIcon.textContent = 'computer';
        if (themeBtn) themeBtn.title = '主题：跟随系统 (点击切换到浅色)';
    } else if (State.theme === 'light') {
        if (themeIcon) themeIcon.textContent = 'light_mode';
        if (themeBtn) themeBtn.title = '主题：浅色模式 (点击切换到深色)';
    } else {
        if (themeIcon) themeIcon.textContent = 'dark_mode';
        if (themeBtn) themeBtn.title = '主题：深色模式 (点击切换到跟随系统)';
    }
}

// 受"错词红波浪线检查"开关控制的可编辑区域（笔记标题 + 正文）
const SPELLCHECK_TARGET_IDS = ['input-note-title', 'textarea-note-content'];

// 清除已绘制的波浪线：Blink 在 spellcheck 属性变更时不会主动丢弃既有拼写标记，
// 只有文本内容发生一次真实变更才会失效，因此这里先清空再写回原文。
function clearSpellcheckMarkers(el) {
    const wasFocused = document.activeElement === el;
    const selStart = el.selectionStart;
    const selEnd = el.selectionEnd;
    const scrollTop = el.scrollTop;
    const value = el.value;

    el.value = '';
    el.value = value;

    el.scrollTop = scrollTop;
    if (wasFocused) {
        el.focus();
        try {
            el.setSelectionRange(selStart, selEnd);
        } catch (err) {
            // 个别输入类型不支持选区，忽略即可
        }
    }
}

function applySpellcheck() {
    const enabled = !!State.spellcheck;
    const toggle = document.getElementById('setting-spellcheck');
    if (toggle) toggle.checked = enabled;

    SPELLCHECK_TARGET_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        // 属性已与设置一致时跳过，避免每次渲染都重置内容与撤销历史
        if (el.spellcheck === enabled) return;
        el.spellcheck = enabled;
        // 仅在关闭时清理，开启时的标记会由浏览器在聚焦/输入时自然生成
        if (!enabled) clearSpellcheckMarkers(el);
    });
}

function initTheme() {
    applyTheme();
    if (window.matchMedia) {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        // 监听系统深浅色切换事件
        if (mediaQuery.addEventListener) {
            mediaQuery.addEventListener('change', () => {
                if (State.theme === 'system') {
                    applyTheme();
                }
            });
        } else if (mediaQuery.addListener) {
            mediaQuery.addListener(() => {
                if (State.theme === 'system') {
                    applyTheme();
                }
            });
        }
    }
}
