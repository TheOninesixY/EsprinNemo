/* 使用模式：标准模式（全部功能）与极简模式（只保留笔记与待办）。
   极简模式本身是「少显示一些东西」，因此隐藏入口的活都交给 styles/mode.css——它按 <html> 上的
   .minimal-mode 类名把标题栏与标签栏整体移除（窗口操作键留在右上角、应用名移到侧边栏），
   并把 AI 助手、小本本、文件夹与标签一并藏起来（首屏由 boot.js 先行落定）；
   这里只负责那些光靠 CSS 藏不掉的状态收尾：

   - 停掉正在生成的 AI 回答并收起对话面板（极简模式下 AI 入口整体不存在）
   - 丢开文件夹 / 标签筛选（这两个入口在极简模式下没有，停在其中的话列表会带着看不见的筛选条件）
   - 重建设置分类侧边栏（极简模式少一个「AI 助手」分类）
   - 通知主进程收尾：托盘菜单不再列「小本本」，已开着的小本本窗口一并关掉

   配置字段为 config.json 中的 uiMode（standard / minimal），与其余偏好一样由 saveConfig 落盘。 */

// 让主进程做模式切换后的收尾：托盘菜单里的「小本本」随模式增减，
// 极简模式下已开着的小本本窗口也会被关掉（见 src/main/main.js 的 mode:apply）。
// 主进程没注册该通道时静默跳过，不影响模式切换本身。
function applyModeInMainProcess() {
    try {
        const pending = ipcRenderer.invoke('mode:apply');
        // invoke 在通道不存在时会 reject，这里必须接住，否则会冒成未处理的 Promise 异常
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (err) {
        // ipcRenderer 不可用时（例如脚本被单独引入做测试）直接忽略
    }
}

// 把当前模式落到界面上：类名切换 + 需要界面配合的收尾，可在启动时与切换后重复调用
function applyUiMode() {
    const minimal = isMinimalMode();
    document.documentElement.classList.toggle(MINIMAL_MODE_CLASS, minimal);

    if (minimal) {
        // 正在生成的回答在极简模式下没有落脚处：先停掉，再收起面板
        if (State.aiStreaming && typeof stopAiGeneration === 'function') stopAiGeneration();
        if (State.aiPanelOpen && typeof setAiPanelOpen === 'function') setAiPanelOpen(false);
        // 文件夹 / 标签视图在极简模式下已无入口：回到「笔记」总览，避免停在看不见的筛选里
        if (State.currentFilter.startsWith('folder:') || State.currentFilter.startsWith('tag:')) {
            State.currentFilter = 'all';
        }
    }

    // 分类侧边栏随模式变化：重建一次。当前停留的分类若已被隐藏，
    // switchSettingsCategory 会自动退到第一个可见分类（见 scripts/settings.js）
    if (typeof initSettingsNav === 'function') initSettingsNav();
}

// 切换模式：落盘后刷新界面、设置项与托盘菜单
function toggleUiMode(value) {
    const next = normalizeUiMode(value);
    if (next === State.uiMode) return;

    State.uiMode = next;
    applyUiMode();
    saveConfig();
    // 托盘菜单里的「小本本」只在标准模式出现：配置已写入，这里让主进程按新配置收尾
    applyModeInMainProcess();
    renderApp();
    syncUiModeUI();

    showToast(isMinimalMode() ? '已开启极简模式：只保留笔记与待办' : '已切换回标准模式');
}

// 设置项回显：模式下拉与当前模式说明
function syncUiModeUI() {
    const select = document.getElementById('setting-ui-mode');
    if (select) select.value = normalizeUiMode(State.uiMode);

    const hint = document.getElementById('mode-current-hint');
    if (!hint) return;
    hint.textContent = isMinimalMode()
        ? '当前：极简模式。标题栏与标签栏已移除，窗口操作键悬浮在右上角、应用名在侧边栏「新建」上方；侧边栏只剩「笔记 / 待办 / 已置顶 / 废纸篓」，AI 助手、小本本与侧边栏的文件夹、标签两栏都已隐藏（编辑器里仍可改文件夹与标签）。'
        : '当前：标准模式。所有功能都在。';
}

function initUiMode() {
    const select = document.getElementById('setting-ui-mode');
    if (select) select.onchange = (event) => toggleUiMode(event.target.value);

    // 模式状态在首屏已由 boot.js 落定，这里补上依赖脚本就绪的那部分收尾
    applyUiMode();
    syncUiModeUI();
}
