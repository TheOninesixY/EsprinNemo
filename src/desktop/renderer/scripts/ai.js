const AI_SINGLE_NOTE_CHAR_LIMIT = 6000;
const AI_TOTAL_CONTEXT_CHAR_LIMIT = 40000;

const AI_HISTORY_TURN_LIMIT = 8;

const AI_STREAM_RENDER_INTERVAL_MS = 80;

const AI_DEFAULT_SYSTEM_PROMPT = '你是 EsprinNemo 笔记应用内置的 AI 助手。请用简体中文、简明扼要地回答用户关于其笔记的问题，'
    + '回答尽量使用 Markdown；当笔记中没有相关信息时请明确说明，不要编造内容。';

let aiStreamTimer = null;

let aiTurnCancelRequested = false;

function formatAiTime(timestamp) {
    const time = Number(timestamp);
    if (!Number.isFinite(time)) return '未知';
    return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

function collectAiContextNotes() {
    if (State.aiScope === 'none') return [];

    const maxNotes = Math.max(1, Number(State.ai && State.ai.maxNotes) || 10);
    if (State.aiScope === 'current') {

        const active = getActiveItem();
        return active && isSecretRevealed(active) ? [active] : [];
    }

return State.notes
        .filter(note => !note.isTrashed && !isSecretHidden(note) && note.locked !== true)
        .sort((a, b) => (b.isPinned - a.isPinned) || ((b.updatedAt || 0) - (a.updatedAt || 0)))
        .slice(0, maxNotes);
}

function buildAiContextMessage() {
    const candidates = collectAiContextNotes();
    if (!candidates.length) return null;

    const blocks = [];
    const included = [];
    let used = 0;

    candidates.forEach((item) => {
        const content = String(item.content || '').trim();
        if (!content) return;
        const remaining = AI_TOTAL_CONTEXT_CHAR_LIMIT - used;
        if (remaining <= 200) return;

        const limit = Math.min(AI_SINGLE_NOTE_CHAR_LIMIT, remaining);
        const truncated = content.length > limit;
        const body = truncated ? `${content.slice(0, limit)}\n…（内容过长，已截断）` : content;
        used += body.length;

        const tags = Array.isArray(item.tags) && item.tags.length
            ? `；标签：${item.tags.map(tag => `#${tag}`).join(' ')}`
            : '';
        blocks.push([
            `【${itemKindLabel(item)}】${itemDisplayTitle(item)}`,
            `文件夹：${item.folder || '默认'}${tags}`,
            `最后修改：${formatAiTime(item.updatedAt)}`,
            '',
            body
        ].join('\n'));
        included.push(item);
    });

    if (!blocks.length) return null;
    return {
        count: blocks.length,
        content: `以下是用户笔记库中的 ${blocks.length} 条内容，请优先依据这些内容回答；`
            + `其中没有的信息请说明未找到。\n\n${blocks.join('\n\n---\n\n')}`
    };
}

function buildAiUserMessage(msg, includeImages) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    const parts = [];
    if (msg.content) parts.push(msg.content);

    attachments.forEach((file) => {
        if (file.kind === 'text') parts.push(`【附件：${file.name}】\n${file.content}`);
    });

    const images = attachments.filter(file => file.kind === 'image');
    if (images.length) {
        parts.push(images.map(file => `【图片：${file.name}】`).join('\n'));
    }

    const message = { role: 'user', content: parts.join('\n\n') };
    if (includeImages && images.length) {
        message.images = images.map(file => ({
            path: resolveAiAttachmentPath(file.file),
            mime: file.mime,
            name: file.name
        }));
    }
    return message;
}

