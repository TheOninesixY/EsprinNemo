/* AI 助手对话面板：把笔记作为上下文提问，回答以流式方式逐步显示。
   面板内可同时保留多份对话记录（见 ai_chats.js），一份对话一个文件落在数据目录的 ai_chats/ 下。
   打开 Agent 模式后（见 ai_agent.js），模型可以调用工具直接读写笔记。 */

// 上下文字符预算：单篇与总量都设上限，避免一次提问塞进过多内容把请求撑爆
const AI_SINGLE_NOTE_CHAR_LIMIT = 6000;
const AI_TOTAL_CONTEXT_CHAR_LIMIT = 40000;
// 随请求携带的历史轮数上限（一轮 = 一次用户提问及其之后的工具步骤与回答）
const AI_HISTORY_TURN_LIMIT = 8;
// 流式输出期间的刷新间隔：太频繁会拖慢长回答的渲染
const AI_STREAM_RENDER_INTERVAL_MS = 80;

const AI_DEFAULT_SYSTEM_PROMPT = '你是 EsprinNemo 笔记应用内置的 AI 助手。请用简体中文、简明扼要地回答用户关于其笔记的问题，'
    + '回答尽量使用 Markdown；当笔记中没有相关信息时请明确说明，不要编造内容。';

let aiStreamTimer = null;
// 用户点过「停止」但当前正处在工具执行阶段（没有在飞的请求）时的标记，由对话循环在下一步退出
let aiTurnCancelRequested = false;

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
        // 当前条目：正打开的笔记或待办；加密且未解锁时正文是密文，附上去没有意义
        const active = getActiveItem();
        return active && isSecretRevealed(active) ? [active] : [];
    }

    /* 全部笔记：置顶优先，再按最后修改时间由新到旧。
       隐藏的条目不进任何提问范围；设了密码的条目也不进——自动捎带一份加密正文给模型
       与「给它加密码」的意图相背，需要时由用户在提问里指定当前条目 */
    return State.notes
        .filter(note => !note.isTrashed && !isSecretHidden(note) && note.locked !== true)
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

// 用户消息折算为接口形态：正文 + 文本附件内联 + 图片附件
// includeImages 为 true 时才真正带上图片，更早的轮次只留一行占位，避免每轮都重复上传
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

// 取最近若干轮对话，并折算成接口要求的消息形态
function collectAiHistoryMessages(chat) {
    const includeSteps = isAiAgentMode();
    const all = chat.messages.filter(msg => !msg.pending);

    // 从倒数第 N 个用户提问开始切：这样 assistant 的 tool_calls 与 tool 结果不会被截断成残缺的一对
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
    // 只有最后一次提问带原图：更早的轮次若也带上，每轮请求都要重传一遍图片
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

        // 关掉 Agent 模式时不下发工具步骤，避免接口因配对信息校验报错
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

// 组装请求的消息列表：系统提示 → 笔记上下文 → 近期对话（含工具步骤与最新一次提问）
// 历史里已经包含当前提问（发送前先入队），因此这里不再单独拼提问，附件也就不会漏掉
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
        // 范围是当前笔记但当前没有打开笔记：明确告诉模型缺少上下文，避免它凭空作答
        messages.push({ role: 'system', content: '本次提问没有附带任何笔记内容，请按通用知识回答，并提醒用户当前没有可参考的笔记。' });
    }

    collectAiHistoryMessages(chat).forEach(msg => messages.push(msg));
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

/* 回答正文已解析好的 HTML 缓存：一次提问里有工具调用时，
   每执行完一步都会整份重建消息列表（renderAiMessages），几十条回答因此会被反复送进 marked.parse，
   长回答下这一步相当贵。缓存挂在消息对象上（WeakMap），消息随对话删除后随之回收；
   流式生成期间正文逐字变化，缓存自然失效，只有当正文真正没变时才复用。 */
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

// Agent 操作卡片：把一轮工具调用与它们的执行结果列出来，写操作附「撤销」
function createAiAgentStepElement(msg, toolResults) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg ai-msg-agent';

    const role = document.createElement('div');
    role.className = 'ai-msg-role';
    role.innerHTML = '<span class="ms-icon xs">smart_toy</span><span>AI 操作</span>';
    wrap.appendChild(role);

    const body = document.createElement('div');
    body.className = 'ai-msg-body ai-agent-steps';

    // 模型在调用工具前可能先说一句（例如“我先看一下这篇笔记”），一并展示
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
    // 带工具调用的助手消息整轮渲染成操作卡片
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

    // 用户提问：正文下方展示带进来的附件
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

    // 工具结果不单独成条，而是并入对应那一步的操作卡片
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

        // 用户正在消息区里拖选时不重写正文：这里按增量覆盖一次 textContent，
        // 选区就没了，回答还在流式输出时怎么拖都选不住。
        // 返回不等丢内容——下一个增量还会调进来，流结束时还会走一次完整渲染
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && container.contains(selection.anchorNode)) return;

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

