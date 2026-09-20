/* 辅助窗口外观参数：小本本与弹窗窗口没有读取配置的能力，因此
   明暗主题 / 主题风格 / 圆角尺度 / 主题色 / 应用名颜色 / 字体统一由主进程算出后，
   经命令行参数注入渲染进程（渲染端见 src/renderer/window_appearance.js）。

   两个窗口共用这一套参数名与整理逻辑，避免「改了主窗口忘了弹窗」式的观感割裂：
   新增一项外观设置时，只需在这里补一个字段。 */

// 命令行参数前缀：与渲染端的 ARG_PREFIX 必须一致
const ARG_PREFIX = '--esprin-nemo-window-';
// 圆角尺度：非法值一律按默认处理（具体像素由 renderer/styles/radius.css 换算）
const RADIUS_VALUES = ['square', 'slight', 'large'];
// 字体字段与命令行参数名一一对应
const FONT_ARG_NAMES = {
  uiLatin: 'font-ui-latin',
  uiCjk: 'font-ui-cjk',
  docLatin: 'font-doc-latin',
  docCjk: 'font-doc-cjk'
};
// 窗口底色兜底：按主题风格与明暗取色，取值与 renderer/styles 中的同名令牌保持一致，
// 窗口创建到页面首屏绘制之间露出的就是它
const THEME_BG = {
  default: { dark: '#0d1117', light: '#ffffff' },
  alom: { dark: '#1c1c1e', light: '#ffffff' }
};

// 读取配置的函数可能抛错（例如配置文件损坏），统一在这里兜底，并保留日志便于排查
function safeResolve(resolver, fallback, label) {
  if (typeof resolver !== 'function') return fallback;
  try {
    const value = resolver();
    return value == null ? fallback : value;
  } catch (error) {
    console.error(`[Esprin Nemo] 读取${label}失败:`, error);
    return fallback;
  }
}

function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark';
}

function normalizeStyle(value) {
  return value === 'alom' ? 'alom' : 'default';
}

function normalizeRadius(value) {
  return RADIUS_VALUES.includes(value) ? value : 'default';
}

function normalizeAccent(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBrandColor(value) {
  return value === 'mono' || value === 'accent' ? value : 'brand';
}

function normalizeFonts(value) {
  const source = value && typeof value === 'object' ? value : {};
  const fonts = {};
  Object.keys(FONT_ARG_NAMES).forEach((key) => {
    fonts[key] = typeof source[key] === 'string' ? source[key].trim().replace(/["\\;{}]/g, '') : '';
  });
  return fonts;
}

// 整理成窗口创建所需的一组值：规范化后的外观 + 注入渲染进程的参数 + 窗口底色兜底
function buildWindowAppearance(values) {
  const source = values && typeof values === 'object' ? values : {};
  const theme = normalizeTheme(source.theme);
  const style = normalizeStyle(source.style);
  const radius = normalizeRadius(source.radius);
  const accent = normalizeAccent(source.accent);
  const brandColor = normalizeBrandColor(source.brandColor);
  const fonts = normalizeFonts(source.fonts);

  const args = [
    `${ARG_PREFIX}theme=${theme}`,
    `${ARG_PREFIX}style=${style}`,
    `${ARG_PREFIX}radius=${radius}`,
    `${ARG_PREFIX}accent=${accent}`,
    `${ARG_PREFIX}brand=${brandColor}`
  ];
  Object.keys(FONT_ARG_NAMES).forEach((key) => {
    args.push(`${ARG_PREFIX}${FONT_ARG_NAMES[key]}=${fonts[key]}`);
  });

  return {
    theme,
    style,
    radius,
    accent,
    brandColor,
    fonts,
    args,
    backgroundColor: THEME_BG[style][theme]
  };
}

module.exports = { buildWindowAppearance, safeResolve };
