const { ipcRenderer, webFrame } = require('electron');
const fs = require('fs');
const path = require('path');

const SIDEBAR_COLLAPSED_CLASS = 'sidebar-collapsed';

const MODERN_LAYOUT_CLASS = 'modern-layout';

const NARROW_WINDOW_THRESHOLD = 900;

const UI_SCALE_MIN = 0.5;
const UI_SCALE_MAX = 2;
const UI_SCALE_DEFAULT = 1;

function normalizeUiScale(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return UI_SCALE_DEFAULT;
    const clamped = Math.min(Math.max(num, UI_SCALE_MIN), UI_SCALE_MAX);
    return Math.round(clamped * 100) / 100;
}

const PORTABLE_ARG = '--esprin-nemo-portable';
const IS_PORTABLE_RUN = (process.argv || []).includes(PORTABLE_ARG)
    || !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);

const IS_WEB_RUNTIME = false;

document.documentElement.classList.add('desktop-runtime');

document.documentElement.classList.add(SIDEBAR_COLLAPSED_CLASS);

document.documentElement.classList.add(MODERN_LAYOUT_CLASS);

function readWindowControlsArg() {
    try {
        const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith('--esprin-nemo-window-controls='));
        if (matched) return matched.slice('--esprin-nemo-window-controls='.length).trim() === 'mac' ? 'mac' : 'windows';
    } catch (e) {

    }
    return process.platform === 'darwin' ? 'mac' : 'windows';
}

function readInitialWindowControls() {
    try {
        const snapshot = ipcRenderer.sendSync('window:get-controls-sync');
        if (snapshot && typeof snapshot === 'object') {
            return {
                style: snapshot.style === 'mac' ? 'mac' : 'windows',
                native: !!snapshot.native,
                mac: !!snapshot.mac
            };
        }
    } catch (e) {

    }
    const style = readWindowControlsArg();
    return {
        style,
        native: style === 'mac' && process.platform === 'darwin',
        mac: process.platform === 'darwin'
    };
}

const INITIAL_WINDOW_CONTROLS = readInitialWindowControls();

function applyWindowControlsClass(state) {
    const root = document.documentElement;
    const isMac = state.style === 'mac';
    root.classList.toggle('window-controls-mac', isMac);
    root.classList.toggle('window-controls-windows', !isMac);
}

applyWindowControlsClass(INITIAL_WINDOW_CONTROLS);

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

        return path.join(__dirname, '..', '..', '..', 'data');
    } catch (e) {
        return __dirname + '/../../../data';
    }
}

try {
    const configPath = path.join(resolveDataDir(), 'config.json');
    let theme = 'system';
    let fonts = null;
    let accentColor = 'system';
    let cornerRadius = 'default';
    let uiScale = 1;
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config && config.theme) theme = config.theme;
        if (config && config.fonts && typeof config.fonts === 'object') fonts = config.fonts;
        if (config && typeof config.accentColor === 'string') accentColor = config.accentColor;
        if (config && typeof config.cornerRadius === 'string') cornerRadius = config.cornerRadius;
        if (config && config.uiScale !== undefined) uiScale = config.uiScale;
    }
    webFrame.setZoomFactor(normalizeUiScale(uiScale));
    const isLight = theme === 'light' || (theme === 'system' && window.matchMedia && !window.matchMedia('(prefers-color-scheme: dark)').matches);
    applyWindowAppearance({
        theme: isLight ? 'light' : 'dark',
        radius: cornerRadius,
        accent: accentColor,
        fonts
    });
} catch (e) {}
