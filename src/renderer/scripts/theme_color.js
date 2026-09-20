/* 主题色（强调色）个性化：预设色板、自定义取色，并把派生色写入 CSS 变量 */

// 预设色板：空字符串表示"跟随主题"，使用样式表中内置的默认强调色
const ACCENT_PRESETS = [
    { name: '跟随主题', value: '' },
    { name: '天际蓝', value: '#58A6FF' },
    { name: '海洋蓝', value: '#0969DA' },
    { name: '紫罗兰', value: '#8250DF' },
    { name: '洋红', value: '#BF3989' },
    { name: '珊瑚红', value: '#E5534B' },
    { name: '琥珀橙', value: '#BC4C00' },
    { name: '丛林绿', value: '#1A7F37' },
    { name: '青竹', value: '#0F766E' },
    { name: '石墨灰', value: '#6E7781' }
];

// 强调色底面上的文字色：浅色强调色改用深色文字，避免白字看不清
const ACCENT_TEXT_ON_DARK = '#ffffff';
const ACCENT_TEXT_ON_LIGHT = '#1f2328';
// 相对亮度高于该阈值时认为强调色偏浅
const ACCENT_LIGHT_TEXT_THRESHOLD = 0.6;

// 强调色的浅色背景（选中态、标签底）：深浅主题下透明度不同，与内置默认值保持一致
const ACCENT_BG_ALPHA_DARK = 0.15;
const ACCENT_BG_ALPHA_LIGHT = 0.1;

// 接受 #RGB / #RRGGBB，井号可省略
const ACCENT_HEX_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// 规范化主题色：统一为 #RRGGBB 大写形式；非法值返回空字符串（表示跟随主题）
function normalizeAccentColor(value) {
    if (typeof value !== 'string') return '';
    const matched = value.trim().match(ACCENT_HEX_PATTERN);
    if (!matched) return '';
    let hex = matched[1];
    // #ABC 展开为 #AABBCC
    if (hex.length === 3) hex = hex.split('').map(char => char + char).join('');
    return `#${hex.toUpperCase()}`;
}

// #RRGGBB -> { r, g, b }，非法输入返回 null
function accentColorToRgb(hex) {
    const normalized = normalizeAccentColor(hex);
    if (!normalized) return null;
    return {
        r: parseInt(normalized.slice(1, 3), 16),
        g: parseInt(normalized.slice(3, 5), 16),
        b: parseInt(normalized.slice(5, 7), 16)
    };
}

// 按 sRGB 加权亮度判断该强调色上应该用深色还是浅色文字
function accentForegroundColor(hex) {
    const rgb = accentColorToRgb(hex);
    if (!rgb) return ACCENT_TEXT_ON_DARK;
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return luminance > ACCENT_LIGHT_TEXT_THRESHOLD ? ACCENT_TEXT_ON_LIGHT : ACCENT_TEXT_ON_DARK;
}

function isLightThemeActive() {
    return document.documentElement.classList.contains('light');
}

// 写入 CSS 变量；未设置主题色时移除内联覆盖，回落到样式表中的默认强调色
function applyAccentColor() {
    const rootStyle = document.documentElement.style;
    const hex = normalizeAccentColor(State.accentColor);
    if (!hex) {
        rootStyle.removeProperty('--accent');
        rootStyle.removeProperty('--accent-bg');
        rootStyle.removeProperty('--accent-fg');
        return;
    }
    const rgb = accentColorToRgb(hex);
    const alpha = isLightThemeActive() ? ACCENT_BG_ALPHA_LIGHT : ACCENT_BG_ALPHA_DARK;
    rootStyle.setProperty('--accent', hex);
    rootStyle.setProperty('--accent-bg', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
    rootStyle.setProperty('--accent-fg', accentForegroundColor(hex));
}

// 生效的强调色：未自定义时取当前明暗主题与主题风格的默认值，仅用于预览与色板选中判断
// （未自定义时真实颜色由 CSS 变量兜底：默认风格取 tokens.css，Alom 风格取 alom.css）
function currentAccentColor() {
    const custom = normalizeAccentColor(State.accentColor);
    if (custom) return custom;
    const isAlomStyle = normalizeThemeStyle(State.themeStyle) === 'alom';
    if (isLightThemeActive()) return isAlomStyle ? '#007aff' : '#0969da';
    return isAlomStyle ? '#0a84ff' : '#58a6ff';
}

function buildAccentSwatches() {
    const container = document.getElementById('accent-swatches');
    if (!container) return;
    container.innerHTML = '';

    ACCENT_PRESETS.forEach((preset) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'accent-swatch';
        swatch.dataset.accent = preset.value;
        swatch.title = preset.value ? `${preset.name}（${preset.value}）` : preset.name;
        swatch.setAttribute('aria-label', swatch.title);
        if (preset.value) {
            swatch.style.setProperty('--swatch-color', preset.value);
        } else {
            // 默认色块：用明暗两种默认蓝的对角渐变表示"跟随主题"
            swatch.classList.add('accent-swatch-default');
        }
        swatch.onclick = () => setAccentColor(preset.value);
        container.appendChild(swatch);
    });
}