function collectAiHistoryMessages(chat) {
    const includeSteps = isAiAgentMode();
    const all = chat.messages.filter(msg => !msg.pending);

let start = 0;
    let turns = 0;
    for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].role !== 'user') continue;
        turns++;
        if (turns >= AI_HISTORY_TURN_LIMIT) {
            start = i;
            break;
        }
    }

    const slice = all.slice(start);

    let lastUserIndex = -1;
    slice.forEach((msg, index) => {
        if (msg.role === 'user') lastUserIndex = index;
    });

    const messages = [];
    slice.forEach((msg, index) => {
        if (msg.role === 'user') {
            messages.push(buildAiUserMessage(msg, index === lastUserIndex));
            return;
        }

if (msg.role === 'tool') {
            if (!includeSteps) return;
            messages.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content || '{}' });
            return;
        }

        if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
            if (!includeSteps) return;
            messages.push({
                role: 'assistant',
                content: msg.content || '',
                tool_calls: msg.toolCalls.map(call => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments || '{}' }
                }))
            });
            return;
        }

        if (msg.role === 'assistant' && msg.content) {
            messages.push({ role: 'assistant', content: msg.content });
        }
    });

    return messages;
}

function buildAiRequestMessages(chat) {
    const messages = [];
    const systemPrompt = (State.ai.systemPrompt || '').trim() || AI_DEFAULT_SYSTEM_PROMPT;
    messages.push({ role: 'system', content: systemPrompt });

    if (isAiAgentMode()) {
        messages.push({
            role: 'system',
            content: '当前已开启 Agent 模式：你可以调用工具直接新建或修改用户的笔记。'
                + '请先查清楚要改的笔记与现有内容，再做最小必要的改动；改完后用一两句话说明做了什么。'
                + '不要向用户展示工具参数或原始 JSON。'
        });
    }

    const context = buildAiContextMessage();
    if (context) messages.push({ role: 'system', content: context.content });

    if (!context && State.aiScope !== 'none') {

        messages.push({ role: 'system', content: '本次提问没有附带任何笔记内容，请按通用知识回答，并提醒用户当前没有可参考的笔记。' });
    }

    collectAiHistoryMessages(chat).forEach(msg => messages.push(msg));
    return { messages, context };
}

function scrollAiToBottom() {
    const container = document.getElementById('ai-messages');
    if (container) container.scrollTop = container.scrollHeight;
}

function focusAiInput() {
    const input = document.getElementById('ai-input');
    if (input) input.focus();
}

const AI_MARKDOWN_CACHE = new WeakMap();

function renderAiMarkdown(msg) {
    const source = msg.content || '';
    const cached = AI_MARKDOWN_CACHE.get(msg);
    if (cached && cached.source === source) return cached.html;

    const html = source ? marked.parse(source) : '';
    AI_MARKDOWN_CACHE.set(msg, { source, html });
    return html;
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
    bar.appendChild(createAiActionButton('插入当前内容', 'playlist_add', () => insertAiAnswerToItem(msg.content || '')));
    bar.appendChild(createAiActionButton('存为新笔记', 'note_add', () => saveAiAnswerAsNote(msg.content || '')));
    return bar;
}

function createAiAgentStepElement(msg, toolResults) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg ai-msg-agent';

    const role = document.createElement('div');
    role.className = 'ai-msg-role';
    role.innerHTML = '<span class="ms-icon xs">smart_toy</span><span>AI 操作</span>';
    wrap.appendChild(role);

    const body = document.createElement('div');
    body.className = 'ai-msg-body ai-agent-steps';

if (msg.content) {
        const text = document.createElement('div');
        text.className = 'ai-msg-content markdown-body';
        text.innerHTML = renderAiMarkdown(msg);
        body.appendChild(text);
    }

    msg.toolCalls.forEach((call) => {
        const result = toolResults.get(call.id) || null;
        const failed = !!result && result.ok === false;

        const step = document.createElement('div');
        step.className = `ai-step${failed ? ' failed' : ''}${result ? '' : ' running'}`;

        const icon = document.createElement('span');
        icon.className = 'ms-icon xs';
        icon.textContent = !result ? 'progress_activity' : (failed ? 'error' : 'check_circle');
        step.appendChild(icon);

        const info = document.createElement('div');
        info.className = 'ai-step-info';

        const label = document.createElement('div');
        label.className = 'ai-step-label';
        label.textContent = (result && result.summary) || `正在调用 ${call.name}…`;
        info.appendChild(label);

        if (result && result.detail) {
            const detail = document.createElement('div');
            detail.className = 'ai-step-detail';
            detail.textContent = result.detail;
            info.appendChild(detail);
        }
        step.appendChild(info);

        if (result && result.stepId && canUndoAiAgentStep(result.stepId)) {
            const undoBtn = document.createElement('button');
            undoBtn.type = 'button';
            undoBtn.className = 'ai-msg-action';
            undoBtn.innerHTML = '<span class="ms-icon xs">undo</span><span>撤销</span>';
            undoBtn.onclick = () => {
                undoAiAgentStep(result.stepId);
                renderAiMessages();
            };
            step.appendChild(undoBtn);
        }

        body.appendChild(step);
    });

    wrap.appendChild(body);
    return wrap;
}

