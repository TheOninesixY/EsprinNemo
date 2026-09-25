/* 全局状态与常量 */

/* 随口记（语音转文本）的识别语言。这一组值同时是系统识别引擎的语种标识
   （Windows 桌面识别引擎按 CultureInfo 选取识别器），因此只接受这里列出的几项，
   界面上的显示名见 scripts/voice_notes.js 的 VOICE_LANG_LABELS。 */
const VOICE_LANGUAGE_VALUES = ['zh-CN', 'en-US', 'ja-JP'];
const VOICE_DEFAULT_LANGUAGE = 'zh-CN';

function normalizeVoiceLanguage(value) {
    return VOICE_LANGUAGE_VALUES.includes(value) ? value : VOICE_DEFAULT_LANGUAGE;
}

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
    // 主题风格（皮肤）：default 为内置的 GitHub 风格，alom 为 Alom 风格
    themeStyle: 'default',
    // 主题色（强调色）：#RRGGBB，空字符串表示跟随主题使用内置默认色
    accentColor: '',
    // 左上角应用名文字颜色：brand（品牌色）/ mono（跟随明暗用黑白）/ accent（跟随主题色）
    brandColor: 'brand',
    // 圆角尺度：square（方）/ slight（微圆角）/ default（默认）/ large（大）
    cornerRadius: 'default',
    // 界面尺寸（缩放比例）：1 为 100%，直接改 Chromium 缩放，只作用于主窗口
    //（取值规则见 boot.js 的 UI_SCALE_*，应用见 scripts/appearance.js）
    uiScale: 1,
    spellcheck: false,
    // 界面布局：modern（现代布局：不排标题栏，标签页移到工作区顶部，见 scripts/mode.js）
    // / classic（经典布局：标题栏与标签页照旧）；现代布局是默认布局
    uiMode: 'modern',
    // 现代布局下是否禁用标签页（只属于现代布局：经典布局的标签页归标题栏所有），
    // 默认关闭，也就是标签页默认开启
    tabsDisabled: false,
    // 侧边栏是否收起：收起后只保留一条窄条，筛选入口仅显示图标
    sidebarCollapsed: false,
    // 废纸篓自动清理：保留天数，0 表示永不自动清理
    trashRetentionDays: 0,
    // 自动更新：默认开启，启动后自动检查并在后台下载新版本
    autoUpdate: true,
    // gh-proxy 加速：默认关闭，打开后检查更新与下载安装包先经 gh-proxy 代理（见 main/updater.js）
    ghProxyEnabled: false,
    // 开机自启：默认关闭，开启后由主进程登记到系统的登录启动项
    autoLaunch: false,
    // 系统托盘：默认显示托盘图标，关闭后应用不再随窗口关闭而驻留
    trayEnabled: true,
    // 自建同步（随 config.json 落盘）：服务器地址、设备名、自动同步节奏，以及上次同步的时刻与结果。
    // 令牌不在配置里：它由主进程存进系统密钥链，这里只保留「是否已保存」（syncTokenSaved）
    syncServer: {
        // 默认关闭：填好服务器地址后再由用户打开
        enabled: false,
        url: '',
        device: '',
        // 自动同步：off / 5s / 1m / 5m / custom（custom 用 autoSyncSeconds）；
        // 开启同步后每次启动应用都会同步一次，与这里选了什么无关
        autoSync: 'off',
        autoSyncSeconds: 60,
        lastSyncAt: 0,
        lastSyncSummary: ''
    },
    // syncServer 是否已从 config.json 载入过（载入点在 app.js 与 data_location.js）：
    // 未载入时不把它写回配置，免得用这里的默认空值把用户填好的地址抹掉
    syncServerLoaded: false,
    syncTokenSaved: false,
    syncTokenStrong: false,
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
    /* 随口记（语音转文本，随 config.json 一起落盘）：入口开关与识别语言。
       识别由 Windows 自带的桌面识别引擎在本机完成，音频不出本机，没有联网档位 */
    voice: { enabled: true, lang: VOICE_DEFAULT_LANGUAGE },
    autoSaveTimer: null,
    // MD 预览刷新的延时器：静默 1 秒后才刷新一次
    previewTimer: null
};

// 界面布局（config.json 中的 uiMode 只接受这两个值，默认现代布局）
const UI_MODE_VALUES = ['classic', 'modern'];

// 现代布局先后叫过「Line 模式」「无Tab模式」与「极简模式」，旧配置里存的仍是 line / notab 与 minimal；
// 更早的经典布局则写作 standard。读到这些旧值就一并落到 modern / classic，
// 免得改名后老用户的偏好被当成脏数据丢回默认布局
function normalizeUiMode(value) {
    if (value === 'line' || value === 'notab' || value === 'minimal') return 'modern';
    if (value === 'standard') return 'classic';
    return UI_MODE_VALUES.includes(value) ? value : 'modern';
}

// 现代布局：界面与经典布局一致，只是不再排一条标题栏——标签页改在工作区顶部那一行
// （由 styles/mode.css 按 <html> 上的类名接手排版）
function isModernLayout() {
    return State.uiMode === 'modern';
}

// 标签栏是否收起：现代布局下的「禁用标签页」开关（config.json 的 tabsDisabled）。
// 经典布局的标签页归标题栏所有，这个开关在那里不生效
function isTabsDisabled() {
    return isModernLayout() && State.tabsDisabled === true;
}

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
