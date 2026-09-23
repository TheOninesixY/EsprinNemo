/* 外观与文本：主题（跟随系统 / 浅色 / 深色）、主题风格（默认 / Alom）与拼写检查开关 */

/* 主题风格（皮肤）：明暗主题决定"亮还是暗"，风格决定"长什么样"，两者互相独立。
   default 使用 tokens.css 里的内置配色；alom 由 alom.css 覆盖设计令牌。 */

// 可选值：default（内置风格）/ alom（Alom 风格）
const THEME_STYLE_VALUES = ['default', 'alom'];

/* 换肤交叉淡入（样式见 styles/motion.css 的 html.appearance-fading）：
   切换明暗主题 / 界面风格时，整棵界面用 0.25s 过渡到新配色，而不是整屏硬切。

   顺序是关键：先挂类、强制刷一次样式，之后才真正改配色 / 属性。
   若把挂类和改配色放在同一次样式计算里，浏览器会认为「变化前没有过渡」，动效不会发生。
   强制刷新用读 offsetWidth 触发（只这一次，代价可以忽略）。 */
const APPEARANCE_FADE_CLASS = 'appearance-fading';
// 与 motion.css 里 --motion-crossfade 一致；多留 60ms 再摘类，避免过渡被提前掐断
const APPEARANCE_FADE_MS = 250;
let appearanceFadeTimer = null;
// 外观是否已经应用过一次：用来区分「启动」与「用户切换」
let themeAppliedOnce = false;

function beginAppearanceFade() {
    const root = document.documentElement;
    root.classList.add(APPEARANCE_FADE_CLASS);
    void root.offsetWidth;
    if (appearanceFadeTimer) clearTimeout(appearanceFadeTimer);
    appearanceFadeTimer = setTimeout(() => {
        appearanceFadeTimer = null;
        root.classList.remove(APPEARANCE_FADE_CLASS);
    }, APPEARANCE_FADE_MS + 60);
}

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
    // 换风格是大面积换色，先铺好交叉淡入再改属性
    beginAppearanceFade();
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

/* 明暗模式：跟随系统 / 浅色 / 深色（config.json 的 theme）。
   标题栏的主题按钮与设置里的下拉是同一份状态：按钮循环切换、下拉直接指定，
   两处都落到 State.theme，因此改了哪一边，另一边都会立即同步。 */

const THEME_MODE_VALUES = ['system', 'light', 'dark'];

function normalizeThemeMode(value) {
    return THEME_MODE_VALUES.includes(value) ? value : 'system';
}

// 把当前明暗模式写回下拉；存在性判断保证小本本等没有该控件的页面也不会报错
function syncThemeModeSelect() {
    const select = document.getElementById('setting-theme-mode');
    if (select) select.value = normalizeThemeMode(State.theme);
}

// 从设置里切换明暗模式：应用 → 刷新下拉 → 写配置（与标题栏按钮同一套结果）
function setThemeMode(value) {
    State.theme = normalizeThemeMode(value);
    applyTheme();
    syncThemeModeSelect();
    saveConfig();
}

function initThemeMode() {
    const select = document.getElementById('setting-theme-mode');
    if (select) select.onchange = (event) => setThemeMode(event.target.value);
    // 首屏已由 initTheme 应用过一次，这里只对齐控件
    syncThemeModeSelect();
}

function applyTheme() {
    // 启动时的首次应用不算「切换」（此时界面还没画出来），不做交叉淡入
    if (themeAppliedOnce) beginAppearanceFade();
    themeAppliedOnce = true;

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
        if (themeBtn) themeBtn.title = '主题：跟随系统（点击切换到浅色）';
    } else if (State.theme === 'light') {
        if (themeIcon) themeIcon.textContent = 'light_mode';
        if (themeBtn) themeBtn.title = '主题：浅色模式（点击切换到深色）';
    } else {
        if (themeIcon) themeIcon.textContent = 'dark_mode';
        if (themeBtn) themeBtn.title = '主题：深色模式（点击切换到跟随系统）';
    }

    // 设置里的「明暗模式」下拉跟着标题栏按钮一起走（函数声明在后方，可直接调用）
    syncThemeModeSelect();
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

/* 圆角尺度滑块：0 纯方 / 1 微圆角 / 2 默认 / 3 大圆，档位与 CORNER_RADIUS_VALUES 的下标一一对应。 */

function cornerRadiusIndex(value) {
    return CORNER_RADIUS_VALUES.indexOf(normalizeCornerRadius(value));
}

function applyCornerRadius() {
    document.documentElement.dataset.radius = normalizeCornerRadius(State.cornerRadius);
}

