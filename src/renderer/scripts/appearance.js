const THEME_STYLE_VALUES = ['default', 'alom', 'magic'];

const APPEARANCE_FADE_CLASS = 'appearance-fading';

const APPEARANCE_FADE_MS = 250;
let appearanceFadeTimer = null;

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

function applyThemeStyle() {
    document.documentElement.dataset.themeStyle = normalizeThemeStyle(State.themeStyle);
}

function syncThemeStyleSelect() {
    const select = document.getElementById('setting-theme-style');
    if (select) select.value = normalizeThemeStyle(State.themeStyle);
}

function setThemeStyle(value) {

    beginAppearanceFade();
    State.themeStyle = normalizeThemeStyle(value);
    applyThemeStyle();
    syncThemeStyleSelect();

    applyAccentColor();
    syncAccentControls();
    saveConfig();

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

const THEME_MODE_VALUES = ['system', 'light', 'dark'];

function normalizeThemeMode(value) {
    return THEME_MODE_VALUES.includes(value) ? value : 'system';
}

function syncThemeModeSelect() {
    const select = document.getElementById('setting-theme-mode');
    if (select) select.value = normalizeThemeMode(State.theme);
}

function setThemeMode(value) {
    State.theme = normalizeThemeMode(value);
    applyTheme();
    syncThemeModeSelect();
    saveConfig();
}

function initThemeMode() {
    const select = document.getElementById('setting-theme-mode');
    if (select) select.onchange = (event) => setThemeMode(event.target.value);

    syncThemeModeSelect();
}

function applyTheme() {

    if (themeAppliedOnce) beginAppearanceFade();
    themeAppliedOnce = true;

    const effective = getEffectiveTheme();
    if (effective === 'light') {
        document.documentElement.classList.add('light');
    } else {
        document.documentElement.classList.remove('light');
    }

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

syncThemeModeSelect();
    syncScratchpadAppearance();
}

function syncScratchpadAppearance() {
    try {
        ipcRenderer.send('scratchpad:appearance', {
            theme: getEffectiveTheme(),
            style: normalizeThemeStyle(State.themeStyle),
            accent: normalizeAccentColor(State.accentColor),
            radius: normalizeCornerRadius(State.cornerRadius),

            fonts: typeof normalizeFonts === 'function' ? normalizeFonts(State.fonts) : {}
        });
    } catch (err) {
        console.error('同步小本本外观失败:', err);
    }

    if (typeof syncStickyNotesAppearance === 'function') syncStickyNotesAppearance();
}

const SPELLCHECK_TARGET_IDS = ['input-note-title', 'textarea-note-content'];

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

        if (el.spellcheck === enabled) return;
        el.spellcheck = enabled;

        if (!enabled) clearSpellcheckMarkers(el);
    });
}

const CORNER_RADIUS_VALUES = ['square', 'slight', 'default', 'large'];

function normalizeCornerRadius(value) {
    return CORNER_RADIUS_VALUES.includes(value) ? value : 'default';
}

function cornerRadiusIndex(value) {
    return CORNER_RADIUS_VALUES.indexOf(normalizeCornerRadius(value));
}

function applyCornerRadius() {
    document.documentElement.dataset.radius = normalizeCornerRadius(State.cornerRadius);
}

const SLIDER_DRAG_STEP = '0.01';

function setSliderPosition(slider, ratio) {
    if (!slider) return;
    const clamped = Math.min(Math.max(ratio, 0), 1);
    slider.style.setProperty('--slider-pos', clamped.toFixed(4));
    slider.style.setProperty('--slider-fill', (clamped * 100).toFixed(2) + '%');
}

