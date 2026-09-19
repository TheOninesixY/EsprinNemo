/* AI 助手对话面板：把笔记作为上下文提问，回答以流式方式逐步显示。
   面板内可同时保留多份对话记录（见 ai_chats.js），对话内容随数据目录落到 ai_chats.json。 */

// 上下文字符预算：单篇与总量都设上限，避免一次提问塞进过多内容把请求撑爆
const AI_SINGLE_NOTE_CHAR_LIMIT = 6000;
const AI_TOTAL_CONTEXT_CHAR_LIMIT = 40000;
// 随请求携带的历史消息条数上限（不含系统消息），保证请求体不会随对话无限增长
const AI_HISTORY_MESSAGE_LIMIT = 12;
// 流式输出期间的刷新间隔：太频繁会拖慢长回答的渲染
const AI_STREAM_RENDER_INTERVAL_MS = 80;

const AI_DEFAULT_SYSTEM_PROMPT = '你是 EsprinNemo 笔记应用内置的 AI 助手。请用简体中文、简明扼要地回答用户关于其笔记的问题，'
    + '回答尽量使用 Markdown；当笔记中没有相关信息时请明确说明，不要编造内容。';

let aiStreamTimer = null;

// ---------- 上下文组装 ----------

function formatAiTime(timestamp) {
    const time = Number(timestamp);
    if (!Number.isFinite(time)) return '未知';
    return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

// 按当前范围取出要附带的笔记：范围、数量上限都在这里落地
function collectAiContextNotes() {
    if (State.aiScope === 'none') return [];

    const maxNotes = Math.max(1, Number(State.ai && State.ai.maxNotes) || 10);
    if (State.aiScope === 'current') {
        const active = getActiveNote();
        return active ? [active] : [];
    }

    // 全部笔记：置顶优先，再按最后修改时间由新到旧
    return State.notes
        .filter(note => !note.isTrashed)
        .sort((a, b) => (b.isPinned - a.isPinned) || ((b.updatedAt || 0) - (a.updatedAt || 0)))
        .slice(0, maxNotes);
}

// 把选中的笔记拼成一段供模型参考的系统消息
function buildAiContextMessage() {
    const candidates = collectAiContextNotes();
    if (!candidates.length) return null;

    const blocks = [];
    const included = [];
    let used = 0;

    candidates.forEach((note) => {
        const content = String(note.content || '').trim();
        if (!content) return;
        const remaining = AI_TOTAL_CONTEXT_CHAR_LIMIT - used;
        if (remaining <= 200) return;

        const limit = Math.min(AI_SINGLE_NOTE_CHAR_LIMIT, remaining);
        const truncated = content.length > limit;
        const body = truncated ? `${content.slice(0, limit)}\n…（内容过长，已截断）` : content;
        used += body.length;

        const tags = Array.isArray(note.tags) && note.tags.length
            ? `；标签：${note.tags.map(tag => `#${tag}`).join(' ')}`
            : '';
        blocks.push([
            `【笔记】${note.title || '未命名笔记'}`,
            `文件夹：${note.folder || '默认'}${tags}`,
            `最后修改：${formatAiTime(note.updatedAt)}`,
            '',
            body
        ].join('\n'));
        included.push(note);
    });

    if (!blocks.length) return null;
    return {
        count: blocks.length,
        content: `以下是用户笔记库中的 ${blocks.length} 篇笔记，请优先依据这些内容回答；`
            + `笔记中没有的信息请说明未找到。\n\n${blocks.join('\n\n---\n\n')}`
    };
}

// 组装本次请求的消息列表：系统提示 → 笔记上下文 → 近期对话 → 本次提问
function buildAiRequestMessages(question) {
    const messages = [];
    const systemPrompt = (State.ai.systemPrompt || '').trim() || AI_DEFAULT_SYSTEM_PROMPT;
    messages.push({ role: 'system', content: systemPrompt });

    const context = buildAiContextMessage();
    if (context) messages.push({ role: 'system', content: context.content });

    activeAiMessages()
        .slice(-AI_HISTORY_MESSAGE_LIMIT)
        .forEach((msg) => {
            if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
                messages.push({ role: msg.role, content: msg.content });
            }
        });

    if (!context && State.aiScope !== 'none') {
        // 范围是当前笔记但当前没有打开笔记：明确告诉模型缺少上下文，避免它凭空作答
        messages.push({ role: 'system', content: '本次提问没有附带任何笔记内容，请按通用知识回答，并提醒用户当前没有可参考的笔记。' });
    }

    messages.push({ role: 'user', content: question });
    return { messages, context };
}