/* 自绘滑块（styles/settings.css 的 .settings-slider）：原生 range 只提供交互
   （拖动 / 点轨道 / 方向键），轨道、进度条与滑块都是自绘元素，位置写进 CSS 变量
   由 transition 补间，因此能做出「滑过去」的动效。圆角尺度与界面尺寸共用这套交互。 */

// 指针按住滑动时使用的步长：连续跟手，不吸附整档
const SLIDER_DRAG_STEP = '0.01';

// 把 0~1 的比例写进自绘滑块与进度条（非整档的比例就是滑动中的过渡位置）
function setSliderPosition(slider, ratio) {
    if (!slider) return;
    const clamped = Math.min(Math.max(ratio, 0), 1);
    slider.style.setProperty('--slider-pos', clamped.toFixed(4));
    slider.style.setProperty('--slider-fill', (clamped * 100).toFixed(2) + '%');
}

// 档位文字高亮：始终跟随当前档位，滑动过程中也不变（各档的 data-value 与设置值同域）
function markSliderTicks(slider, current) {
    if (!slider) return;
    slider.querySelectorAll('.slider-tick').forEach((tick) => {
        const active = tick.dataset.value === String(current);
        tick.classList.toggle('active', active);
        tick.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

/* 滑块交互：按住期间取消整档吸附——滑块连续跟手、设置值与档位文字保持不变；
   松手（含在窗口外松开、窗口失焦）后恢复整档并吸附到最近的档位。

   onCommit 拿到的是原生 range 的原始值：点轨道 / 方向键时是一个整档，
   滑动松手时是滑动中的小数，点档位文字时则是该档的 data-value。 */
function initSliderControl({ sliderId, inputId, restStep, ratioOf, onCommit }) {
    const slider = document.getElementById(sliderId);
    const input = document.getElementById(inputId);
    if (!slider || !input) return;

    let dragging = false;

    input.oninput = (event) => {
        // 指针按住滑动中：只让滑块跟手，不落档（落档交给松手时的吸附）
        if (dragging) {
            setSliderPosition(slider, ratioOf(Number(event.target.value)));
            return;
        }
        // 点轨道 / 方向键：range 的当前值就是一个整档
        onCommit(event.target.value);
    };

    input.addEventListener('pointerdown', () => {
        dragging = true;
        // 滑动期间按连续值上报（鼠标移多少走多少），松手时再回到整档
        input.step = SLIDER_DRAG_STEP;
        slider.classList.add('is-dragging');
    });

    const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        // 先恢复整档与补间，再落档：这一步的位置变化就是「滑到最近档位」的动效
        input.step = restStep;
        slider.classList.remove('is-dragging');
        onCommit(input.value);
    };

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // 在窗口外松开鼠标时收不到 pointerup：失焦同样按松手处理，免得多动几下时"没落档"
    window.addEventListener('blur', endDrag);

    // 直接点档位文字同样可跳到该档
    slider.querySelectorAll('.slider-tick').forEach((tick) => {
        tick.onclick = () => onCommit(tick.dataset.value);
    });
}

// 把滑块上的任意值（含滑动中的小数）四舍五入到最近的档位
function radiusSliderStopValue(value) {
    const index = Math.min(Math.max(Math.round(Number(value)), 0), CORNER_RADIUS_VALUES.length - 1);
    return CORNER_RADIUS_VALUES[index];
}

// 滑块位置、已选进度与档位文字高亮都按当前档位刷新
function syncCornerRadiusControl() {
    const current = normalizeCornerRadius(State.cornerRadius);
    const index = cornerRadiusIndex(current);
    const input = document.getElementById('setting-radius');
    if (input) input.value = String(index);
    const slider = document.getElementById('radius-slider');
    setSliderPosition(slider, index / (CORNER_RADIUS_VALUES.length - 1));
    markSliderTicks(slider, current);
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

function initCornerRadius() {
    initSliderControl({
        sliderId: 'radius-slider',
        inputId: 'setting-radius',
        // 松手后回到整档：档位下标是整数
        restStep: '1',
        // range 的值就是档位下标（拖动中是小数），换算成 0~1 的滑块位置
        ratioOf: (value) => value / (CORNER_RADIUS_VALUES.length - 1),
        // 落档：数值来自 range（下标，可能是拖动中的小数），文字来自档位按钮（档位名）
        onCommit: (raw) => {
            const index = Number(raw);
            setCornerRadius(Number.isFinite(index) ? radiusSliderStopValue(index) : raw);
        }
    });
    applyCornerRadius();
    syncCornerRadiusControl();
}

/* 界面尺寸（缩放比例）：直接改 Chromium 缩放（webFrame.setZoomFactor），
   取值规则与首屏应用都在 boot.js 的 UI_SCALE_*（那片脚本先于本文件执行）。

   只作用于主窗口：弹窗要按内容量好高度再改窗口大小，小本本按固定尺寸停靠在屏幕角落，
   这两扇窗口跟着缩放的话，各自的尺寸换算都得按比例重算一遍。 */

// 五个档位（数值即缩放比例，档位文字见 main.html 的 #ui-scale-ticks）：
// 小 80% / 中 90% / 默认 100% / 大 110% / 超大 120%，与圆角尺度一样只给整档
const UI_SCALE_STOPS = [0.8, 0.9, 1, 1.1, 1.2];

// 自定义比例的输入范围（百分比）：沿用 boot.js 的缩放范围
const UI_SCALE_CUSTOM_LABEL = `${Math.round(UI_SCALE_MIN * 100)} ~ ${Math.round(UI_SCALE_MAX * 100)}`;

// 自定义比例的确认窗口停留时长：到点没有回应就回到默认，
// 免得界面停在一个用户没点头认可的比例上
const UI_SCALE_CUSTOM_CONFIRM_MS = 10000;

// 离当前值最近的档位下标：整档自然是自己，自定义比例就近落位（此时档位文字不会高亮）
function nearestUiScaleStopIndex(value) {
    const current = normalizeUiScale(value);
    return UI_SCALE_STOPS.reduce((best, stop, index) => (
        Math.abs(stop - current) < Math.abs(UI_SCALE_STOPS[best] - current) ? index : best
    ), 0);
}

// 当前值是否正好落在某个整档上（自定义比例不算）
function isUiScaleStop(value) {
    const current = normalizeUiScale(value);
    return UI_SCALE_STOPS.some((stop) => Math.abs(stop - current) < 0.0001);
}

// 档位下标 → 0~1 的滑块位置（拖动中是小数，滑块也就连续跟手）
function uiScaleRatio(index) {
    return Number(index) / (UI_SCALE_STOPS.length - 1);
}

// 把滑块上的任意值（含滑动中的小数）四舍五入到最近的档位，换算成缩放比例
function uiScaleSliderStopValue(value) {
    const index = Math.min(Math.max(Math.round(Number(value)), 0), UI_SCALE_STOPS.length - 1);
    return UI_SCALE_STOPS[index];
}

function applyUiScale() {
    const scale = normalizeUiScale(State.uiScale);
    try {
        webFrame.setZoomFactor(scale);
    } catch (err) {
        console.error('应用界面尺寸失败:', err);
    }
    // 界面放大后，同一扇窗口里的可用宽度按比例变小，窗口的最小尺寸也要跟着变
    //（由主进程换算，见 src/main/main.js；主窗口还没就绪时这次通知会被忽略，无副作用）
    ipcRenderer.invoke('window:ui-scale', scale).catch(() => {});
}

// 自定义比例输入框：只在「当前值不是整档」时写回数字，其余时候留空
function syncUiScaleCustomInput(current) {
    const el = document.getElementById('ui-scale-custom');
    if (!el) return;
    // 用户正在里面输入时不动它：同步也可能由别处触发（拖滑块、切换数据目录）
    if (document.activeElement === el) return;
    el.value = isUiScaleStop(current) ? '' : String(Math.round(current * 100));
}

// 滑块位置、进度条、百分比徽标、档位文字高亮与自定义输入框都按当前缩放刷新
function syncUiScaleControl() {
    const current = normalizeUiScale(State.uiScale);
    const slider = document.getElementById('ui-scale-slider');
    const input = document.getElementById('setting-ui-scale');
    const readout = document.getElementById('ui-scale-value');
    // 原生 range 的值是档位下标；自定义比例没有对应档位，就近落位且不高亮任何档位文字（-1 谁都对不上）
    if (input) input.value = String(nearestUiScaleStopIndex(current));
    if (readout) readout.textContent = Math.round(current * 100) + '%';
    setSliderPosition(slider, uiScaleRatio(nearestUiScaleStopIndex(current)));
    markSliderTicks(slider, isUiScaleStop(current) ? nearestUiScaleStopIndex(current) : -1);
    // 不在整档上（自定义比例）时展开输入行，用户一进来就看得到那个值
    if (!isUiScaleStop(current)) setUiScaleCustomOpen(true);
    syncUiScaleCustomInput(current);
}

// 应用并刷新界面，但不写配置：自定义比例要先让用户看到效果，确认之后才落盘
function previewUiScale(value) {
    State.uiScale = normalizeUiScale(value);
    applyUiScale();
    syncUiScaleControl();
}

// 切换界面尺寸：即时生效并写入 config.json（取值整理会夹到范围内、对齐到整数百分比）
function setUiScale(value) {
    previewUiScale(value);
    saveConfig();
}

/* 自定义比例：输入 50~200 之间的整数百分比。
   先把输入值套到界面上（用户能直接看到效果），再弹窗问是否保留；
   点「保持」才写进配置，点「回到默认」或十秒内没有回应都回到默认的 100%——
   自定义比例是这五档之外的尺寸，回退时按默认处理最不容易让人找不回原样。 */
async function commitCustomUiScale() {
    const el = document.getElementById('ui-scale-custom');
    if (!el) return;

    const text = el.value.trim();
    const raw = Number(text);
    if (!text || !Number.isFinite(raw)) {
        showToast(`请输入 ${UI_SCALE_CUSTOM_LABEL} 之间的数字`);
        syncUiScaleCustomInput(normalizeUiScale(State.uiScale));
        return;
    }

    // 夹到范围内并取整：输入 320 按 200% 处理，输入 133.6 按 134% 处理
    const percent = Math.min(Math.max(Math.round(raw), Math.round(UI_SCALE_MIN * 100)), Math.round(UI_SCALE_MAX * 100));
    el.value = String(percent);

    // 与当前值相同时不必再确认（这一档本来就该是当前状态）
    if (percent === Math.round(normalizeUiScale(State.uiScale) * 100)) {
        setUiScale(percent / 100);
        return;
    }

    previewUiScale(percent / 100);

    const seconds = Math.round(UI_SCALE_CUSTOM_CONFIRM_MS / 1000);
    const keep = await showConfirm(`保留界面尺寸 ${percent}%？`, {
        title: '保持更改',
        detail: `界面已按 ${percent}% 缩放，确认后写入设置：\n`
            + `· 点「保持」：沿用 ${percent}%；\n`
            + `· 点「回到默认」，或 ${seconds} 秒内未确认：恢复为默认的 100%。`,
        confirmLabel: '保持',
        cancelLabel: '回到默认',
        // 弹窗自带倒计时，到点自动按「取消」处理（见 main/dialog_window.js）
        timeoutMs: UI_SCALE_CUSTOM_CONFIRM_MS
    });

    if (keep) {
        setUiScale(percent / 100);
        // 输入框里可能还留着刚才那个数字（它正被聚焦时同步会跳过它），这里显式对齐一次
        el.value = isUiScaleStop(percent / 100) ? '' : String(percent);
        showToast(`缩放比例已设为 ${percent}%`);
        return;
    }
    setUiScale(UI_SCALE_DEFAULT);
    el.value = '';
    showToast('缩放比例已恢复为默认 100%');
}

/* 自定义比例：平时收在「缩放比例」那一行的「自定义」按钮后面，点开才展开输入行；
   当前值不在整档上（配置里存着 113% 这类尺寸）时默认展开，
   否则用户进来会看不到自己设的值。展开状态不落盘：它只是这一屏的展开 / 收起。 */

function setUiScaleCustomOpen(open) {
    const row = document.getElementById('ui-scale-custom-row');
    if (row) row.classList.toggle('hidden', !open);
    const toggle = document.getElementById('btn-ui-scale-custom-toggle');
    if (toggle) {
        toggle.classList.toggle('active', !!open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
}

function toggleUiScaleCustomRow() {
    const row = document.getElementById('ui-scale-custom-row');
    const open = !!row && row.classList.contains('hidden');
    setUiScaleCustomOpen(open);
    // 展开后直接落焦到输入框，省得再点一下
    if (open) {
        const input = document.getElementById('ui-scale-custom');
        if (input) input.focus();
    }
}

// 自定义比例输入框：回车与「应用」都能提交，输入期间只保留数字
function initUiScaleCustomInput() {
    const el = document.getElementById('ui-scale-custom');
    const button = document.getElementById('btn-ui-scale-custom');
    if (el) {
        el.oninput = () => {
            const digits = el.value.replace(/[^0-9]/g, '').slice(0, 3);
            if (digits !== el.value) el.value = digits;
        };
        el.onkeydown = (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commitCustomUiScale();
        };
    }
    if (button) button.onclick = () => commitCustomUiScale();
    const toggle = document.getElementById('btn-ui-scale-custom-toggle');
    if (toggle) toggle.onclick = () => toggleUiScaleCustomRow();
}

function initUiScale() {
    initSliderControl({
        sliderId: 'ui-scale-slider',
        inputId: 'setting-ui-scale',
        // 松手后回到整档：档位下标是整数
        restStep: '1',
        // range 的值就是档位下标（拖动中是小数），换算成 0~1 的滑块位置
        ratioOf: uiScaleRatio,
        // 落档：数值来自 range 与档位按钮，都是档位下标
        onCommit: (raw) => setUiScale(uiScaleSliderStopValue(raw))
    });
    initUiScaleCustomInput();
    // 首屏已由 boot.js 缩放过一次，这里再落一次即可（取值相同，不会二次跳动），
    // 同时把窗口最小尺寸同步给主进程——数据目录切换后缩放比例可能已经变了
    applyUiScale();
    syncUiScaleControl();
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