/* 输入框里那条下拉：附带范围的选项文字与可选项都跟着「当前打开的笔记」走。
   开着笔记时第一项写作「附带当前笔记：<笔记名>」；没有打开的笔记时这一项直接收起来，
   下拉里只剩「附带全部笔记 / 不附带笔记」。

   收起时范围会临时让给「不附带笔记」——取不到笔记时这两项效果完全一样（都拿不到上下文），
   但用户的偏好还得记着：等重新打开笔记，范围自动回到「附带当前笔记」（标记见下）。
   用户自己动手改过范围就作数，标记随之清掉，不再自动改回去。 */
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
            // 改的是选项文字：自绘下拉的触发器与菜单都跟着这个原生 select 走（见 scripts/dropdown.js）
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

    // 原生 select 是自绘下拉的数据源：把范围同步过去，触发器上的文字随之刷新
    if (select.value !== State.aiScope) select.value = State.aiScope;
}

function updateAiComposerState() {
    const input = document.getElementById('ai-input');
    const sendBtn = document.getElementById('btn-ai-send');
    const stopBtn = document.getElementById('btn-ai-stop');
    const attachBtn = document.getElementById('btn-ai-attach');
    const hasContent = !!input && (input.value.trim().length > 0 || State.aiPendingAttachments.length > 0);

    // 回复期间直接收起发送按钮，只留「停止」——避免出现一个按不动、看着像坏了的按钮
    if (sendBtn) {
        sendBtn.classList.toggle('hidden', State.aiStreaming);
        sendBtn.disabled = !hasContent;
    }
    if (stopBtn) stopBtn.classList.toggle('hidden', !State.aiStreaming);
    // 附件可在生成过程中先选好，不做限制
    if (attachBtn) attachBtn.disabled = !isAiEnabled();
}

// ---------- 面板开关 ----------

/* 面板的收起 / 展开走宽度过渡（360px ↔ 0，样式见 styles/ai.css 的 .ai-panel），
   与左侧边栏同一种观感：面板让出位置，工作区跟着变宽。
   动效分两拍，两个方向正好相反：
     收起：先挂 .ai-collapsed 收宽度，过渡走完再挂 .hidden 真正移出布局；
     展开：先摘 .hidden（此时宽度仍是 0）、刷一次样式，再摘 .ai-collapsed——
           若把两步放在同一次样式计算里，display: none 期间过渡不会发生，面板会瞬间铺开。 */
const AI_PANEL_WIDTH_TRANSITION_MS = 260;
// 收起状态类：宽度收到 0（样式见 styles/ai.css）
const AI_PANEL_COLLAPSED_CLASS = 'ai-collapsed';

/* 面板当前是否占位展开。界面每次刷新（renderWorkspace）都会调用 applyAiPanelVisibility，
   靠这个标记区分「已在位 / 正在收」与「需要切换」，避免每次刷新都重启动画。
   初值 false 与 main.html 里面板默认带 .hidden 的写法一致 */
let aiPanelExpanded = false;
let aiPanelHideTimer = null;

function clearAiPanelHideTimer() {
    if (aiPanelHideTimer) {
        clearTimeout(aiPanelHideTimer);
        aiPanelHideTimer = null;
    }
}

// 展开：宽度 0 → 360
function expandAiPanel(panel) {
    clearAiPanelHideTimer();
    // 先确保起点是「已收起」——首屏时这个类还没挂过（面板直接是 .hidden），
    // 少了它第一次展开就没有起点，会直接铺开
    panel.classList.add(AI_PANEL_COLLAPSED_CLASS);
    panel.classList.remove('hidden');
    // 强制刷一次样式：先让浏览器把「已渲染、宽度仍是 0」这一帧算进去，
    // 紧接着放开宽度才会补间
    void panel.offsetWidth;
    panel.classList.remove(AI_PANEL_COLLAPSED_CLASS);
}

// 收起：宽度 360 → 0，过渡结束再移出布局。
// 收尾只靠定时器：这一刻面板已经是 0 宽，早一点晚一点摘都看不出差别，
// 没必要再挂 transitionend（面板未被渲染时那次过渡根本不会触发）
function collapseAiPanel(panel) {
    closeAiDrawer();
    panel.classList.add(AI_PANEL_COLLAPSED_CLASS);
    clearAiPanelHideTimer();
    aiPanelHideTimer = setTimeout(() => {
        aiPanelHideTimer = null;
        panel.classList.add('hidden');
    }, AI_PANEL_WIDTH_TRANSITION_MS + 60);
}