// ---------- 界面渲染 ----------

function scrollAiToBottom() {
    const container = document.getElementById('ai-messages');
    if (container) container.scrollTop = container.scrollHeight;
}

// 把焦点交回输入框（新建/切换对话后直接可以打字）
function focusAiInput() {
    const input = document.getElementById('ai-input');
    if (input) input.focus();
}

function createAiActionButton(label, icon, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-msg-action';
    btn.innerHTML = `<span class="ms-icon xs">${icon}</span><span>${escapeHTML(label)}</span>`;
    btn.onclick = handler;
    return btn;
}

function createAiMessageActions(msg) {
    const bar = document.createElement('div');
    bar.className = 'ai-msg-actions';

    bar.appendChild(createAiActionButton('复制', 'content_copy', () => {
        try {
            require('electron').clipboard.writeText(msg.content || '');
            showToast('已复制回答');
        } catch (err) {
            console.error('复制回答失败:', err);
            showToast('复制失败');
        }
    }));
    bar.appendChild(createAiActionButton('插入当前笔记', 'playlist_add', () => insertAiAnswerToNote(msg.content || '')));
    bar.appendChild(createAiActionButton('存为新笔记', 'note_add', () => saveAiAnswerAsNote(msg.content || '')));
    return bar;
}

function createAiMessageElement(msg, index) {
    const wrap = document.createElement('div');
    const stateClass = msg.error ? (msg.canceled ? ' ai-msg-canceled' : ' ai-msg-failed') : '';
    wrap.className = `ai-msg ai-msg-${msg.role}${stateClass}`;
    wrap.dataset.index = String(index);

    const role = document.createElement('div');
    role.className = 'ai-msg-role';
    role.innerHTML = msg.role === 'user'
        ? '<span class="ms-icon xs">person</span><span>你</span>'
        : '<span class="ms-icon xs">smart_toy</span><span>AI 助手</span>';
    if (msg.role === 'user' && msg.contextLabel) {
        const meta = document.createElement('span');
        meta.className = 'ai-msg-context';
        meta.textContent = msg.contextLabel;
        role.appendChild(meta);
    }
    wrap.appendChild(role);

    const body = document.createElement('div');
    body.className = 'ai-msg-body';
    const content = document.createElement('div');
    content.className = 'ai-msg-content';

    if (msg.error) {
        content.classList.add('ai-msg-error');
        content.textContent = msg.error;
    } else if (msg.role === 'assistant') {
        content.classList.add('markdown-body');
        content.innerHTML = msg.content ? marked.parse(msg.content) : '';
        if (!msg.content) content.innerHTML = '<span class="ai-typing">正在生成…</span>';
    } else {
        content.textContent = msg.content;
    }

    body.appendChild(content);
    wrap.appendChild(body);

    if (msg.role === 'assistant' && !msg.error && msg.content) {
        wrap.appendChild(createAiMessageActions(msg));
    }
    return wrap;
}

function renderAiMessages() {
    const container = document.getElementById('ai-messages');
    if (!container) return;

    const messages = activeAiMessages();
    const empty = document.getElementById('ai-empty');
    if (empty) empty.classList.toggle('hidden', messages.length > 0);

    container.querySelectorAll('.ai-msg').forEach(el => el.remove());
    messages.forEach((msg, index) => container.appendChild(createAiMessageElement(msg, index)));
    scrollAiToBottom();
}

