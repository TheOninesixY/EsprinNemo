/* AI 多对话：对话记录的增删改查、标题推导，以及面板内的对话记录列表。
   一份对话一个文件，保存在数据目录的 ai_chats/{id}.json 中（当前选中的对话记在 config.json），
   随数据目录一起迁移与备份。 */

// 自动标题的最大长度（超出后截断加省略号）
const AI_CHAT_TITLE_MAX_LENGTH = 22;
// 仅切换当前对话（只改 config.json 里的 activeId）时，攒一下再落盘
const AI_CHAT_SAVE_DELAY = 600;

// 对话数与单对话消息数上限定义在 storage.js（AI_CHAT_LIMIT / AI_CHAT_MESSAGE_LIMIT），
// 落盘时的规范化与界面上的清理共用同一组常量。

let aiChatsSaveTimer = null;
let aiDrawerOpen = false;

// ---------- 对话模型 ----------

function findAiConversation(id) {
    return State.aiConversations.find(chat => chat.id === id) || null;
}

function createAiConversation() {
    const now = Date.now();
    return { id: generateAiChatId(), title: '', messages: [], createdAt: now, updatedAt: now };
}

// 与笔记 ID 同一套随机规则：10 位随机字符作为文件名
function generateAiChatId() {
    let id = generateNoteId();
    while (findAiConversation(id) || fs.existsSync(path.join(AI_CHATS_DIR, `${id}.json`))) {
        id = generateNoteId();
    }
    return id;
}

// 内存中至少保留一个对话，并保证 activeId 始终指向存在的对话
function ensureAiConversations() {
    if (!Array.isArray(State.aiConversations)) State.aiConversations = [];
    if (!State.aiConversations.length) {
        State.aiConversations.push(createAiConversation());
    }
    let chat = findAiConversation(State.aiActiveConversationId);
    if (!chat) {
        chat = State.aiConversations[0];
        State.aiActiveConversationId = chat.id;
    }
    return chat;
}

// 当前对话：所有发消息、渲染都基于它
function activeAiConversation() {
    return ensureAiConversations();
}

// 当前对话的消息数组：直接用它的引用做增删，避免多处各存一份
function activeAiMessages() {
    return activeAiConversation().messages;
}

// 按最后使用时间倒序，保证列表与“最近使用”一致
function sortAiConversations() {
    State.aiConversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// 记录一次使用：刷新时间并把它挪到列表最前
function touchAiConversation(chat) {
    if (!chat) return;
    chat.updatedAt = Date.now();
    sortAiConversations();
}

// 超出上限时按使用时间清理，当前对话始终保留
function trimAiConversations() {
    if (State.aiConversations.length <= AI_CHAT_LIMIT) return;

    const keepIds = new Set(
        State.aiConversations
            .slice()
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, AI_CHAT_LIMIT)
            .map(chat => chat.id)
    );
    if (State.aiActiveConversationId) keepIds.add(State.aiActiveConversationId);
    // 被裁掉的对话连同文件与图片附件一起删除，磁盘上不留孤儿数据
    State.aiConversations
        .filter(chat => !keepIds.has(chat.id))
        .forEach((chat) => {
            releaseAiAttachments(chat.messages);
            deleteAiChatFile(chat.id);
        });
    State.aiConversations = State.aiConversations.filter(chat => keepIds.has(chat.id));
    sortAiConversations();
}

// 对话标题：用户重命名过就用它，否则以第一条提问自动生成
function aiChatDisplayTitle(chat) {
    if (chat.title) return chat.title;
    const firstQuestion = chat.messages.find(msg => msg.role === 'user' && msg.content);
    return firstQuestion ? deriveAiChatTitle(firstQuestion.content) : '新对话';
}