function createAiMessageElement(msg, index, toolResults) {

    if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
        return createAiAgentStepElement(msg, toolResults);
    }

    const wrap = document.createElement('div');
    const stateClass = msg.error ? (msg.canceled ? ' ai-msg-canceled' : ' ai-msg-failed') : '';
    wrap.className = `ai-msg ai-msg-${msg.role}${stateClass}`;
    wrap.dataset.index = String(index);

    const role = document.createElement('div');
    role.className = 'ai-msg-role';
    role.innerHTML = msg.role === 'user'
        ? '<span class="ms-icon xs">person</span><span>你</span>'
        : '<span class="ms-icon xs">chat_bubble</span><span>AI 助手</span>';
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
        content.innerHTML = renderAiMarkdown(msg);
        if (!msg.content) content.innerHTML = '<span class="ai-typing">正在生成…</span>';
    } else {
        content.textContent = msg.content;
    }

    body.appendChild(content);

if (msg.role === 'user' && Array.isArray(msg.attachments) && msg.attachments.length) {
        body.appendChild(createAiAttachmentList(msg.attachments));
    }

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

const toolResults = new Map();
    messages.forEach((msg) => {
        if (msg.role === 'tool' && msg.toolCallId) toolResults.set(msg.toolCallId, msg);
    });

    container.querySelectorAll('.ai-msg').forEach(el => el.remove());
    messages.forEach((msg, index) => {
        if (msg.role === 'tool') return;
        container.appendChild(createAiMessageElement(msg, index, toolResults));
    });
    scrollAiToBottom();
}

function scheduleAiStreamRender() {
    if (aiStreamTimer) return;
    aiStreamTimer = setTimeout(() => {
        aiStreamTimer = null;
        const container = document.getElementById('ai-messages');

        const chat = findAiConversation(State.aiStreamingChatId);
        if (!chat || chat.id !== State.aiActiveConversationId) return;

        const msg = chat.messages[chat.messages.length - 1];
        if (!container || !msg || msg.role !== 'assistant') return;

        const items = container.querySelectorAll('.ai-msg-content');
        const el = items[items.length - 1];
        if (!el) return;

const selection = window.getSelection();
        if (selection && !selection.isCollapsed && container.contains(selection.anchorNode)) return;

        el.textContent = msg.content;
        container.scrollTop = container.scrollHeight;
    }, AI_STREAM_RENDER_INTERVAL_MS);
}

function updateAiPanelHeader() {
    const modelLabel = document.getElementById('ai-panel-model');
    if (modelLabel) {
        const model = State.ai && State.ai.model ? State.ai.model : '';
        modelLabel.textContent = model || '未配置模型';
        modelLabel.title = model || '前往「设置 → AI 助手」完成配置';
    }
}

let aiScopeParkedForMissingNote = false;

function updateAiScopeOptions() {
    const select = document.getElementById('ai-scope-select');
    if (!select) return;

    const item = getActiveItem();
    const currentOption = select.querySelector('option[value="current"]');

    if (item) {
        const label = `附带当前笔记：${itemDisplayTitle(item)}`;
        if (!currentOption) {
            const option = document.createElement('option');
            option.value = 'current';
            option.textContent = label;
            select.insertBefore(option, select.firstElementChild);
        } else if (currentOption.textContent !== label) {

            currentOption.textContent = label;
        }
        if (aiScopeParkedForMissingNote) {
            aiScopeParkedForMissingNote = false;
            State.aiScope = 'current';
        }
    } else if (currentOption) {
        currentOption.remove();
        if (State.aiScope === 'current') {
            aiScopeParkedForMissingNote = true;
            State.aiScope = 'none';
        }
    }

if (select.value !== State.aiScope) select.value = State.aiScope;
}

