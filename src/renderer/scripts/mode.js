/* 界面布局：现代布局（没有标题栏的紧凑布局，默认）与经典布局（标题栏与标签页照旧）。
   现代布局的活几乎都在 styles/mode.css：它按 <html> 上的 .modern-layout 类名把标题栏整条移除
   （首屏由 boot.js 先行落定），只留下悬浮在右上角的工具按钮组与窗口操作键，
   应用名挤进侧边栏顶部，标签页则挪到工作区顶部那一行
   （见 main.html 的 #workspace-tabs 与 scripts/render.js 的 renderTabs；
   设置里另有「禁用标签页」开关，打开后这一行整个收起），拖窗口改由几处留白承担。
   功能上一个不少：AI 助手（面板与设置里的分类）、小本本、侧边栏的文件夹与标签过滤、
   托盘菜单都与经典布局一致。

   标题栏没了，两处「离开」就各需要一个落脚点：标签栏最左端的「返回」负责退出当前编辑，
   设置页分类侧边栏顶部的「返回」负责离开设置页（两者都只在现代布局显示，见 styles/mode.css）。
   设置页是整屏铺开的（侧边栏与笔记列表都让位），工作区连同它的标签页在那里不占位，
   所以设置页仍靠这个「返回」离开。

   这里只负责那两件 CSS 落不下来的事：类名切换与设置项回显。
   配置字段为 config.json 中的 uiMode（classic / modern）与 tabsDisabled（现代布局下是否连标签页也收起），
   与其余偏好一样由 saveConfig 落盘。 */

// 把当前布局落到界面上：只切类名，其余长相全由 styles/mode.css 决定。
// 可在启动时与切换后重复调用
function applyUiMode() {
    const root = document.documentElement;
    root.classList.toggle(MODERN_LAYOUT_CLASS, isModernLayout());
    // 「禁用标签页」只属于现代布局：经典布局的标签页归标题栏所有，这一档不插手
    root.classList.toggle(TABS_DISABLED_CLASS, isTabsDisabled());
    syncNewButtonTitles();
}

// 侧边栏「新建」在两种布局下承担的事不一样，title 跟着换：
// 现代布局里它是两枚按钮——本体新建笔记、悬停滑出的副本新建待办（见 styles/mode.css），
// 经典布局里它仍是那一个「新建笔记或待办」的菜单入口（见 scripts/events.js）。
// （按钮上的图标是「加号 → 新建文档」的交叉淡入，纯样式的事，见 styles/mode.css）
function syncNewButtonTitles() {
    const noteBtn = document.getElementById('btn-new-note');
    const todoBtn = document.getElementById('btn-new-todo');
    if (noteBtn) {
        noteBtn.title = isModernLayout()
            ? '新建笔记 (Ctrl+N)'
            : '新建笔记或待办 (Ctrl+N / Ctrl+Shift+N)';
    }
    if (todoBtn) todoBtn.title = '新建待办 (Ctrl+Shift+N)';
}

// 切换布局：落盘后刷新界面与设置项。
// 顶栏怎么排是渲染进程自己的事，主进程不必跟着收尾
// （AI 助手、小本本、托盘菜单在两种布局下完全一样）
function toggleUiMode(value) {
    const next = normalizeUiMode(value);
    if (next === State.uiMode) return;

    State.uiMode = next;
    applyUiMode();
    saveConfig();
    renderApp();
    syncUiModeUI();

    showToast(isModernLayout() ? '已切换到现代布局：标题栏已收起，标签页移到工作区顶部' : '已切换到经典布局');
}

// 切换「禁用标签页」（设置项只在现代布局下排出来）：
// 标签页本来就在编辑器顶栏之上，收起它不必整屏重绘，只切类名就能让下面的一整列上移
function toggleTabsDisabled(disabled) {
    const next = !!disabled;
    if (next === State.tabsDisabled) return;

    State.tabsDisabled = next;
    applyUiMode();
    saveConfig();

    showToast(next ? '标签页已禁用：整条收起，列表里照旧能切条目' : '标签页已恢复');
}

// 设置项回显：布局下拉，以及它下面只属于现代布局的「禁用标签页」
function syncUiModeUI() {
    const select = document.getElementById('setting-ui-mode');
    if (select) select.value = normalizeUiMode(State.uiMode);

    const tabsToggle = document.getElementById('setting-tabs-disabled');
    if (tabsToggle) tabsToggle.checked = State.tabsDisabled;
}

function initUiMode() {
    const select = document.getElementById('setting-ui-mode');
    if (select) select.onchange = (event) => toggleUiMode(event.target.value);

    const tabsToggle = document.getElementById('setting-tabs-disabled');
    if (tabsToggle) tabsToggle.onchange = (event) => toggleTabsDisabled(event.target.checked);

    // 布局状态在首屏已由 boot.js 落定，这里补上依脚本而就的类名同步与设置项回显
    applyUiMode();
    syncUiModeUI();
}