function markSliderTicks(slider, current) {
    if (!slider) return;
    slider.querySelectorAll('.slider-tick').forEach((tick) => {
        const active = tick.dataset.value === String(current);
        tick.classList.toggle('active', active);
        tick.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function initSliderControl({ sliderId, inputId, restStep, ratioOf, onCommit }) {
    const slider = document.getElementById(sliderId);
    const input = document.getElementById(inputId);
    if (!slider || !input) return;

    let dragging = false;

    input.oninput = (event) => {

        if (dragging) {
            setSliderPosition(slider, ratioOf(Number(event.target.value)));
            return;
        }

        onCommit(event.target.value);
    };

    input.addEventListener('pointerdown', () => {
        dragging = true;

        input.step = SLIDER_DRAG_STEP;
        slider.classList.add('is-dragging');
    });

    const endDrag = () => {
        if (!dragging) return;
        dragging = false;

        input.step = restStep;
        slider.classList.remove('is-dragging');
        onCommit(input.value);
    };

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    window.addEventListener('blur', endDrag);

slider.querySelectorAll('.slider-tick').forEach((tick) => {
        tick.onclick = () => onCommit(tick.dataset.value);
    });
}

function radiusSliderStopValue(value) {
    const index = Math.min(Math.max(Math.round(Number(value)), 0), CORNER_RADIUS_VALUES.length - 1);
    return CORNER_RADIUS_VALUES[index];
}

function syncCornerRadiusControl() {
    const current = normalizeCornerRadius(State.cornerRadius);
    const index = cornerRadiusIndex(current);
    const input = document.getElementById('setting-radius');
    if (input) input.value = String(index);
    const slider = document.getElementById('radius-slider');
    setSliderPosition(slider, index / (CORNER_RADIUS_VALUES.length - 1));
    markSliderTicks(slider, current);
}

function setCornerRadius(value) {
    State.cornerRadius = normalizeCornerRadius(value);
    applyCornerRadius();
    syncCornerRadiusControl();
    saveConfig();

    syncScratchpadAppearance();
}

function initCornerRadius() {
    initSliderControl({
        sliderId: 'radius-slider',
        inputId: 'setting-radius',

        restStep: '1',

        ratioOf: (value) => value / (CORNER_RADIUS_VALUES.length - 1),

        onCommit: (raw) => {
            const index = Number(raw);
            setCornerRadius(Number.isFinite(index) ? radiusSliderStopValue(index) : raw);
        }
    });
    applyCornerRadius();
    syncCornerRadiusControl();
}

const UI_SCALE_STOPS = [0.8, 0.9, 1, 1.1, 1.2];

const UI_SCALE_CUSTOM_LABEL = `${Math.round(UI_SCALE_MIN * 100)} ~ ${Math.round(UI_SCALE_MAX * 100)}`;

const UI_SCALE_CUSTOM_CONFIRM_MS = 10000;

function nearestUiScaleStopIndex(value) {
    const current = normalizeUiScale(value);
    return UI_SCALE_STOPS.reduce((best, stop, index) => (
        Math.abs(stop - current) < Math.abs(UI_SCALE_STOPS[best] - current) ? index : best
    ), 0);
}

function isUiScaleStop(value) {
    const current = normalizeUiScale(value);
    return UI_SCALE_STOPS.some((stop) => Math.abs(stop - current) < 0.0001);
}

function uiScaleRatio(index) {
    return Number(index) / (UI_SCALE_STOPS.length - 1);
}

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

ipcRenderer.invoke('window:ui-scale', scale).catch(() => {});
}

function syncUiScaleCustomInput(current) {
    const el = document.getElementById('ui-scale-custom');
    if (!el) return;

    if (document.activeElement === el) return;
    el.value = isUiScaleStop(current) ? '' : String(Math.round(current * 100));
}

function syncUiScaleControl() {
    const current = normalizeUiScale(State.uiScale);
    const slider = document.getElementById('ui-scale-slider');
    const input = document.getElementById('setting-ui-scale');
    const readout = document.getElementById('ui-scale-value');

    if (input) input.value = String(nearestUiScaleStopIndex(current));
    if (readout) readout.textContent = Math.round(current * 100) + '%';
    setSliderPosition(slider, uiScaleRatio(nearestUiScaleStopIndex(current)));
    markSliderTicks(slider, isUiScaleStop(current) ? nearestUiScaleStopIndex(current) : -1);

    if (!isUiScaleStop(current)) setUiScaleCustomOpen(true);
    syncUiScaleCustomInput(current);
}

function previewUiScale(value) {
    State.uiScale = normalizeUiScale(value);
    applyUiScale();
    syncUiScaleControl();
}

function setUiScale(value) {
    previewUiScale(value);
    saveConfig();
}

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

const percent = Math.min(Math.max(Math.round(raw), Math.round(UI_SCALE_MIN * 100)), Math.round(UI_SCALE_MAX * 100));
    el.value = String(percent);

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

        timeoutMs: UI_SCALE_CUSTOM_CONFIRM_MS
    });

    if (keep) {
        setUiScale(percent / 100);

        el.value = isUiScaleStop(percent / 100) ? '' : String(percent);
        showToast(`缩放比例已设为 ${percent}%`);
        return;
    }
    setUiScale(UI_SCALE_DEFAULT);
    el.value = '';
    showToast('缩放比例已恢复为默认 100%');
}

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

    if (open) {
        const input = document.getElementById('ui-scale-custom');
        if (input) input.focus();
    }
}

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

        restStep: '1',

        ratioOf: uiScaleRatio,

        onCommit: (raw) => setUiScale(uiScaleSliderStopValue(raw))
    });
    initUiScaleCustomInput();

applyUiScale();
    syncUiScaleControl();
}

function initTheme() {
    applyTheme();
    if (window.matchMedia) {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

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
