/* 全局状态与常量 */

// State Store
const State = {
    notes: [],
    // 待办：与笔记同一套文件格式（多一个 isDone 完成状态），存放在数据目录的 todos/ 下
    todos: [],
    folders: ['默认'],
    activeNoteId: null,
    openNoteIds: [],
    // 中栏列表的筛选标识：all / pinned / trash / folder:<名称> / tag:<标签>，
    // 以及待办视图 todo:undone / todo:done / todo:trash
    currentFilter: 'all',
    searchQuery: '',
    sortBy: 'updated-desc',
    viewMode: 'edit',
    theme: 'system',
    // 主题色（强调色）：#RRGGBB，空字符串表示跟随主题使用内置默认色
    accentColor: '',
    // 左上角应用名文字颜色：brand（品牌色）/ mono（跟随明暗用黑白）/ accent（跟随主题色）
    brandColor: 'brand',
    spellcheck: false,
    // 侧边栏是否收起：收起后只保留一条窄条，筛选入口仅显示图标
    sidebarCollapsed: false,
    // 废纸篓自动清理：保留天数，0 表示永不自动清理
    trashRetentionDays: 0,
    // 自动更新：默认开启，启动后自动检查并在后台下载新版本
    autoUpdate: true,
    // 系统托盘：默认显示托盘图标，关闭后应用不再随窗口关闭而驻留
    trayEnabled: true,
    // 字体设置：空字符串表示跟随 CSS 中的默认字体栈
    fonts: { uiLatin: '', uiCjk: '', docLatin: '', docCjk: '' },
    // AI 助手接口配置（随 config.json 一起落盘）
    ai: { enabled: true, agentMode: false, baseUrl: '', model: '', scope: 'current', maxNotes: 10, systemPrompt: '' },
    // API Key 不随配置落盘：这里只保留「是否已保存」与保管方式（keychain / encrypted / plain），
    // 明文始终只存在于主进程与系统密钥链中
    aiHasApiKey: false,
    aiKeyStorage: '',
    // AI 助手面板：是否展开，以及多对话（一份对话一个文件，落在数据目录的 ai_chats/ 下）
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
