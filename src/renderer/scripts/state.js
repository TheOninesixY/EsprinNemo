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
    // 侧边栏是否收起：收起后只保留一条窄条，筛选入口仅显示图标
    sidebarCollapsed: false,
    // 废纸篓自动清理：保留天数，0 表示永不自动清理
    trashRetentionDays: 0,
    // 字体设置：空字符串表示跟随 CSS 中的默认字体栈
    fonts: { uiLatin: '', uiCjk: '', docLatin: '', docCjk: '' },
    // AI 助手接口配置（随 config.json 一起落盘，密钥仅存本机）
    ai: { enabled: true, agentMode: false, baseUrl: '', apiKey: '', model: '', scope: 'current', maxNotes: 10, systemPrompt: '' },
    // AI 助手面板：是否展开，以及多对话（对话记录随数据目录保存到 ai_chats.json）
    aiPanelOpen: false,
    aiConversations: [],
    aiActiveConversationId: '',
    // 是否有请求在飞，以及它固定写入哪个对话（中途切换对话也不会串台）
    aiStreaming: false,
    aiRequestId: null,
    aiStreamingChatId: null,
    // 已选好、还没发出去的附件（图片已落盘到 ai_files/）
    aiPendingAttachments: [],
    // 本次会话提问时附带的笔记范围：默认取配置中的设置
    aiScope: 'current',
    autoSaveTimer: null,
    // MD 预览刷新的延时器：静默 1 秒后才刷新一次
    previewTimer: null
};

// AI 提问时附带的笔记范围（config.json 中的 ai.scope 只接受这几个值）
const AI_SCOPE_VALUES = ['current', 'all', 'none'];

function normalizeAiScope(value) {
    return AI_SCOPE_VALUES.includes(value) ? value : 'current';
}

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
