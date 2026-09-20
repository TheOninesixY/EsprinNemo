/* 首屏引导：渲染进程共享依赖 + 在首次绘制前同步应用主题与字体，杜绝闪烁 */
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// 侧边栏收起状态类：挂在 <html> 上。styles/sidebar.css 依赖该类名，scripts/render.js 复用此常量。
const SIDEBAR_COLLAPSED_CLASS = 'sidebar-collapsed';

// 极简模式状态类：同样挂在 <html> 上。styles/mode.css 依赖该类名，scripts/mode.js 复用此常量。
const MINIMAL_MODE_CLASS = 'minimal-mode';

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
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config && config.theme) theme = config.theme;
        if (config && typeof config.themeStyle === 'string') themeStyle = config.themeStyle;
        if (config && config.fonts && typeof config.fonts === 'object') fonts = config.fonts;
        if (config && typeof config.accentColor === 'string') accentColor = config.accentColor;
        if (config && typeof config.brandColor === 'string') brandColor = config.brandColor;
        if (config && typeof config.cornerRadius === 'string') cornerRadius = config.cornerRadius;

        // 侧边栏收起状态也在这里落定：首屏直接按收起态绘制，
        // 否则会先画出一整个展开的侧边栏，再补播一次收起动效。
        if (config && config.sidebarCollapsed) {
            document.documentElement.classList.add(SIDEBAR_COLLAPSED_CLASS);
        }

        // 极简模式同理：先落定类名，首屏就不会闪出随后要隐藏的那些入口
        if (config && config.uiMode === 'minimal') {
            document.documentElement.classList.add(MINIMAL_MODE_CLASS);
        }
    }

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
