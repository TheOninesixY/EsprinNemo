/* 字体设置：读取本机字体列表，并把界面/文档的西文与 CJK 字体写入 CSS 变量 */

// 内置常用字体：读取系统字体列表失败时兜底，同时用于在下拉框顶部置顶常用项
const COMMON_FONT_FAMILIES = [
    'Inter', 'Segoe UI', 'Helvetica Neue', 'Arial', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Noto Sans',
    'Georgia', 'Times New Roman', 'Cambria', 'Source Serif 4', 'Palatino Linotype',
    'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Source Code Pro',
    'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Microsoft YaHei UI', 'SimSun', 'SimHei', 'KaiTi', 'FangSong',
    'Noto Sans SC', 'Noto Serif SC', 'Source Han Sans SC', 'Source Han Serif SC', 'LXGW WenKai', 'Microsoft JhengHei'
];

// 仅用于列表分组：字体名称含 CJK 字符的归入「中日韩字体」
const CJK_FAMILY_PATTERN = /[\u2E80-\u9FFF\u3040-\u30FF\u31C0-\u31EF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

// 读取本机字体：优先使用 Chromium 的 Local Font Access API，其次回退到主进程字体文件解析
async function queryFontsViaApi() {
    if (typeof window.queryLocalFonts !== 'function') return null;
    try {
        const available = await window.queryLocalFonts();
        const families = [];
        const seen = new Set();
        (available || []).forEach((font) => {
            const family = font && typeof font.family === 'string' ? font.family.trim() : '';
            const key = family.toLowerCase();
            if (!family || seen.has(key)) return;
            seen.add(key);
            families.push(family);
        });
        return families.length ? families : null;
    } catch (err) {
        console.warn('Local Font Access API 不可用，改用主进程枚举字体:', err);
        return null;
    }
}

async function queryFontsViaMainProcess() {
    try {
        const families = await ipcRenderer.invoke('fonts:list');
        return Array.isArray(families) && families.length ? families : null;
    } catch (err) {
        console.warn('主进程字体枚举失败:', err);
        return null;
    }
}

function normalizeFamilyList(families) {
    const seen = new Set();
    const list = [];
    families.forEach((family) => {
        const name = typeof family === 'string' ? family.trim() : '';
        const key = name.toLowerCase();
        if (!name || seen.has(key)) return;
        seen.add(key);
        list.push(name);
    });
    return list.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));
}