// 流式增量：先按纯文本更新，等回答结束后再整体解析 Markdown
function scheduleAiStreamRender() {
    if (aiStreamTimer) return;
    aiStreamTimer = setTimeout(() => {
        aiStreamTimer = null;
        const container = document.getElementById('ai-messages');
        // 增量可能来自用户已经切走的那个对话，只有它同时也是当前对话时才动 DOM
        const chat = findAiConversation(State.aiStreamingChatId);
        if (!chat || chat.id !== State.aiActiveConversationId) return;

        const msg = chat.messages[chat.messages.length - 1];
        if (!container || !msg || msg.role !== 'assistant') return;

        const items = container.querySelectorAll('.ai-msg-content');
        const el = items[items.length - 1];
        if (!el) return;
        el.textContent = msg.content;
        container.scrollTop = container.scrollHeight;
    }, AI_STREAM_RENDER_INTERVAL_MS);
}

// 面板顶部：模型名 + 是否处于配置完成状态
function updateAiPanelHeader() {
    const modelLabel = document.getElementById('ai-panel-model');
    if (modelLabel) {
        const model = State.ai && State.ai.model ? State.ai.model : '';
        modelLabel.textContent = model || '未配置模型';
        modelLabel.title = model || '前往「设置 → AI 助手」完成配置';
    }
}

// 输入框下方：本次提问会附带哪些笔记
function updateAiContextHint() {
    const hint = document.getElementById('ai-context-hint');
    if (!hint) return;

    if (State.aiScope === 'none') {
        hint.textContent = '不附带笔记';
        return;
    }
    if (State.aiScope === 'current') {
        const note = getActiveNote();
        hint.textContent = note ? `附带：${note.title || '未命名笔记'}` : '当前没有打开的笔记';
        return;
    }
    const count = collectAiContextNotes().length;
    hint.textContent = count ? `附带 ${count} 篇笔记` : '没有可附带的笔记';
}

function updateAiComposerState() {
    const input = document.getElementById('ai-input');
    const sendBtn = document.getElementById('btn-ai-send');
    const stopBtn = document.getElementById('btn-ai-stop');

    if (sendBtn) sendBtn.disabled = State.aiStreaming || !input || !input.value.trim();
    if (stopBtn) stopBtn.classList.toggle('hidden', !State.aiStreaming);
}

// ---------- 面板开关 ----------

function applyAiPanelVisibility() {
    const panel = document.getElementById('ai-panel');
    const btn = document.getElementById('btn-ai-assistant');
    if (!panel) return;
    // 总开关关闭时面板一律不显示；设置页占据整个窗口，此时同样不显示
    const visible = isAiEnabled() && !!State.aiPanelOpen && State.activeNoteId !== 'settings';
    panel.classList.toggle('hidden', !visible);
    if (btn) btn.classList.toggle('active', visible);
    if (!visible) closeAiDrawer();
}

function setAiPanelOpen(open) {
    State.aiPanelOpen = !!open && isAiEnabled();
    applyAiPanelVisibility();
    if (!State.aiPanelOpen) {
        // 面板收起时对话列表也一并收起，下次打开回到消息视图
        closeAiDrawer();
        return;
    }

    updateAiPanelHeader();
    updateAiContextHint();
    updateAiComposerState();
    renderAiMessages();
    renderAiChatList();
    const input = document.getElementById('ai-input');
    if (input) input.focus();
}

// 未配置时把用户直接送到设置页的 AI 分类，而不是只弹一句提示
function openAiSettingsPanel() {
    setAiPanelOpen(false);
    openSettingsTab();
    switchSettingsCategory('ai');
}

function toggleAiAssistant() {
    if (!isAiEnabled()) return;
    if (State.aiPanelOpen) {
        setAiPanelOpen(false);
        return;
    }
    if (!isAiConfigured()) {
        showToast('请先配置 API 站点与模型');
        openAiSettingsPanel();
        return;
    }
    // 停在设置页时先切回工作区，否则面板会被设置页挡住
    if (State.activeNoteId === 'settings') {
        State.activeNoteId = State.openNoteIds.filter(id => id !== 'settings').pop() || null;
        renderApp();
    }
    setAiPanelOpen(true);
}

