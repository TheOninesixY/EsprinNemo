/* 使用模式：标准模式（全部功能）与无Tab模式（没有标题栏与标签栏的紧凑布局）。
   无Tab模式的活几乎都在 styles/mode.css：它按 <html> 上的 .notab-mode 类名把标题栏整条移除
   （首屏由 boot.js 先行落定），只留下悬浮在右上角的工具按钮组与窗口操作键，
   应用名挤进侧边栏顶部，拖动窗口改由几处留白承担。
   功能上一个不少：AI 助手（面板与设置里的分类）、小本本、侧边栏的文件夹与标签过滤、
   托盘菜单都与标准模式一致。

   标题栏没了，两处「离开」就各需要一个落脚点：编辑器顶栏左侧的「返回」负责退出当前编辑，
   设置页分类侧边栏顶部的「返回」负责离开设置页（两者都只在无Tab模式显示，见 styles/mode.css）。

   这里只负责那两件 CSS 落不下来的事：类名切换与设置项回显。
   配置字段为 config.json 中的 uiMode（standard / notab），与其余偏好一样由 saveConfig 落盘。 */

// 把当前模式落到界面上：只切类名，其余长相全由 styles/mode.css 决定。
// 可在启动时与切换后重复调用
function applyUiMode() {
    document.documentElement.classList.toggle(NOTAB_MODE_CLASS, isNoTabMode());
}

// 切换模式：落盘后刷新界面与设置项。
// 顶栏怎么排是渲染进程自己的事，主进程不必跟着收尾
// （AI 助手、小本本、托盘菜单在两种模式下完全一样）
function toggleUiMode(value) {
    const next = normalizeUiMode(value);
    if (next === State.uiMode) return;

    State.uiMode = next;
    applyUiMode();
    saveConfig();
    renderApp();
    syncUiModeUI();

    showToast(isNoTabMode() ? '已开启无Tab模式：标题栏与标签栏已收起' : '已切换回标准模式');
}

// 设置项回显：无Tab模式开关
function syncUiModeUI() {
    const toggle = document.getElementById('setting-notab-mode');
    if (toggle) toggle.checked = isNoTabMode();
}

function initUiMode() {
    const toggle = document.getElementById('setting-notab-mode');
    if (toggle) toggle.onchange = (event) => toggleUiMode(event.target.checked ? 'notab' : 'standard');

    // 模式状态在首屏已由 boot.js 落定，这里补上依脚本而就的类名同步与设置项回显
    applyUiMode();
    syncUiModeUI();
}