function quoteFontFamily(name) {
    if (typeof name !== 'string') return '';
    const safe = name.trim().replace(/["\\;{}]/g, '');
    return safe ? `"${safe}"` : '';
}

// 写入 CSS 变量；留空表示移除内联覆盖，回落到样式表中定义的默认字体栈
function applyFonts() {
    const rootStyle = document.documentElement.style;
    const fonts = normalizeFonts(State.fonts);
    const vars = {
        '--font-ui-latin': quoteFontFamily(fonts.uiLatin),
        '--font-ui-cjk': quoteFontFamily(fonts.uiCjk),
        '--font-doc-latin': quoteFontFamily(fonts.docLatin),
        '--font-doc-cjk': quoteFontFamily(fonts.docCjk)
    };
    Object.keys(vars).forEach((key) => {
        if (vars[key]) {
            rootStyle.setProperty(key, vars[key]);
        } else {
            rootStyle.removeProperty(key);
        }
    });
}

// 西文与 CJK 分开选择，但两者共用同一份系统字体列表
const FONT_SELECT_CONFIG = [
    { id: 'setting-font-ui-latin', key: 'uiLatin' },
    { id: 'setting-font-ui-cjk', key: 'uiCjk' },
    { id: 'setting-font-doc-latin', key: 'docLatin' },
    { id: 'setting-font-doc-cjk', key: 'docCjk' }
];

let fontListPopulated = false;

function createFontOptions(families) {
    return families.map((family) => {
        const option = document.createElement('option');
        option.value = family;
        option.textContent = family;
        return option;
    });
}

function appendFontGroup(select, label, families) {
    if (!families.length) return;
    const optgroup = document.createElement('optgroup');
    optgroup.label = label;
    createFontOptions(families).forEach((option) => optgroup.appendChild(option));
    select.appendChild(optgroup);
}

function populateFontSelects(families) {
    const lower = (value) => String(value).toLowerCase();
    const known = new Set(families.map(lower));
    const common = COMMON_FONT_FAMILIES.filter((family) => known.has(lower(family)));
    const commonKeys = new Set(common.map(lower));
    const cjk = families.filter((family) => !commonKeys.has(lower(family)) && CJK_FAMILY_PATTERN.test(family));
    const others = families.filter((family) => !commonKeys.has(lower(family)) && !CJK_FAMILY_PATTERN.test(family));

    const fonts = normalizeFonts(State.fonts);
    FONT_SELECT_CONFIG.forEach((config) => {
        const select = document.getElementById(config.id);
        if (!select) return;

        select.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '系统默认';
        select.appendChild(defaultOption);

        appendFontGroup(select, '常用字体', common);
        appendFontGroup(select, '中日韩字体', cjk);
        appendFontGroup(select, '其他字体', others);

        // 已保存但本机已卸载/未枚举到的字体仍保留为选项，避免配置被静默丢弃
        const selected = fonts[config.key];
        if (selected && !known.has(lower(selected))) {
            appendFontGroup(select, '当前设置', [selected]);
        }

        select.value = selected || '';
    });

    fontListPopulated = true;
}

function syncFontSelects() {
    // 字体列表用到时才枚举：本机字体可能有上千个，枚举会占用启动阶段的时间，
    // 而字体下拉框只在「设置 → 字体」里出现
    ensureFontListLoaded();
    if (!fontListPopulated) return;
    const fonts = normalizeFonts(State.fonts);
    FONT_SELECT_CONFIG.forEach((config) => {
        const select = document.getElementById(config.id);
        if (select) select.value = fonts[config.key] || '';
    });
}

// 枚举本机字体并填充下拉框（结果与失败都会写入设置页的状态行）
async function loadFontList() {
    try {
        let families = await queryFontsViaApi();
        let source = 'api';
        if (!families) {
            families = await queryFontsViaMainProcess();
            source = 'system';
        }
        if (!families) {
            families = COMMON_FONT_FAMILIES;
            source = 'fallback';
        }

        families = normalizeFamilyList(families);
        populateFontSelects(families);

        const status = document.getElementById('font-list-status');
        if (status) {
            status.textContent = source === 'fallback'
                ? '未能读取本机字体列表：已回退到内置常用字体'
                : `已读取本机字体 ${families.length} 个（西文与 CJK 共用同一列表）`;
        }
    } catch (err) {
        console.error('读取本机字体列表失败:', err);
        const status = document.getElementById('font-list-status');
        if (status) status.textContent = '读取本机字体列表失败：已回退到内置常用字体';
        populateFontSelects(normalizeFamilyList(COMMON_FONT_FAMILIES));
    }
}

// 幂等的按需加载入口：同一时刻只跑一轮枚举，中途重复调用共享同一个 Promise
let fontListPromise = null;

function ensureFontListLoaded() {
    if (fontListPopulated) return null;
    if (!fontListPromise) {
        fontListPromise = loadFontList().finally(() => {
            // 没能成功填充时清掉 Promise，允许下次进入设置页再试一次
            if (!fontListPopulated) fontListPromise = null;
        });
    }
    return fontListPromise;
}

function initFonts() {
    FONT_SELECT_CONFIG.forEach((config) => {
        const select = document.getElementById(config.id);
        if (!select) return;
        select.onchange = (e) => {
            State.fonts[config.key] = e.target.value || '';
            applyFonts();
            saveConfig();
            // 小本本窗口用的是同一套字体，改完立即同步过去（函数来自 appearance.js）
            if (typeof syncScratchpadAppearance === 'function') syncScratchpadAppearance();
        };
    });

    // 首屏已注入过一遍，这里再同步一次以兜底
    applyFonts();
}