// 同步色板选中态、取色器与十六进制输入框
function syncAccentControls(options = {}) {
    const custom = normalizeAccentColor(State.accentColor);
    const effective = currentAccentColor();

    document.querySelectorAll('#accent-swatches .accent-swatch').forEach((swatch) => {
        const value = normalizeAccentColor(swatch.dataset.accent) || '';
        const selected = value ? value === custom : !custom;
        swatch.classList.toggle('selected', selected);
        swatch.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });

    // 系统取色器打开期间不回写颜色输入框，避免打断用户正在进行的拖动
    const colorInput = document.getElementById('accent-color-input');
    if (colorInput && !options.skipColorInput) colorInput.value = effective;

    const hexInput = document.getElementById('accent-hex-input');
    if (hexInput && document.activeElement !== hexInput) hexInput.value = custom || '';
}

// 设置主题色：State、CSS 变量与控件同步刷新，并写入 config.json
function setAccentColor(value) {
    State.accentColor = normalizeAccentColor(value);
    applyAccentColor();
    syncAccentControls();
    saveConfig();
    // 主题色不经过 applyTheme，这里单独同步一次给小本本
    syncScratchpadAppearance();
}

// 仅实时预览（拖动取色器时调用），不落盘，避免连续写入 config.json
function previewAccentColor(value) {
    State.accentColor = normalizeAccentColor(value);
    applyAccentColor();
    syncAccentControls({ skipColorInput: true });
}

function commitAccentHexInput() {
    const hexInput = document.getElementById('accent-hex-input');
    if (!hexInput) return;
    const normalized = normalizeAccentColor(hexInput.value);
    if (normalized || !hexInput.value.trim()) {
        setAccentColor(normalized);
        return;
    }
    showToast('颜色格式不正确，请使用 #RRGGBB 或 #RGB');
    syncAccentControls();
}

function initAccentColor() {
    buildAccentSwatches();

    const colorInput = document.getElementById('accent-color-input');
    if (colorInput) {
        // input 事件在拖动过程中持续触发，只做实时预览，松手（change）后才落盘
        colorInput.oninput = (e) => previewAccentColor(e.target.value);
        colorInput.onchange = (e) => setAccentColor(e.target.value);
    }

    const hexInput = document.getElementById('accent-hex-input');
    if (hexInput) {
        hexInput.oninput = (e) => {
            const normalized = normalizeAccentColor(e.target.value);
            if (normalized) previewAccentColor(normalized);
        };
        // 失焦或回车时提交：内容为空视为恢复默认，格式非法则保留原值并提示
        hexInput.onchange = commitAccentHexInput;
        hexInput.onkeydown = (e) => {
            if (e.key === 'Enter') hexInput.blur();
        };
    }

    const applyBtn = document.getElementById('btn-accent-apply');
    if (applyBtn) applyBtn.onclick = commitAccentHexInput;

    // 首屏已由 boot.js 同步注入过一次，这里再同步一次以兜底
    applyAccentColor();
    syncAccentControls();
}