// 不进动效、直接收起：设置页占据整个窗口，这一步属于「页面切换」而不是「收起面板」，
// 同一个瞬间侧边栏、中栏、工作区也都是瞬间切换的
function hideAiPanelImmediately(panel) {
    clearAiPanelHideTimer();
    closeAiDrawer();
    panel.classList.add(AI_PANEL_COLLAPSED_CLASS, 'hidden');
}

function applyAiPanelVisibility() {
    const panel = document.getElementById('ai-panel');
    const btn = document.getElementById('btn-ai-assistant');
    if (!panel) return;
    // 总开关关闭时面板一律不显示；设置页占据整个窗口，此时同样不显示
    const inSettings = State.activeNoteId === 'settings';
    const visible = isAiEnabled() && !!State.aiPanelOpen && !inSettings;
    if (btn) btn.classList.toggle('active', visible);

    if (visible === aiPanelExpanded) {
        // 已经到位（或正往同一方向动）：不重启动画，只补上「不显示时顺手收起抽屉」
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
        // 面板收起时对话列表也一并收起，下次打开回到消息视图
        closeAiDrawer();
        return;
    }

    updateAiPanelHeader();
    updateAiScopeOptions();
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
        detail: `${chat.messages.length} 条消息将从本机对话文件中移除，此操作无法撤销。`,
        icon: 'delete_sweep',
        confirmLabel: '清空'
    });
    if (!confirmed) return;

    // 消息一起清掉，之前带进来的图片附件也顺手从 ai_files/ 删除
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
    // 工具执行阶段没有在飞的请求：只标记取消，由对话循环在下一步退出
    aiTurnCancelRequested = true;
    if (!State.aiRequestId) return;

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
    const pending = State.aiPendingAttachments.slice();
    // 允许只发附件不发文字
    if (!question && !pending.length) return;

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

    // 先把提问（含附件）入队，再组装请求：这样附件与顺序都由历史统一决定
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
    renderAiChatList(); // 新对话的第一条提问会决定它的显示标题与排序
    updateAiComposerState();
    // 提问先落盘：即使随后请求失败或应用被关掉，也不会丢掉用户刚输入的内容
    saveAiChat(chat);

    await runAiTurn(chat, messages);
}

// 发起一次请求：流式增量写进占位的助手消息，返回本轮的工具调用（没有则为空）
async function requestAiAnswer(chat, messages) {
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    State.aiRequestId = requestId;
    // 整个回合期间都指向发起它的对话（工具执行阶段也不例外）
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

    // 仅当这次请求仍是当前请求时才收尾，避免"停止后又收到上一轮结果"的错乱
    if (State.aiRequestId !== requestId) return null;
    State.aiRequestId = null;

    const toolCalls = (result && result.ok && Array.isArray(result.toolCalls)) ? result.toolCalls : [];

    // 对话可能在生成期间被删除，这里按 id 回查，找不到就当此次回答作废
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
            // 用户主动停止不算错误，用弱化的样式展示
            live.canceled = !!(result && result.canceled);
        }
        touchAiConversation(target);
    }
    // 回答完整落盘（生成过程中的增量不写盘，避免频繁 I/O）
    saveAiChat(target);

    renderAiMessages();
    renderAiChatList();
    updateAiComposerState();
    updateAiScopeOptions();

    if (!result || !result.ok || !target) return null;
    return { toolCalls };
}

// 一次提问的完整流程：模型要调工具就执行、把结果回传后继续，直到给出最终回答
async function runAiTurn(chat, initialMessages) {
    let messages = initialMessages;
    let steps = 0;

    // 整个回合（含工具执行阶段）都算"正在生成"，否则中途可以再发一条造成两条流程交叠
    State.aiStreaming = true;
    State.aiStreamingChatId = chat.id;
    aiTurnCancelRequested = false;
    updateAiComposerState();

    try {
        while (true) {
            const round = await requestAiAnswer(chat, messages);
            if (!round) return;
            if (!round.toolCalls.length) return;

            // 依次执行本轮的工具调用，并把结果按接口要求记进对话
            for (const call of round.toolCalls) {
                if (aiTurnCancelRequested) break;

                const outcome = await executeAiAgentTool(call.name, call.arguments);
                const stepId = outcome.undo ? `step${generateNoteId()}` : '';
                if (outcome.undo) registerAiAgentUndo(stepId, outcome.undo);

                const target = findAiConversation(chat.id);
                if (!target) return; // 执行期间对话被删除

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

            // 带上刚才的调用与结果继续对话，由模型决定下一步还是给出回答
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

// ---------- 回答的落地方式 ----------

// 把回答插入当前条目（笔记或待办）末尾
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

    // 与预览区勾选待办项的做法一致：同步编辑器输入框后再走自动保存
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
        // 秘密本：AI 建出来的笔记既不隐藏也不加密
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
            // 用户自己挑过范围就不再自动改回去（见 updateAiScopeOptions）
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
    updateAiScopeOptions();
    updateAiComposerState();
}
