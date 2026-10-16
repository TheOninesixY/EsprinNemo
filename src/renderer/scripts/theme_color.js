const ACCENT_PRESETS = [
    { name: '跟随系统', value: 'system' },
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

const ACCENT_TEXT_ON_DARK = '#ffffff';
const ACCENT_TEXT_ON_LIGHT = '#1f2328';

const ACCENT_LIGHT_TEXT_THRESHOLD = 0.6;

const ACCENT_BG_ALPHA_DARK = 0.15;
const ACCENT_BG_ALPHA_LIGHT = 0.1;

const ACCENT_HEX_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeAccentColor(value) {
    if (value === undefined || value === null) return 'system';
    if (typeof value !== 'string') return 'system';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed.toLowerCase() === 'system') return 'system';
    const matched = trimmed.match(ACCENT_HEX_PATTERN);
    if (!matched) return 'system';
    let hex = matched[1];

    if (hex.length === 3) hex = hex.split('').map(char => char + char).join('');
    return `#${hex.toUpperCase()}`;
}

let cachedSystemAccentColor = '';

function normalizeSystemAccentHex(raw) {
    if (typeof raw !== 'string') return '';
    const text = raw.trim();
    const rgb = text.match(/^rgba?\(([^)]+)\)$/i);
    if (rgb) {
        const parts = rgb[1].split(',').map((item) => Number(item.trim()));
        if (parts.length >= 3 && parts.slice(0, 3).every((value) => Number.isFinite(value))) {
            const hex = parts.slice(0, 3)
                .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
                .join('');
            return `#${hex.toUpperCase()}`;
        }
        return '';
    }
    const hex = text.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length === 3) return `#${hex.split('').map((char) => char + char).join('').toUpperCase()}`;
    if (hex.length >= 6) return `#${hex.slice(0, 6).toUpperCase()}`;
    return '';
}

function fetchSystemAccentColor() {
    try {
        const { systemPreferences } = require('electron');
        if (systemPreferences && typeof systemPreferences.getAccentColor === 'function') {
            const hex = normalizeSystemAccentHex(systemPreferences.getAccentColor());
            if (hex) {
                cachedSystemAccentColor = hex;
                return cachedSystemAccentColor;
            }
        }
    } catch (e) {}
    try {
        const color = ipcRenderer.sendSync('system:get-accent-color-sync');
        if (typeof color === 'string' && color) {
            cachedSystemAccentColor = color;
            return color;
        }
    } catch (e) {}
    return cachedSystemAccentColor || '';
}

function resolveAccentHex(value) {
    const norm = normalizeAccentColor(value);
    if (norm === 'system') {
        return fetchSystemAccentColor();
    }
    return norm;
}

function accentColorToRgb(hex) {
    const normalized = resolveAccentHex(hex);
    if (!normalized || normalized === 'system') return null;
    return {
        r: parseInt(normalized.slice(1, 3), 16),
        g: parseInt(normalized.slice(3, 5), 16),
        b: parseInt(normalized.slice(5, 7), 16)
    };
}

function accentForegroundColor(hex) {
    const rgb = accentColorToRgb(hex);
    if (!rgb) return ACCENT_TEXT_ON_DARK;
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return luminance > ACCENT_LIGHT_TEXT_THRESHOLD ? ACCENT_TEXT_ON_LIGHT : ACCENT_TEXT_ON_DARK;
}

function isLightThemeActive() {
    return document.documentElement.classList.contains('light');
}