function updateAiComposerState() {
    const input = document.getElementById('ai-input');
    const sendBtn = document.getElementById('btn-ai-send');
    const stopBtn = document.getElementById('btn-ai-stop');
    const attachBtn = document.getElementById('btn-ai-attach');
    const hasContent = !!input && (input.value.trim().length > 0 || State.aiPendingAttachments.length > 0);

if (sendBtn) {
        sendBtn.classList.toggle('hidden', State.aiStreaming);
        sendBtn.disabled = !hasContent;
    }
    if (stopBtn) stopBtn.classList.toggle('hidden', !State.aiStreaming);

    if (attachBtn) attachBtn.disabled = !isAiEnabled();
}

const AI_PANEL_WIDTH_TRANSITION_MS = 260;

const AI_PANEL_COLLAPSED_CLASS = 'ai-collapsed';

let aiPanelExpanded = false;
let aiPanelHideTimer = null;

function clearAiPanelHideTimer() {
    if (aiPanelHideTimer) {
        clearTimeout(aiPanelHideTimer);
        aiPanelHideTimer = null;
    }
}

function expandAiPanel(panel) {
    clearAiPanelHideTimer();

panel.classList.add(AI_PANEL_COLLAPSED_CLASS);
    panel.classList.remove('hidden');

void panel.offsetWidth;
    panel.classList.remove(AI_PANEL_COLLAPSED_CLASS);
}

function collapseAiPanel(panel) {
    closeAiDrawer();
    panel.classList.add(AI_PANEL_COLLAPSED_CLASS);
    clearAiPanelHideTimer();
    aiPanelHideTimer = setTimeout(() => {
        aiPanelHideTimer = null;
        panel.classList.add('hidden');
    }, AI_PANEL_WIDTH_TRANSITION_MS + 60);
}

function hideAiPanelImmediately(panel) {
    clearAiPanelHideTimer();
    closeAiDrawer();
    panel.classList.add(AI_PANEL_COLLAPSED_CLASS, 'hidden');
}

function applyAiPanelVisibility() {
    const panel = document.getElementById('ai-panel');
    const btn = document.getElementById('btn-ai-assistant');
    if (!panel) return;

    const inSettings = State.activeNoteId === 'settings';
    const visible = isAiEnabled() && !!State.aiPanelOpen && !inSettings;
    if (btn) btn.classList.toggle('active', visible);

    if (visible === aiPanelExpanded) {

        if (!visible) closeAiDrawer();
        return;
    }
    aiPanelExpanded = visible;

    if (visible) expandAiPanel(panel);
    else if (inSettings) hideAiPanelImmediately(panel);
    else collapseAiPanel(panel);
}

function setAiPanelOpen(open) {
    State.aiPanelOpen = !!open && isAiEnabled();
    applyAiPanelVisibility();
    if (!State.aiPanelOpen) {

        closeAiDrawer();
        return;
    }

    if (State.fmPanelOpen) {
        State.fmPanelOpen = false;
        applyFileManagerVisibility();
    }

    updateAiPanelHeader();
    updateAiScopeOptions();
    updateAiComposerState();
    renderAiMessages();
    renderAiChatList();
    const input = document.getElementById('ai-input');
    if (input) input.focus();
}

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

    if (State.activeNoteId === 'settings') {
        State.activeNoteId = State.openNoteIds.filter(id => id !== 'settings').pop() || null;
        renderApp();
    }
    setAiPanelOpen(true);
}

async function clearAiConversation() {
    if (State.aiStreaming) {
        showToast('请先停止当前的生成');
        return;
    }
    const chat = activeAiConversation();
    if (!chat.messages.length) return;

    const confirmed = await showConfirm('清空当前对话？', {
        title: '清空对话',
        detail: `${chat.messages.length} 条消息将从本机对话文件中移除，此操作无法撤销。`,
        icon: 'delete_sweep',
        confirmLabel: '清空'
    });
    if (!confirmed) return;

releaseAiAttachments(chat.messages);
    chat.messages = [];
    chat.title = '';
    touchAiConversation(chat);
    saveAiChat(chat);
    renderAiMessages();
    renderAiChatList();
    showToast('已清空对话');
}

