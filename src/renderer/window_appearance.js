(function (global) {

    const ARG_PREFIX = '--esprin-nemo-window-';
    const HEX_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

    const RADIUS_VALUES = ['square', 'slight', 'large'];
    const BRAND_COLOR_VALUES = ['mono', 'accent'];

    const FONT_VARS = {
        '--font-ui-latin': 'uiLatin',
        '--font-ui-cjk': 'uiCjk',
        '--font-doc-latin': 'docLatin',
        '--font-doc-cjk': 'docCjk'
    };

function readArg(name) {
        try {
            const prefix = ARG_PREFIX + name + '=';
            const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith(prefix));
            return matched ? matched.slice(prefix.length).trim() : '';
        } catch (error) {
            return '';
        }
    }

function readWindowAppearanceFromArgs() {
        return {
            theme: readArg('theme'),
            style: readArg('style'),
            radius: readArg('radius'),
            accent: readArg('accent'),
            brandColor: readArg('brand'),
            fonts: {
                uiLatin: readArg('font-ui-latin'),
                uiCjk: readArg('font-ui-cjk'),
                docLatin: readArg('font-doc-latin'),
                docCjk: readArg('font-doc-cjk')
            }
        };
    }

function quoteFontFamily(name) {
        if (typeof name !== 'string') return '';
        const safe = name.trim().replace(/["\\;{}]/g, '');
        return safe ? '"' + safe + '"' : '';
    }

    // 明暗主题：light / dark（system 由调用方折算为实际明暗色）。未传值时保持现状，不擅自改动
    function applyTheme(theme) {
        if (theme !== 'light' && theme !== 'dark') return;
        document.documentElement.classList.toggle('light', theme === 'light');
    }

    // 主题风格（皮肤）：只挂属性，配色交给 styles/alom.css 与 styles/magic_style.css 的
    // :root[data-theme-style="..."] 解析
    function applyThemeStyle(style) {
        const known = style === 'alom' || style === 'magic' ? style : 'default';
        document.documentElement.dataset.themeStyle = known;
    }

function applyRadius(radius) {
        document.documentElement.dataset.radius = RADIUS_VALUES.includes(radius) ? radius : 'default';
    }

function applyBrandColor(brandColor) {
        document.documentElement.dataset.brandColor = BRAND_COLOR_VALUES.includes(brandColor) ? brandColor : 'brand';
    }

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
                return '#' + hex.toUpperCase();
            }
            return '';
        }
        const hex = text.replace(/[^0-9a-fA-F]/g, '');
        if (hex.length === 3) return '#' + hex.split('').map((char) => char + char).join('').toUpperCase();
        if (hex.length >= 6) return '#' + hex.slice(0, 6).toUpperCase();
        return '';
    }

function applyAccent(value) {
        let accentValue = value;
        if (typeof accentValue === 'string' && accentValue.trim().toLowerCase() === 'system') {
            try {
                const { systemPreferences } = require('electron');
                if (systemPreferences && typeof systemPreferences.getAccentColor === 'function') {
                    const hex = normalizeSystemAccentHex(systemPreferences.getAccentColor());
                    if (hex) accentValue = hex;
                }
            } catch (e) {}
        }
        const rootStyle = document.documentElement.style;
        const matched = String(accentValue == null ? '' : accentValue).trim().match(HEX_PATTERN);
        if (!matched) {
            rootStyle.removeProperty('--accent');
            rootStyle.removeProperty('--accent-bg');
            rootStyle.removeProperty('--accent-fg');
            return;
        }

        const hex = matched[1].length === 3
            ? matched[1].split('').map((char) => char + char).join('')
            : matched[1];
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);

        const alpha = document.documentElement.classList.contains('light') ? 0.1 : 0.15;
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        rootStyle.setProperty('--accent', '#' + hex.toUpperCase());
        rootStyle.setProperty('--accent-bg', 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')');
        rootStyle.setProperty('--accent-fg', luminance > 0.6 ? '#1f2328' : '#ffffff');
    }

function applyFonts(fonts) {
        const source = fonts && typeof fonts === 'object' ? fonts : {};
        const rootStyle = document.documentElement.style;
        Object.keys(FONT_VARS).forEach((key) => {
            const family = quoteFontFamily(source[FONT_VARS[key]]);
            if (family) {
                rootStyle.setProperty(key, family);
            } else {
                rootStyle.removeProperty(key);
            }
        });
    }

function applyWindowAppearance(options) {
        const source = options && typeof options === 'object' ? options : {};
        applyTheme(source.theme);
        applyThemeStyle(source.style);
        applyRadius(source.radius);
        applyBrandColor(source.brandColor);
        applyAccent(source.accent);
        applyFonts(source.fonts);
    }

    global.applyWindowAppearance = applyWindowAppearance;
    global.readWindowAppearanceFromArgs = readWindowAppearanceFromArgs;
})(window);