function applyAccentColor() {
    const rootStyle = document.documentElement.style;
    const hex = resolveAccentHex(State.accentColor);
    if (!hex || !ACCENT_HEX_PATTERN.test(hex)) {
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

function currentAccentColor() {
    const custom = resolveAccentHex(State.accentColor);
    if (custom) return custom;
    const style = normalizeThemeStyle(State.themeStyle);
    const light = isLightThemeActive();
    if (style === 'magic') return light ? '#7c3aed' : '#8b5cf6';
    if (style === 'alom') return light ? '#007aff' : '#0a84ff';
    return light ? '#0969da' : '#58a6ff';
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
        swatch.title = preset.value && preset.value !== 'system' ? `${preset.name}（${preset.value}）` : preset.name;
        swatch.setAttribute('aria-label', swatch.title);
        if (preset.value === 'system') {
            swatch.classList.add('accent-swatch-system');
            const sysColor = fetchSystemAccentColor();
            if (sysColor) {
                swatch.style.setProperty('--swatch-color', sysColor);
                swatch.title = `${preset.name}（${sysColor}）`;
                swatch.setAttribute('aria-label', swatch.title);
            }
        } else if (preset.value) {
            swatch.style.setProperty('--swatch-color', preset.value);
        } else {

            swatch.classList.add('accent-swatch-default');
        }
        swatch.onclick = () => setAccentColor(preset.value);
        container.appendChild(swatch);
    });
}

function syncAccentControls(options = {}) {
    const custom = normalizeAccentColor(State.accentColor);
    const effective = currentAccentColor();

    document.querySelectorAll('#accent-swatches .accent-swatch').forEach((swatch) => {
        const value = swatch.dataset.accent;
        const selected = value === custom;
        swatch.classList.toggle('selected', selected);
        swatch.setAttribute('aria-pressed', selected ? 'true' : 'false');
        if (value === 'system') {
            const sysColor = fetchSystemAccentColor();
            if (sysColor) {
                swatch.style.setProperty('--swatch-color', sysColor);
                swatch.title = `跟随系统（${sysColor}）`;
            }
        }
    });

const colorInput = document.getElementById('accent-color-input');
    if (colorInput && !options.skipColorInput) colorInput.value = effective;

    const hexInput = document.getElementById('accent-hex-input');
    if (hexInput && document.activeElement !== hexInput) {
        hexInput.value = custom === 'system' ? 'system' : (custom || '');
    }
}

function setAccentColor(value) {
    State.accentColor = normalizeAccentColor(value);
    applyAccentColor();
    syncAccentControls();
    saveConfig();

    syncScratchpadAppearance();
}

function previewAccentColor(value) {
    State.accentColor = normalizeAccentColor(value);
    applyAccentColor();
    syncAccentControls({ skipColorInput: true });
}

function commitAccentHexInput() {
    const hexInput = document.getElementById('accent-hex-input');
    if (!hexInput) return;
    const raw = hexInput.value.trim();
    if (raw.toLowerCase() === 'system') {
        setAccentColor('system');
        return;
    }
    const normalized = normalizeAccentColor(raw);
    if (normalized || !raw) {
        setAccentColor(normalized);
        return;
    }
    showToast('颜色格式不正确，请使用 #RRGGBB、#RGB 或 system');
    syncAccentControls();
}

function initAccentColor() {
    buildAccentSwatches();

    const colorInput = document.getElementById('accent-color-input');
    if (colorInput) {

        colorInput.oninput = (e) => previewAccentColor(e.target.value);
        colorInput.onchange = (e) => setAccentColor(e.target.value);
    }

    const hexInput = document.getElementById('accent-hex-input');
    if (hexInput) {
        hexInput.oninput = (e) => {
            const val = e.target.value.trim();
            if (val.toLowerCase() === 'system') {
                previewAccentColor('system');
            } else {
                const normalized = normalizeAccentColor(val);
                if (normalized) previewAccentColor(normalized);
            }
        };

        hexInput.onchange = commitAccentHexInput;
        hexInput.onkeydown = (e) => {
            if (e.key === 'Enter') hexInput.blur();
        };
    }

    const applyBtn = document.getElementById('btn-accent-apply');
    if (applyBtn) applyBtn.onclick = commitAccentHexInput;

try {
        ipcRenderer.on('system:accent-color-changed', (event, newColor) => {
            cachedSystemAccentColor = newColor;
            if (State.accentColor === 'system') {
                applyAccentColor();
                syncAccentControls();
                syncScratchpadAppearance();
            } else {

                syncAccentControls();
            }
        });
    } catch (e) {}

applyAccentColor();
    syncAccentControls();
}