// 清空当前对话：保留这份对话、只丢掉消息，与“删除对话”区分开
async function clearAiConversation() {
    if (State.aiStreaming) {
        showToast('请先停止当前的生成');
        return;
    }
    const chat = activeAiConversation();
    if (!chat.messages.length) return;

    const confirmed = await showConfirm('清空当前对话？', {
        title: '清空对话',
        detail: `${chat.messages.length} 条消息将从本机 ai_chats.json 中移除，此操作无法撤销。`,
        icon: 'delete_sweep',
        confirmLabel: '清空'
    });
    if (!confirmed) return;

    chat.messages = [];
    chat.title = '';
    touchAiConversation(chat);
    saveAiChats();
    renderAiMessages();
    renderAiChatList();
    showToast('已清空对话');
}

function stopAiGeneration() {
    if (!State.aiStreaming || !State.aiRequestId) return;
    const requestId = State.aiRequestId;
    ipcRenderer.invoke('ai:abort', { requestId }).catch((err) => {
        console.error('停止生成失败:', err);
    });
}

// ---------- 提问 ----------

async function sendAiQuestion() {
    if (State.aiStreaming) {
        // 同一时刻只跑一个请求：此时可能正在给另一份对话生成回答
        showToast('正在生成回答，请先停止或等待完成');
        return;
    }
    // 总开关关闭后不再发起任何请求
    if (!isAiEnabled()) return;

    const input = document.getElementById('ai-input');
    const question = input ? input.value.trim() : '';
    if (!question) return;

    if (!isAiConfigured()) {
        showToast('请先配置 API 站点与模型');
        openAiSettingsPanel();
        return;
    }

    // 上下文必须是最新内容：先把编辑器里未落盘的改动提交到笔记对象
    flushPendingSave();
    // 主进程从 config.json 读取接口配置，提问前确保刚改的配置已落盘
    flushAiConfigSave();

    // 消息固定落在发送时所在的对话上：中途切换对话也不会把回答写进别的对话
    const chat = activeAiConversation();
    if (chat.messages.length > AI_CHAT_MESSAGE_LIMIT) {
        chat.messages = chat.messages.slice(-AI_CHAT_MESSAGE_LIMIT);
    }

    const { messages, context } = buildAiRequestMessages(question);
    const contextLabel = State.aiScope === 'none'
        ? '不附带笔记'
        : (context ? `附带 ${context.count} 篇笔记` : '没有可附带的笔记');

    chat.messages.push({ role: 'user', content: question, contextLabel, createdAt: Date.now() });
    chat.messages.push({ role: 'assistant', content: '', pending: true, createdAt: Date.now() });
    const answerIndex = chat.messages.length - 1;
    touchAiConversation(chat);

    if (input) input.value = '';
    State.aiStreaming = true;
    State.aiStreamingChatId = chat.id;
    State.aiRequestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestId = State.aiRequestId;

    renderAiMessages();
    renderAiChatList(); // 新对话的第一条提问会决定它的显示标题与排序
    updateAiComposerState();

    let result = null;
    try {
        result = await ipcRenderer.invoke('ai:chat', { requestId, messages });
    } catch (err) {
        console.error('AI 请求失败:', err);
        result = { ok: false, error: '请求失败：无法与主进程通信' };
    }

    // 仅当这次请求仍是当前请求时才收尾，避免"停止后又收到上一轮结果"的错乱
    if (State.aiRequestId !== requestId) return;
    State.aiStreaming = false;
    State.aiRequestId = null;
    State.aiStreamingChatId = null;

    // 对话可能在生成期间被删除，这里按 id 回查，找不到就当此次回答作废
    const target = findAiConversation(chat.id);
    const answer = target ? target.messages[answerIndex] : null;
    if (answer && answer.role === 'assistant') {
        answer.pending = false;
        if (result && result.ok) {
            answer.content = result.content;
        } else {
            answer.content = '';
            answer.error = (result && result.error) || '请求失败';
            // 用户主动停止不算错误，用弱化的样式展示
            answer.canceled = !!(result && result.canceled);
        }
        touchAiConversation(target);
    }
    // 回答完整落盘（生成过程中的增量不写盘，避免频繁 I/O）
    saveAiChats();

    renderAiMessages();
    renderAiChatList();
    updateAiComposerState();
    updateAiContextHint();
}

