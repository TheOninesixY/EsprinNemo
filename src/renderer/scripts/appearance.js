/* 外观与文本：主题（跟随系统 / 浅色 / 深色）、主题风格（默认 / Alom）与拼写检查开关 */

/* 主题风格（皮肤）：明暗主题决定"亮还是暗"，风格决定"长什么样"，两者互相独立。
   default 使用 tokens.css 里的内置配色；alom 由 alom.css 覆盖设计令牌。 */

// 可选值：default（内置风格）/ alom（Alom 风格）
const THEME_STYLE_VALUES = ['default', 'alom'];

function normalizeThemeStyle(value) {
    return THEME_STYLE_VALUES.includes(value) ? value : 'default';
}

// 只挂属性，具体配色交给 alom.css 的 :root[data-theme-style="alom"] 解析：
// 这样切换明暗主题或主题色时无需重新应用风格
function applyThemeStyle() {
    document.documentElement.dataset.themeStyle = normalizeThemeStyle(State.themeStyle);
}

function syncThemeStyleSelect() {
    const select = document.getElementById('setting-theme-style');
    if (select) select.value = normalizeThemeStyle(State.themeStyle);
}

// 切换主题风格：即时生效并写入 config.json（风格与明暗模式、主题色互相独立）
function setThemeStyle(value) {
    State.themeStyle = normalizeThemeStyle(value);
    applyThemeStyle();
    syncThemeStyleSelect();
    // 默认强调色随风格变化，取色器与色板需要同步刷新
    applyAccentColor();
    syncAccentControls();
    saveConfig();
    // 风格变化会改变配色，小本本窗口需要同步刷新
    syncScratchpadAppearance();
}

function initThemeStyle() {
    const select = document.getElementById('setting-theme-style');
    if (select) select.onchange = (e) => setThemeStyle(e.target.value);
    applyThemeStyle();
    syncThemeStyleSelect();
}

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

    // 强调色的浅色背景透明度随明暗主题变化，切换主题后需要重新计算
    applyAccentColor();

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

    syncScratchpadAppearance();
}

