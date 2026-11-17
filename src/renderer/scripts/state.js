const VOICE_LANGUAGE_VALUES = ['zh-CN', 'en-US', 'ja-JP'];
const VOICE_DEFAULT_LANGUAGE = 'zh-CN';

function normalizeVoiceLanguage(value) {
    return VOICE_LANGUAGE_VALUES.includes(value) ? value : VOICE_DEFAULT_LANGUAGE;
}

const State = {
    notes: [],

    todos: [],
    folders: ['默认'],
    activeNoteId: null,
    openNoteIds: [],

currentFilter: 'all',
    searchQuery: '',
    sortBy: 'updated-desc',
    viewMode: 'edit',
    theme: 'system',

    themeStyle: 'default',

    accentColor: 'system',

    cornerRadius: 'default',

uiScale: 1,
    spellcheck: false,

filterFolder: '',
    filterTag: '',

    sidebarBlur: true,

    glassTransparent: false,

    sidebarCollapsed: true,

    trashRetentionDays: 0,

    autoUpdate: true,

    ghProxyEnabled: false,

    autoLaunch: false,

    trayEnabled: true,

    stickyNotes: { enabled: true, color: 'yellow' },

syncServer: {

        enabled: false,
        url: '',
        device: '',

autoSync: 'off',
        autoSyncSeconds: 60,
        lastSyncAt: 0,
        lastSyncSummary: ''
    },

syncServerLoaded: false,
    syncTokenSaved: false,
    syncTokenStrong: false,

    fonts: { uiLatin: '', uiCjk: '', docLatin: '', docCjk: '' },

    ai: { enabled: true, agentMode: false, baseUrl: '', model: '', scope: 'current', maxNotes: 10, systemPrompt: '' },

aiHasApiKey: false,
    aiKeyStorage: '',

    aiPanelOpen: false,
    fmPanelOpen: false,
    aiConversations: [],
    aiActiveConversationId: '',

    aiStreaming: false,
    aiRequestId: null,
    aiStreamingChatId: null,

    aiPendingAttachments: [],

    aiScope: 'current',

    voice: { enabled: true, lang: VOICE_DEFAULT_LANGUAGE },
    autoSaveTimer: null,

    previewTimer: null
};

const STICKY_COLOR_VALUES = ['yellow', 'green', 'blue', 'pink', 'purple', 'gray'];

function normalizeStickyConfig(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        enabled: source.enabled !== false,
        color: STICKY_COLOR_VALUES.includes(source.color) ? source.color : 'yellow'
    };
}

function isModernLayout() {
    return true;
}

const AI_SCOPE_VALUES = ['current', 'all', 'none'];

function normalizeAiScope(value) {
    return AI_SCOPE_VALUES.includes(value) ? value : 'current';
}

const TRASH_RETENTION_DAY_OPTIONS = [0, 10, 30, 60, 365];
const TRASH_RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000;

function normalizeTrashRetentionDays(value) {
    const days = Number(value);
    return TRASH_RETENTION_DAY_OPTIONS.includes(days) ? days : 0;
}