// ---------- 回答的落地方式 ----------

function insertAiAnswerToNote(content) {
    const note = getActiveNote();
    if (!note) {
        showToast('请先打开一篇笔记');
        return;
    }
    if (isReadOnlyNote(note)) {
        showToast('废纸篓中的笔记为只读，无法写入');
        return;
    }

    flushPendingSave();
    const base = String(note.content || '').replace(/\s+$/, '');
    note.content = base ? `${base}\n\n${content}` : content;

    // 与预览区勾选待办项的做法一致：同步编辑器输入框后再走自动保存
    const textarea = document.getElementById('textarea-note-content');
    if (textarea) textarea.value = note.content;
    autoSaveNote();
    flushRenderMarkdown();
    showToast('已插入到当前笔记');
}

function saveAiAnswerAsNote(content) {
    const defaults = newNoteDefaults();
    const now = Date.now();

    const note = {
        id: generateUniqueNoteId(),
        title: `AI 回答 · ${formatDate(now)}`,
        content,
        folder: defaults.folder,
        tags: defaults.tags,
        isPinned: false,
        isTrashed: false,
        createdAt: now,
        updatedAt: now
    };

    saveNoteContent(note);
    State.notes.unshift(note);
    openTab(note.id);
    saveIndex();
    renderApp();
    showToast('已存为新笔记');
}

// ---------- 初始化 ----------

function initAiPanel() {
    const input = document.getElementById('ai-input');
    if (!input) return;

    input.oninput = updateAiComposerState;
    // Enter 发送、Shift+Enter 换行；中文输入法组词过程中的回车不触发发送
    input.onkeydown = (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.isComposing) return;
        event.preventDefault();
        sendAiQuestion();
    };

    const scopeSelect = document.getElementById('ai-scope-select');
    if (scopeSelect) {
        scopeSelect.value = State.aiScope;
        scopeSelect.onchange = (event) => {
            State.aiScope = normalizeAiScope(event.target.value);
            updateAiContextHint();
        };
    }

    const sendBtn = document.getElementById('btn-ai-send');
    if (sendBtn) sendBtn.onclick = sendAiQuestion;
    const stopBtn = document.getElementById('btn-ai-stop');
    if (stopBtn) stopBtn.onclick = stopAiGeneration;
    const clearBtn = document.getElementById('btn-ai-clear');
    if (clearBtn) clearBtn.onclick = clearAiConversation;
    const closeBtn = document.getElementById('btn-ai-close');
    if (closeBtn) closeBtn.onclick = () => setAiPanelOpen(false);

    // 示例问题：点击后填进输入框，用户可再编辑
    document.querySelectorAll('#ai-empty .ai-example-chip').forEach((chip) => {
        chip.onclick = () => {
            input.value = chip.dataset.prompt || '';
            updateAiComposerState();
            input.focus();
        };
    });

    ipcRenderer.on('ai:stream', (event, payload) => {
        if (!payload || payload.requestId !== State.aiRequestId) return;

        // 增量写入发起请求时所在的对话；用户中途切走也不影响，切回来即可看到完整回答
        const chat = findAiConversation(State.aiStreamingChatId);
        if (!chat) return;
        const msg = chat.messages[chat.messages.length - 1];
        if (!msg || msg.role !== 'assistant') return;

        msg.content += payload.delta || '';
        if (chat.id === State.aiActiveConversationId) scheduleAiStreamRender();
    });

    updateAiPanelHeader();
    updateAiContextHint();
    updateAiComposerState();
}
