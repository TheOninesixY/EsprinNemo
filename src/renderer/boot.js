/* 首屏引导：渲染进程共享依赖 + 在首次绘制前同步应用主题、字体与界面尺寸，杜绝闪烁 */
const { ipcRenderer, webFrame } = require('electron');
const fs = require('fs');
const path = require('path');

// 侧边栏收起状态类：挂在 <html> 上。styles/sidebar.css 依赖该类名，scripts/render.js 复用此常量。
const SIDEBAR_COLLAPSED_CLASS = 'sidebar-collapsed';

// 现代布局状态类：同样挂在 <html> 上。styles/mode.css 依赖该类名，scripts/mode.js 复用此常量。
const MODERN_LAYOUT_CLASS = 'modern-layout';

// 现代布局里「禁用标签页」的状态类：同样挂在 <html> 上，首个渲染帧前就要落定，
// 免得先画出一整条标签页再收起（见 styles/mode.css 与 scripts/mode.js）。
const TABS_DISABLED_CLASS = 'tabs-disabled';

/* 界面尺寸（缩放比例）：直接落到 Chromium 缩放上（webFrame.setZoomFactor），1 为 100%。
   取值范围 50%~200%（见 scripts/appearance.js 的自定义输入框）。

   取值规则写在引导脚本里而不是 appearance.js：本文件先于页面其余脚本执行，
   首屏就能按最终比例排版，不会先按 100% 画一遍再整屏缩放；
   normalizeUiScale 也被设置页与配置文件读写复用，几处用的是同一套取值。 */
const UI_SCALE_MIN = 0.5;
const UI_SCALE_MAX = 2;
const UI_SCALE_DEFAULT = 1;

// 取值整理：非数字回落到 100%，超出范围夹到两端，并对齐到 1% 的整数倍
//（按整数百分比换算，避开浮点误差，免得存出 1.1000000000000001 这类值）
function normalizeUiScale(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return UI_SCALE_DEFAULT;
    const clamped = Math.min(Math.max(num, UI_SCALE_MIN), UI_SCALE_MAX);
    return Math.round(clamped * 100) / 100;
}

// 便携版运行标记：主进程判断后通过 --esprin-nemo-portable 告知（见 src/main/updater.js），
// 环境变量作为兜底。便携版每次启动都会解压到临时目录，没有稳定的可升级目标，
// 因此更新功能与相关设置整体移除（见 scripts/settings.js 与 scripts/update.js）。
const PORTABLE_ARG = '--esprin-nemo-portable';
const IS_PORTABLE_RUN = (process.argv || []).includes(PORTABLE_ARG)
    || !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);

// 数据目录解析：优先向主进程同步查询（主进程已处理用户在设置中自定义的位置），
// 失败时回退到命令行参数（主进程启动时会通过 --esprin-nemo-data-dir= 传入）。
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
        // 本文件位于 src/renderer/ 下，开发版默认数据目录在项目根目录
        return path.join(__dirname, '..', '..', 'data');
    } catch (e) {
        return __dirname + '/../../data';
    }
}

// 渲染前极速同步读取配置并应用主题，彻底杜绝闪光弹/白屏/黑屏闪烁。
// 「明暗主题 / 主题风格 / 圆角尺度 / 主题色 / 应用名颜色 / 字体」这一整套换算由
// window_appearance.js 统一实现，小本本与弹窗窗口用的是同一份逻辑（它们从命令行参数取值），
// 这里只负责把 config.json 里的值取出来交给它。
try {
    const configPath = path.join(resolveDataDir(), 'config.json');
    let theme = 'system';
    let fonts = null;
    let accentColor = '';
    let themeStyle = 'default';
    let brandColor = 'brand';
    let cornerRadius = 'default';
    let uiScale = 1;
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config && config.theme) theme = config.theme;
        if (config && typeof config.themeStyle === 'string') themeStyle = config.themeStyle;
        if (config && config.fonts && typeof config.fonts === 'object') fonts = config.fonts;
        if (config && typeof config.accentColor === 'string') accentColor = config.accentColor;
        if (config && typeof config.brandColor === 'string') brandColor = config.brandColor;
        if (config && typeof config.cornerRadius === 'string') cornerRadius = config.cornerRadius;
        if (config && config.uiScale !== undefined) uiScale = config.uiScale;

        // 侧边栏收起状态也在这里落定：首屏直接按收起态绘制，
        // 否则会先画出一整个展开的侧边栏，再补播一次收起动效。
        if (config && config.sidebarCollapsed) {
            document.documentElement.classList.add(SIDEBAR_COLLAPSED_CLASS);
        }

        // 现代布局（默认布局）同理：先落定类名，首屏就不会先排出标题栏、标签页再收起。
        // 只有显式选了经典布局（classic；旧版写作 standard）才落不下这个类名，
        // 其余情况——包括配置里还没有这一项——一律按现代布局处理。
        // 这一档旧时叫过 line（Line 模式）、notab（无Tab模式）与 minimal（极简模式），一并认作现代布局
        if (config && config.uiMode !== 'classic' && config.uiMode !== 'standard') {
            document.documentElement.classList.add(MODERN_LAYOUT_CLASS);
            // 「禁用标签页」是现代布局里的子开关：打开时首屏就不排出标签页
            // （旧配置里这一项叫 lineHideTabs，改名后一并认）
            if (config.tabsDisabled === true || config.lineHideTabs === true) {
                document.documentElement.classList.add(TABS_DISABLED_CLASS);
            }
        }
    }

    // 界面尺寸：无论配置里有没有这一项都显式设置一次——Chromium 会按页面来源记住缩放，
    // 上一轮遗留的比例不能盖过配置（用户把 150% 调回 100% 后重启，界面必须真的回到 100%）
    webFrame.setZoomFactor(normalizeUiScale(uiScale));

    // 'system' 由这里折算成实际明暗色：样式表只认 light / dark
    const isLight = theme === 'light' || (theme === 'system' && window.matchMedia && !window.matchMedia('(prefers-color-scheme: dark)').matches);
    applyWindowAppearance({
        theme: isLight ? 'light' : 'dark',
        style: themeStyle,
        radius: cornerRadius,
        accent: accentColor,
        brandColor,
        fonts
    });
} catch (e) {}