function deriveAiChatTitle(text) {
    const line = String(text || '').split('\n').map(part => part.trim()).find(Boolean) || '';
    const cleaned = line.replace(/[#>*`_~]+/g, '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return '新对话';
    return cleaned.length > AI_CHAT_TITLE_MAX_LENGTH
        ? `${cleaned.slice(0, AI_CHAT_TITLE_MAX_LENGTH)}…`
        : cleaned;
}

// ---------- 落盘 ----------

// 对话本体在 switchAiConversation / 发消息等处按份保存，这里只管“当前选中哪一份”，
// 它记在 config.json 中，因此只切对话时不会产生多余的对话文件写入
function scheduleSaveActiveAiChat() {
    clearTimeout(aiChatsSaveTimer);
    aiChatsSaveTimer = setTimeout(() => {
        aiChatsSaveTimer = null;
        saveConfig();
    }, AI_CHAT_SAVE_DELAY);
}

function flushActiveAiChatSave() {
    if (!aiChatsSaveTimer) return;
    clearTimeout(aiChatsSaveTimer);
    aiChatsSaveTimer = null;
    saveConfig();
}

// 接管一份对话记录（启动载入、切换数据目录时调用）
function adoptAiChats(chats) {
    const source = (chats && typeof chats === 'object') ? chats : {};
    State.aiConversations = Array.isArray(source.conversations) ? source.conversations : [];
    State.aiActiveConversationId = typeof source.activeId === 'string' ? source.activeId : '';
    ensureAiConversations();
    closeAiDrawer();
}

// ---------- 对话操作 ----------

// 新建对话：当前对话还是一张白纸时直接复用它，避免连点攒出一堆空对话
function newAiConversation() {
    const current = activeAiConversation();
    if (current.messages.length) {
        const chat = createAiConversation();
        State.aiConversations.unshift(chat);
        State.aiActiveConversationId = chat.id;
        trimAiConversations();
        // 新对话落盘为一份独立文件，当前对话的切换记到 config.json
        saveAiChat(chat);
        saveConfig();
    }

    closeAiDrawer();
    renderAiMessages();
    renderAiChatList();
    updateAiScopeOptions();
    updateAiComposerState();
    focusAiInput();
    return activeAiConversation();
}

function switchAiConversation(id) {
    const chat = findAiConversation(id);
    if (!chat) return;
    if (chat.id !== State.aiActiveConversationId) {
        State.aiActiveConversationId = chat.id;
        // 只换了当前对话，攒一下再写，避免连点产生多次写入
        scheduleSaveActiveAiChat();
    }
    closeAiDrawer();
    renderAiMessages();
    renderAiChatList();
    updateAiScopeOptions();
    updateAiComposerState();
    focusAiInput();
}

async function deleteAiConversation(id) {
    const chat = findAiConversation(id);
    if (!chat) return;

    const rounds = chat.messages.filter(msg => msg.role === 'user').length;
    const confirmed = await showConfirm(`删除对话“${aiChatDisplayTitle(chat)}”？`, {
        title: '删除对话',
        detail: `${rounds ? `其中的 ${rounds} 轮问答将` : '该对话将'}连同 ai_chats 下的对话文件一并从本机永久移除，此操作无法撤销。`,
        type: 'warning',
        icon: 'delete_forever',
        confirmLabel: '删除',
        danger: true
    });
    if (!confirmed) return;

    // 正在往这个对话里写回答时先停掉，避免继续写入已被删除的对话
    if (State.aiStreaming && State.aiStreamingChatId === id) stopAiGeneration();

    State.aiConversations = State.aiConversations.filter(item => item.id !== id);
    // 对话文件与其中的图片附件同步删除，不留孤儿数据
    deleteAiChatFile(id);
    releaseAiAttachments(chat.messages);

    if (State.aiActiveConversationId === id) {
        State.aiActiveConversationId = State.aiConversations.length ? State.aiConversations[0].id : '';
    }
    // 删掉最后一个时立刻补一个空白对话，界面不会出现“无对话可用”的状态
    ensureAiConversations();
    // 当前对话可能已变化，写回 config.json
    saveConfig();
    renderAiMessages();
    renderAiChatList();
    updateAiScopeOptions();
    updateAiComposerState();
    showToast('已删除对话');
}

async function renameAiConversation(id) {
    const chat = findAiConversation(id);
    if (!chat) return;

    const value = await showPrompt('对话名称', {
        title: '重命名对话',
        value: chat.title || '',
        placeholder: '留空则按第一条提问自动命名',
        confirmLabel: '保存'
    });
    if (value === null) return;

    chat.title = value.slice(0, 60);
    touchAiConversation(chat);
    saveAiChat(chat);
    renderAiChatList();
    showToast(value ? '已重命名对话' : '已恢复自动标题');
}

// ---------- 对话记录抽屉 ----------

function openAiDrawer() {
    const drawer = document.getElementById('ai-drawer');
    if (!drawer) return;
    aiDrawerOpen = true;
    drawer.classList.remove('hidden');
    renderAiChatList();
}

function closeAiDrawer() {
    aiDrawerOpen = false;
    const drawer = document.getElementById('ai-drawer');
    if (drawer) drawer.classList.add('hidden');
}

function toggleAiDrawer() {
    if (aiDrawerOpen) closeAiDrawer();
    else openAiDrawer();
}

function createAiChatActionButton(icon, title, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ai-chat-action${icon === 'delete' ? ' danger' : ''}`;
    btn.title = title;
    btn.innerHTML = `<span class="ms-icon xs">${icon}</span>`;
    btn.onclick = (event) => {
        event.stopPropagation(); // 避免顺带触发所在条目的“切换对话”
        handler();
    };
    return btn;
}

function renderAiChatList() {
    const list = document.getElementById('ai-chat-list');
    if (!list) return;

    sortAiConversations();
    list.innerHTML = '';

    if (!State.aiConversations.length) {
        const empty = document.createElement('div');
        empty.className = 'ai-chat-empty';
        empty.textContent = '还没有对话记录';
        list.appendChild(empty);
        return;
    }

    State.aiConversations.forEach((chat) => {
        const item = document.createElement('div');
        item.className = `ai-chat-item${chat.id === State.aiActiveConversationId ? ' active' : ''}`;
        item.onclick = () => switchAiConversation(chat.id);

        const main = document.createElement('div');
        main.className = 'ai-chat-item-main';

        const title = document.createElement('div');
        title.className = 'ai-chat-item-title';
        title.textContent = aiChatDisplayTitle(chat);

        const rounds = chat.messages.filter(msg => msg.role === 'user').length;
        const streaming = State.aiStreaming && chat.id === State.aiStreamingChatId;
        const meta = document.createElement('div');
        meta.className = `ai-chat-item-meta${streaming ? ' streaming' : ''}`;
        const parts = [];
        if (streaming) parts.push('生成中');
        parts.push(rounds ? `${rounds} 轮问答` : '还没有提问');
        parts.push(formatDate(chat.updatedAt));
        meta.textContent = parts.join(' · ');

        main.appendChild(title);
        main.appendChild(meta);
        item.appendChild(main);

        const actions = document.createElement('div');
        actions.className = 'ai-chat-item-actions';
        actions.appendChild(createAiChatActionButton('edit', '重命名', () => renameAiConversation(chat.id)));
        actions.appendChild(createAiChatActionButton('delete', '删除', () => deleteAiConversation(chat.id)));
        item.appendChild(actions);

        list.appendChild(item);
    });
}

function initAiChats() {
    const drawer = document.getElementById('ai-drawer');
    if (!drawer) return;

    const newBtn = document.getElementById('btn-ai-new-chat');
    if (newBtn) newBtn.onclick = () => newAiConversation();

    const drawerNewBtn = document.getElementById('btn-ai-drawer-new');
    if (drawerNewBtn) drawerNewBtn.onclick = () => newAiConversation();

    const historyBtn = document.getElementById('btn-ai-history');
    if (historyBtn) historyBtn.onclick = toggleAiDrawer;

    const drawerCloseBtn = document.getElementById('btn-ai-drawer-close');
    if (drawerCloseBtn) drawerCloseBtn.onclick = closeAiDrawer;

    // 关闭窗口前把攒着的改动落盘（切换对话后只改了 config.json 里的当前对话 id）
    window.addEventListener('beforeunload', flushActiveAiChatSave);

    renderAiChatList();
}
