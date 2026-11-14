const { ipcRenderer, webFrame } = require('electron');
const fs = require('fs');
const path = require('path');

const SIDEBAR_COLLAPSED_CLASS = 'sidebar-collapsed';

const MODERN_LAYOUT_CLASS = 'modern-layout';

const TABS_DISABLED_CLASS = 'tabs-disabled';

const SIDEBAR_BLUR_OFF_CLASS = 'sidebar-blur-off';

const NARROW_WINDOW_THRESHOLD = 900;

const UI_SCALE_MIN = 0.5;
const UI_SCALE_MAX = 2;
const UI_SCALE_DEFAULT = 1;

const WALLPAPER_ARG_PREFIX = '--esprin-nemo-wallpaper=';
const WALLPAPER_CLASS = 'has-wallpaper';

function normalizeUiScale(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return UI_SCALE_DEFAULT;
    const clamped = Math.min(Math.max(num, UI_SCALE_MIN), UI_SCALE_MAX);
    return Math.round(clamped * 100) / 100;
}

const PORTABLE_ARG = '--esprin-nemo-portable';
const IS_PORTABLE_RUN = (process.argv || []).includes(PORTABLE_ARG)
    || !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);

const IS_WEB_RUNTIME = (() => {
    try {
        return !(process.versions && process.versions.electron);
    } catch (e) {
        return true;
    }
})();

document.documentElement.classList.add(IS_WEB_RUNTIME ? 'web-runtime' : 'desktop-runtime');

document.documentElement.classList.add(SIDEBAR_COLLAPSED_CLASS);

document.documentElement.classList.add(MODERN_LAYOUT_CLASS);

function readWallpaperUrl() {
    try {
        const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith(WALLPAPER_ARG_PREFIX));
        if (!matched) return '';
        return matched.slice(WALLPAPER_ARG_PREFIX.length).trim();
    } catch (e) {
        return '';
    }
}

const initialWallpaperUrl = readWallpaperUrl();
if (initialWallpaperUrl) {
    document.documentElement.style.setProperty('--desktop-wallpaper', `url("${initialWallpaperUrl}")`);
    document.documentElement.classList.add(WALLPAPER_CLASS);
}

function resolveDataDir() {
    try {
        const dir = ipcRenderer.sendSync('data:get-dir-sync');
        if (typeof dir === 'string' && dir) return dir;
    } catch (e) {}
    try {
        const argPrefix = '--esprin-nemo-data-dir=';
        const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith(argPrefix));
        if (matched) {
            const dir = matched.slice(argPrefix.length).trim();
            if (dir) return dir;
        }

        return path.join(__dirname, '..', '..', 'data');
    } catch (e) {
        return __dirname + '/../../data';
    }
}

try {
    const configPath = path.join(resolveDataDir(), 'config.json');
    let theme = 'system';
    let fonts = null;
    let accentColor = 'system';
    let themeStyle = 'default';
    let cornerRadius = 'default';
    let uiScale = 1;
    let tabsDisabled = false;
    let sidebarBlur = true;
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config && config.theme) theme = config.theme;
        if (config && typeof config.themeStyle === 'string') themeStyle = config.themeStyle;
        if (config && config.fonts && typeof config.fonts === 'object') fonts = config.fonts;
        if (config && typeof config.accentColor === 'string') accentColor = config.accentColor;
        if (config && typeof config.cornerRadius === 'string') cornerRadius = config.cornerRadius;
        if (config && config.uiScale !== undefined) uiScale = config.uiScale;
        if (config && config.tabsDisabled === true) tabsDisabled = true;
        if (config && config.sidebarBlur === false) sidebarBlur = false;
    }

    if (tabsDisabled) document.documentElement.classList.add(TABS_DISABLED_CLASS);
    if (!sidebarBlur) document.documentElement.classList.add(SIDEBAR_BLUR_OFF_CLASS);
    webFrame.setZoomFactor(normalizeUiScale(uiScale));

    const isLight = theme === 'light' || (theme === 'system' && window.matchMedia && !window.matchMedia('(prefers-color-scheme: dark)').matches);
    applyWindowAppearance({
        theme: isLight ? 'light' : 'dark',
        style: themeStyle,
        radius: cornerRadius,
        accent: accentColor,
        fonts
    });
} catch (e) {}