// 小本本（便利贴窗口）与应用观感保持一致：明暗主题、主题风格、主题色、圆角尺度或字体变化后同步给主进程，
// 由主进程转发给便利贴窗口；便利贴未打开时这次广播会被忽略，无副作用。
function syncScratchpadAppearance() {
    try {
        ipcRenderer.send('scratchpad:appearance', {
            theme: getEffectiveTheme(),
            style: normalizeThemeStyle(State.themeStyle),
            accent: normalizeAccentColor(State.accentColor),
            radius: normalizeCornerRadius(State.cornerRadius),
            // 字体同样要同步：否则主窗口换了界面字体，小本本还是旧字体（该函数来自 fonts.js，加载前先跳过）
            fonts: typeof normalizeFonts === 'function' ? normalizeFonts(State.fonts) : {}
        });
    } catch (err) {
        console.error('同步小本本外观失败:', err);
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

/* 左上角应用名文字颜色：品牌色 / 跟随明暗主题的黑白 / 跟随当前主题色 */

// 可选值：brand 为内置品牌色（样式表中的 --brand），mono 深色模式白字、浅色模式黑字，
// accent 跟随当前主题色；实际渲染由 tokens.css 中的 --brand-fg 按 <html data-brand-color> 决定。
const BRAND_COLOR_VALUES = ['brand', 'mono', 'accent'];

function normalizeBrandColor(value) {
    return BRAND_COLOR_VALUES.includes(value) ? value : 'brand';
}

// 只挂属性，颜色本身交给 CSS 解析：这样切换明暗主题或主题色时无需重复应用
function applyBrandColor() {
    document.documentElement.dataset.brandColor = normalizeBrandColor(State.brandColor);
}

function syncBrandColorSelect() {
    const select = document.getElementById('setting-brand-color');
    if (select) select.value = normalizeBrandColor(State.brandColor);
}

function setBrandColor(value) {
    State.brandColor = normalizeBrandColor(value);
    applyBrandColor();
    syncBrandColorSelect();
    saveConfig();
}

function initBrandColor() {
    const select = document.getElementById('setting-brand-color');
    if (select) select.onchange = (e) => setBrandColor(e.target.value);
    applyBrandColor();
    syncBrandColorSelect();
}

/* 圆角尺度：方（直角）/ 微圆角 / 默认 / 大
   与明暗主题、主题风格一样，这里只把选择挂在 <html data-radius>，
   具体像素由 styles/radius.css 换算成 --radius-* 令牌，因此可与任何风格组合。 */

// 可选值：square（方）/ slight（微圆角）/ default（默认）/ large（大）
const CORNER_RADIUS_VALUES = ['square', 'slight', 'default', 'large'];

function normalizeCornerRadius(value) {
    return CORNER_RADIUS_VALUES.includes(value) ? value : 'default';
}

/* 圆角尺度滑块：0 纯方 / 1 微圆角 / 2 默认 / 3 大圆，档位与 CORNER_RADIUS_VALUES 的下标一一对应。
   原生 range 只提供交互（拖动 / 点轨道 / 方向键），轨道、进度条与滑块都是自绘元素，
   位置写进 CSS 变量由 transition 补间，因此能做出"滑过去"的动效。 */

// 指针按住滑动时使用的步长：连续跟手，不吸附整档
const RADIUS_SLIDER_STEP = '0.01';

// 是否正被指针按住滑动：滑动期间只跟手、不落档，松手后再吸附到最近的档位
let radiusSliderDragging = false;

function cornerRadiusIndex(value) {
    return CORNER_RADIUS_VALUES.indexOf(normalizeCornerRadius(value));
}

function applyCornerRadius() {
    document.documentElement.dataset.radius = normalizeCornerRadius(State.cornerRadius);
}

// 把 0~1 的比例写进自绘滑块与进度条（非整档的比例就是滑动中的过渡位置）
function setRadiusSliderPosition(ratio) {
    const slider = document.getElementById('radius-slider');
    if (!slider) return;
    const clamped = Math.min(Math.max(ratio, 0), 1);
    slider.style.setProperty('--radius-pos', clamped.toFixed(4));
    slider.style.setProperty('--radius-fill', (clamped * 100).toFixed(2) + '%');
}

// 档位文字高亮：始终跟随当前档位，滑动过程中也不变
function markCornerRadiusTicks() {
    const current = normalizeCornerRadius(State.cornerRadius);
    document.querySelectorAll('#radius-ticks .radius-tick').forEach((tick) => {
        const active = tick.dataset.radius === current;
        tick.classList.toggle('active', active);
        tick.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

// 滑块位置、已选进度与档位文字高亮都按当前档位刷新
function syncCornerRadiusControl() {
    const current = normalizeCornerRadius(State.cornerRadius);
    const index = cornerRadiusIndex(current);
    const input = document.getElementById('setting-radius');
    if (input) input.value = String(index);
    setRadiusSliderPosition(index / (CORNER_RADIUS_VALUES.length - 1));
    markCornerRadiusTicks();
}

// 切换圆角尺度：即时生效并写入 config.json（与主题风格、明暗主题互不影响）
function setCornerRadius(value) {
    State.cornerRadius = normalizeCornerRadius(value);
    applyCornerRadius();
    syncCornerRadiusControl();
    saveConfig();
    // 小本本窗口同步换圆角，保持两个窗口观感一致
    syncScratchpadAppearance();
}

// 把滑块上的任意值（含滑动中的小数）四舍五入到最近的档位
function radiusSliderStopValue(value) {
    const index = Math.min(Math.max(Math.round(Number(value)), 0), CORNER_RADIUS_VALUES.length - 1);
    return CORNER_RADIUS_VALUES[index];
}

/* 指针滑动：按住期间取消整档吸附——滑块连续跟手、圆角与档位文字保持不变，
   松手后自动吸附到最近的档位并应用；此时 is-dragging 已移除，滑块会带补间滑过去。 */
function initRadiusSliderDrag() {
    const slider = document.getElementById('radius-slider');
    const input = document.getElementById('setting-radius');
    if (!slider || !input) return;

    input.addEventListener('pointerdown', () => {
        radiusSliderDragging = true;
        // 滑动期间按连续值上报（鼠标移多少走多少），松手时再回到整档
        input.step = RADIUS_SLIDER_STEP;
        slider.classList.add('is-dragging');
    });

    const endDrag = () => {
        if (!radiusSliderDragging) return;
        radiusSliderDragging = false;
        const nearest = radiusSliderStopValue(input.value);
        // 先恢复整档与补间，再应用档位：这一步的位置变化就是"滑到最近档位"的动效
        input.step = '1';
        slider.classList.remove('is-dragging');
        setCornerRadius(nearest);
    };

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // 在窗口外松开鼠标时收不到 pointerup：失焦同样按松手处理，免得多动几下时"没落档"
    window.addEventListener('blur', endDrag);
}

function initCornerRadius() {
    const input = document.getElementById('setting-radius');
    if (input) {
        input.oninput = (event) => {
            // 指针按住滑动中：只让滑块跟手，不设置档位（落档交给松手时的吸附）
            if (radiusSliderDragging) {
                setRadiusSliderPosition(Number(event.target.value) / (CORNER_RADIUS_VALUES.length - 1));
                return;
            }
            // 点轨道 / 方向键：range 的值就是档位下标
            setCornerRadius(CORNER_RADIUS_VALUES[Number(event.target.value)] || 'default');
        };
        initRadiusSliderDrag();
    }
    // 直接点档位文字同样可跳到该档
    document.querySelectorAll('#radius-ticks .radius-tick').forEach((tick) => {
        tick.onclick = () => setCornerRadius(tick.dataset.radius);
    });
    applyCornerRadius();
    syncCornerRadiusControl();
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
