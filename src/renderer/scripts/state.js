/* 全局状态与常量 */

// State Store
const State = {
    notes: [],
    folders: ['默认'],
    activeNoteId: null,
    openNoteIds: [],
    currentFilter: 'all',
    searchQuery: '',
    sortBy: 'updated-desc',
    viewMode: 'edit',
    theme: 'system',
    // 主题色（强调色）：#RRGGBB，空字符串表示跟随主题使用内置默认色
    accentColor: '',
    spellcheck: false,
    // 废纸篓自动清理：保留天数，0 表示永不自动清理
    trashRetentionDays: 0,
    // 字体设置：空字符串表示跟随 CSS 中的默认字体栈
    fonts: { uiLatin: '', uiCjk: '', docLatin: '', docCjk: '' },
    autoSaveTimer: null,
    // MD 预览刷新的延时器：静默 1 秒后才刷新一次
    previewTimer: null
};

// 废纸篓自动清理的可选保留天数（0 = 永不自动清理，其余为保留天数）
const TRASH_RETENTION_DAY_OPTIONS = [0, 10, 30, 60, 365];
const TRASH_RETENTION_DAY_MS = 24 * 60 * 60 * 1000;
// 应用长时间驻留时按此间隔复查一次过期笔记
const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000;

// 只接受预设的天数，非法值（含旧配置里的脏数据）一律回退为“永不自动清理”
function normalizeTrashRetentionDays(value) {
    const days = Number(value);
    return TRASH_RETENTION_DAY_OPTIONS.includes(days) ? days : 0;
}
