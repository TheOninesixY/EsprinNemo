/* 首屏引导：渲染进程共享依赖 + 在首次绘制前同步应用主题与字体，杜绝闪烁 */
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

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

// 渲染前极速同步读取配置并应用主题，彻底杜绝闪光弹/白屏/黑屏闪烁
try {
    const configPath = path.join(resolveDataDir(), 'config.json');
    let theme = 'system';
    let fonts = null;
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config && config.theme) theme = config.theme;
        if (config && config.fonts && typeof config.fonts === 'object') fonts = config.fonts;
    }
    const isLight = theme === 'light' || (theme === 'system' && window.matchMedia && !window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isLight) {
        document.documentElement.classList.add('light');
    }

    // 字体：与主题同样在首屏渲染前注入 CSS 变量，避免字体切换时的跳变闪烁
    const quoteFamily = (name) => {
        if (typeof name !== 'string') return '';
        const safe = name.trim().replace(/["\\;{}]/g, '');
        return safe ? '"' + safe + '"' : '';
    };
    const fontVars = {
        '--font-ui-latin': quoteFamily(fonts && fonts.uiLatin),
        '--font-ui-cjk': quoteFamily(fonts && fonts.uiCjk),
        '--font-doc-latin': quoteFamily(fonts && fonts.docLatin),
        '--font-doc-cjk': quoteFamily(fonts && fonts.docCjk)
    };
    Object.keys(fontVars).forEach((key) => {
        if (fontVars[key]) document.documentElement.style.setProperty(key, fontVars[key]);
    });
} catch (e) {}
