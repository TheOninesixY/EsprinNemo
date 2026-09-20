/* 窗口外观引导：主窗口、小本本、弹窗三个窗口共用同一套外观换算逻辑。

   统一在这一处处理「明暗主题 / 主题风格 / 圆角尺度 / 主题色 / 应用名颜色 / 字体」，
   避免三个窗口各写一份、改动时漏掉某个窗口导致界面割裂：

   - 主窗口：boot.js 读取数据目录中的 config.json 后调用 applyWindowAppearance()；
   - 小本本与弹窗：没有读取配置的能力，改由主进程在创建窗口时经命令行参数注入，
     页面调用 readWindowAppearanceFromArgs() 取回这组参数。

   本文件不含任何窗口专属逻辑，也不依赖 Electron API。 */
(function (global) {
    // 命令行参数前缀：小本本与弹窗共用一套（主进程侧见 src/main/window_appearance.js）
    const ARG_PREFIX = '--esprin-nemo-window-';
    const HEX_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    // 与设置页的可选值保持一致，非法值一律回退到默认档
    const RADIUS_VALUES = ['square', 'slight', 'large'];
    const BRAND_COLOR_VALUES = ['mono', 'accent'];
    // 字体变量：西文与 CJK 分开，浏览器按字符逐个回退
    const FONT_VARS = {
        '--font-ui-latin': 'uiLatin',
        '--font-ui-cjk': 'uiCjk',
        '--font-doc-latin': 'docLatin',
        '--font-doc-cjk': 'docCjk'
    };

    // 命令行长参数的取值，形如 --esprin-nemo-window-theme=light
    function readArg(name) {
        try {
            const prefix = ARG_PREFIX + name + '=';
            const matched = (process.argv || []).find((item) => typeof item === 'string' && item.startsWith(prefix));
            return matched ? matched.slice(prefix.length).trim() : '';
        } catch (error) {
            return '';
        }
    }

    // 子窗口用：把主进程注入的参数整理成 applyWindowAppearance() 需要的结构
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

    // 字体名写进 CSS 变量前先去掉会破坏声明的字符；空值视为未设置，回落到样式表中的默认字体栈
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

    // 主题风格（皮肤）：只挂属性，配色交给 styles/alom.css 的 :root[data-theme-style="alom"] 解析
    function applyThemeStyle(style) {
        document.documentElement.dataset.themeStyle = style === 'alom' ? 'alom' : 'default';
    }

    // 圆角尺度：同样只挂属性，具体像素由 styles/radius.css 换算成 --radius-* 令牌
    function applyRadius(radius) {
        document.documentElement.dataset.radius = RADIUS_VALUES.includes(radius) ? radius : 'default';
    }

    // 应用名颜色模式：brand（品牌色）/ mono（跟随明暗的黑白）/ accent（跟随主题色）
    function applyBrandColor(brandColor) {
        document.documentElement.dataset.brandColor = BRAND_COLOR_VALUES.includes(brandColor) ? brandColor : 'brand';
    }

    // 主题色（强调色）：派生浅底与底上文字色；空值或格式非法时移除内联覆盖，回落到样式表默认色
    function applyAccent(value) {
        const rootStyle = document.documentElement.style;
        const matched = String(value == null ? '' : value).trim().match(HEX_PATTERN);
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
        // 浅色主题下强调色浅底需要更淡，否则同色文字会被糊住
        const alpha = document.documentElement.classList.contains('light') ? 0.1 : 0.15;
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        rootStyle.setProperty('--accent', '#' + hex.toUpperCase());
        rootStyle.setProperty('--accent-bg', 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')');
        rootStyle.setProperty('--accent-fg', luminance > 0.6 ? '#1f2328' : '#ffffff');
    }

    // 字体：留空表示移除内联覆盖，回落到 styles/tokens.css 里定义的默认字体栈
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

    // 一次性应用整套外观：调用方给出值，其余交给上面每个属性的处理函数
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
