const ARG_PREFIX = '--esprin-nemo-window-';

const RADIUS_VALUES = ['square', 'slight', 'large'];

const FONT_ARG_NAMES = {
  uiLatin: 'font-ui-latin',
  uiCjk: 'font-ui-cjk',
  docLatin: 'font-doc-latin',
  docCjk: 'font-doc-cjk'
};

const THEME_BG = {
  dark: '#0d1117',
  light: '#ffffff'
};

function safeResolve(resolver, fallback, label) {
  if (typeof resolver !== 'function') return fallback;
  try {
    const value = resolver();
    return value == null ? fallback : value;
  } catch (error) {
    console.error(`[EsprinNemo] 读取${label}失败:`, error);
    return fallback;
  }
}

function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark';
}

function normalizeRadius(value) {
  return RADIUS_VALUES.includes(value) ? value : 'default';
}

function normalizeAccent(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFonts(value) {
  const source = value && typeof value === 'object' ? value : {};
  const fonts = {};
  Object.keys(FONT_ARG_NAMES).forEach((key) => {
    fonts[key] = typeof source[key] === 'string' ? source[key].trim().replace(/["\\;{}]/g, '') : '';
  });
  return fonts;
}

function buildWindowAppearance(values) {
  const source = values && typeof values === 'object' ? values : {};
  const theme = normalizeTheme(source.theme);
  const radius = normalizeRadius(source.radius);
  const accent = normalizeAccent(source.accent);
  const fonts = normalizeFonts(source.fonts);

  const args = [
    `${ARG_PREFIX}theme=${theme}`,
    `${ARG_PREFIX}radius=${radius}`,
    `${ARG_PREFIX}accent=${accent}`
  ];
  Object.keys(FONT_ARG_NAMES).forEach((key) => {
    args.push(`${ARG_PREFIX}${FONT_ARG_NAMES[key]}=${fonts[key]}`);
  });

  return {
    theme,
    radius,
    accent,
    fonts,
    args,
    backgroundColor: THEME_BG[theme]
  };
}

module.exports = { buildWindowAppearance, safeResolve };