function stopAiGeneration() {
    if (!State.aiStreaming) return;

    aiTurnCancelRequested = true;
    if (!State.aiRequestId) return;

    const requestId = State.aiRequestId;
    ipcRenderer.invoke('ai:abort', { requestId }).catch((err) => {
        console.error('停止生成失败:', err);
    });
}

async function sendAiQuestion() {
    if (State.aiStreaming) {

        showToast('正在生成回答，请先停止或等待完成');
        return;
    }

    if (!isAiEnabled()) return;

    const input = document.getElementById('ai-input');
    const question = input ? input.value.trim() : '';
    const pending = State.aiPendingAttachments.slice();

    if (!question && !pending.length) return;

    if (!isAiConfigured()) {
        showToast('请先配置 API 站点与模型');
        openAiSettingsPanel();
        return;
    }

flushPendingSave();

    flushAiConfigSave();

const chat = activeAiConversation();
    if (chat.messages.length > AI_CHAT_MESSAGE_LIMIT) {
        chat.messages = chat.messages.slice(-AI_CHAT_MESSAGE_LIMIT);
    }

const userMessage = {
        role: 'user',
        content: question,
        attachments: pending.length ? pending : undefined,
        createdAt: Date.now()
    };
    chat.messages.push(userMessage);
    touchAiConversation(chat);

    const { messages, context } = buildAiRequestMessages(chat);
    userMessage.contextLabel = State.aiScope === 'none'
        ? '不附带笔记'
        : (context ? `附带 ${context.count} 篇笔记` : '没有可附带的笔记');

    if (input) input.value = '';
    clearAiPendingAttachments();
    renderAiMessages();
    renderAiChatList();
    updateAiComposerState();

    saveAiChat(chat);

    await runAiTurn(chat, messages);
}

async function requestAiAnswer(chat, messages) {
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    State.aiRequestId = requestId;

    State.aiStreamingChatId = chat.id;

    const answer = { role: 'assistant', content: '', pending: true, createdAt: Date.now() };
    chat.messages.push(answer);
    const answerIndex = chat.messages.length - 1;

    renderAiMessages();
    updateAiComposerState();

    let result = null;
    try {
        result = await ipcRenderer.invoke('ai:chat', {
            requestId,
            messages,
            tools: buildAiAgentToolPayload()
        });
    } catch (err) {
        console.error('AI 请求失败:', err);
        result = { ok: false, error: '请求失败：无法与主进程通信' };
    }

if (State.aiRequestId !== requestId) return null;
    State.aiRequestId = null;

    const toolCalls = (result && result.ok && Array.isArray(result.toolCalls)) ? result.toolCalls : [];

const target = findAiConversation(chat.id);
    const live = target ? target.messages[answerIndex] : null;
    if (live && live.role === 'assistant') {
        live.pending = false;
        if (result && result.ok) {
            live.content = result.content || '';
            if (toolCalls.length) live.toolCalls = toolCalls;
        } else {
            live.content = '';
            live.error = (result && result.error) || '请求失败';

            live.canceled = !!(result && result.canceled);
        }
        touchAiConversation(target);
    }

    saveAiChat(target);

    renderAiMessages();
    renderAiChatList();
    updateAiComposerState();
    updateAiScopeOptions();

    if (!result || !result.ok || !target) return null;
    return { toolCalls };
}

async function runAiTurn(chat, initialMessages) {
    let messages = initialMessages;
    let steps = 0;

State.aiStreaming = true;
    State.aiStreamingChatId = chat.id;
    aiTurnCancelRequested = false;
    updateAiComposerState();

    try {
        while (true) {
            const round = await requestAiAnswer(chat, messages);
            if (!round) return;
            if (!round.toolCalls.length) return;

for (const call of round.toolCalls) {
                if (aiTurnCancelRequested) break;

                const outcome = await executeAiAgentTool(call.name, call.arguments);
                const stepId = outcome.undo ? `step${generateNoteId()}` : '';
                if (outcome.undo) registerAiAgentUndo(stepId, outcome.undo);

                const target = findAiConversation(chat.id);
                if (!target) return;

                target.messages.push({
                    role: 'tool',
                    toolCallId: call.id,
                    name: call.name,
                    content: outcome.content,
                    summary: outcome.summary,
                    detail: outcome.detail,
                    ok: outcome.ok !== false,
                    stepId,
                    createdAt: Date.now()
                });
            }

            touchAiConversation(chat);
            saveAiChat(chat);
            renderAiMessages();
            renderAiChatList();

            if (aiTurnCancelRequested) {
                chat.messages.push({
                    role: 'assistant',
                    content: '',
                    error: '已停止生成',
                    canceled: true,
                    createdAt: Date.now()
                });
                saveAiChat(chat);
                renderAiMessages();
                renderAiChatList();
                return;
            }

            steps++;
            if (steps >= AI_AGENT_MAX_STEPS) {
                chat.messages.push({
                    role: 'assistant',
                    content: `（本次提问已达到 ${AI_AGENT_MAX_STEPS} 步工具调用上限，先停在这里。需要继续的话再发一条消息。）`,
                    createdAt: Date.now()
                });
                saveAiChat(chat);
                renderAiMessages();
                renderAiChatList();
                return;
            }

messages = buildAiRequestMessages(chat).messages;
        }
    } finally {
        State.aiStreaming = false;
        State.aiRequestId = null;
        State.aiStreamingChatId = null;
        aiTurnCancelRequested = false;
        updateAiComposerState();
        renderAiChatList();
    }
}

function insertAiAnswerToItem(content) {
    const item = getActiveItem();
    if (!item) {
        showToast('请先打开一篇笔记或一项待办');
        return;
    }
    if (isReadOnlyItem(item)) {
        showToast(isSecretLocked(item) ? '正文已加密：解锁后才能写入' : '废纸篓中的内容为只读，无法写入');
        return;
    }

    flushPendingSave();
    const base = String(item.content || '').replace(/\s+$/, '');
    item.content = base ? `${base}\n\n${content}` : content;

const textarea = document.getElementById('textarea-note-content');
    if (textarea) textarea.value = item.content;
    autoSaveActiveItem();
    flushRenderMarkdown();
    showToast('已插入到当前内容');
}

function saveAiAnswerAsNote(content) {
    const defaults = newNoteDefaults();
    const now = Date.now();

    const note = {
        id: generateUniqueItemId('note'),
        title: `AI 回答 · ${formatDate(now)}`,
        content,
        folder: defaults.folder,
        tags: defaults.tags,
        isPinned: false,
        isTrashed: false,

        isHidden: false,
        locked: false,
        createdAt: now,
        updatedAt: now
    };

    saveNote(note);
    markItemKind(note, 'note');
    State.notes.unshift(note);
    openTab(note.id);
    renderApp();
    showToast('已存为新笔记');
}

function initAiPanel() {
    const input = document.getElementById('ai-input');
    if (!input) return;

    input.oninput = updateAiComposerState;

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

            aiScopeParkedForMissingNote = false;
            updateAiScopeOptions();
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

document.querySelectorAll('#ai-empty .ai-example-chip').forEach((chip) => {
        chip.onclick = () => {
            input.value = chip.dataset.prompt || '';
            updateAiComposerState();
            input.focus();
        };
    });

    ipcRenderer.on('ai:stream', (event, payload) => {
        if (!payload || payload.requestId !== State.aiRequestId) return;

const chat = findAiConversation(State.aiStreamingChatId);
        if (!chat) return;
        const msg = chat.messages[chat.messages.length - 1];
        if (!msg || msg.role !== 'assistant') return;

        msg.content += payload.delta || '';
        if (chat.id === State.aiActiveConversationId) scheduleAiStreamRender();
    });

    updateAiPanelHeader();
    updateAiScopeOptions();
    updateAiComposerState();
}
