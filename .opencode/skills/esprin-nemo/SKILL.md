---
name: esprin-nemo
description: "EsprinNemo 中，Agent 的记忆文件：这是一个供 Agent 修改与查看的Agent 记忆文件。"
---

## 图标体系（Lucide）

- 图标一律用 `lucide` 包（`node_modules/lucide/dist/umd/lucide.min.js`），不再使用图标字体。
- DOM 写法：`<span class="icon sm" data-lucide="name" aria-hidden="true"></span>`，宿主的 `font-size` 决定尺寸（`.icon` / `.xs` / `.sm`，移动端 `.icon-s16` 等），颜色靠 `currentColor`。
- 尺寸与描边：图标尺寸随 `font-size`（`.icon` / `.xs` / `.sm` / 移动端 `.icon-sNN`）走；`stroke-width` 统一 `2`，通过 `lucide.createElement(node, { 'stroke-width': 2 })` 传参，不在 CSS 里覆盖，也不给任何状态单独加粗。
- 注入 SVG 的脚本：`src/desktop/renderer/scripts/icons.js`（桌面端，全局 `setLucideIcon`）与 `src/mobile/scripts/icons.js`（移动端，导出 `setIcon`）。两者都用 `MutationObserver` 给动态插入的占位补水，动态换图标不要写 `textContent`。
- 桌面四个窗口（main / dialog / sticky / scratchpad）都要先加载 lucide UMD 再加载 `scripts/icons.js`；dialog 与 sticky 放在 `<head>`，依赖 `DOMContentLoaded` 补水。
- 移动端单文件与同步服务端：`build/mobile/build.js` 把 UMD 内联进 HTML，`build/sync/build.js` 把它内嵌进可执行文件；服务端放行路径是 `/node_modules/lucide/`。
- `.github/pages` 是静态站点，用内联 SVG，不加载 UMD。
- 笔记卡片标题右侧的置顶 `pin` 用 `--text-secondary` + 常规描边，不加 `.fill`（`.fill` 会把描边从 2.5 提到 3.1，在 14px 下糊成一坨）。
- 侧边栏导航（笔记 / 待办 / 废纸篓）选中态只换颜色：不加重字重，也不再叠一层加粗描边的图标副本。Lucide 没有实心变体，叠副本只会让图标发糊。

## 新建条目是草稿标签页

- 「新建笔记 / 新建待办」不再直接落盘：`createNewNote` / `createNewTodo` 只调用 `createDraft(kind)`，在 `State.drafts` 里建一条内存草稿，标签 id 是 `draft:note` / `draft:todo`，标题固定显示「新建笔记」「新建待办」。
- 草稿只有写入标题或正文、并经过一次 300ms 自动保存后，才由 `commitDraft()` 生成真实 id 并落盘；空草稿关闭标签或切走会被 `discardDraft()` 丢弃，不产生空文件。
- 所有「按 id 取条目」的地方都要过 `isDraftId()`：`getItemById` / `getActiveItem` / `isTodoItem` / `saveItem`（草稿不落盘）/ `renderTabs` 的 `openNoteIds` 过滤。新增功能若读 `State.openNoteIds`，记得也放行草稿 id。
- 标签栏左侧的「返回笔记列表」按钮（`.tabs-back` / `#btn-tabs-back`）连同 40px 的 `--tabs-back-slot` 一起删掉了，不要再加回来。

## macOS 磨砂外框

- macOS 主窗口用 `vibrancy: 'under-window'` + 透明 `backgroundColor`，ChromeBar 再用 `--chrome-vibrancy-tint` 叠一层主题色（`src/desktop/renderer/styles/mode.css`、`tokens.css`）。
- 磨砂材质只跟随原生外观，不跟随 CSS 主题。主进程必须调用 `applyNativeThemeSource()`（`src/desktop/main/main.js`），在 `createWindow()` 之前设一次、并在 `settings:config-changed` 时同步 `nativeTheme.themeSource`；否则系统浅色 + 应用深色会混出灰色外框。
- 「降低透明度」的纯色回落已由 `@media (prefers-reduced-transparency: reduce)` 处理，不需要额外 JS。
- `MEMORY.md` 虽然软链接到 `.opencode/skills/esprin-nemo/SKILL.md`，但它属于记忆文件，不受「不得修改 `.opencode/` 文件」这条限制。

## 编辑器工具栏与 Markdown 渲染

- `formatMarkdown` 对标题 / 列表 / 引用等行级语法按整行处理：多行选区逐行加前缀，先剥掉同族旧标记；插入后把选区或光标放回新内容，不再跳到文末。
- 列表由 `markdown.js` 的 `renderListBlocks` 按缩进解析，支持嵌套与空行分隔；链接和图片的 URL 允许一层成对括号。
- 工具栏最终形态：标题下拉（只有 H1–H6，排最前）+ 行内 5 个图标 + 列表与引用 4 个图标 + 插入下拉（代码块 / 表格 / 分割线 / 图片或文件）+ 文件管理器，共 12 个控件；下拉复用 `dropdown.js` 的 `<select>` 升级机制，选完把 `value` 重置为空，占位项用 `data-placeholder` 标记、不进菜单。
- macOS 下所有下拉（含 `<select>`）与右键菜单都必须走 `nativeMenuBridge.popup` 的系统 NSMenu；Windows / Linux 才用自绘菜单。`nativeSelectEntries` 负责把 `<select>` 选项转成菜单项。
- 外观设置新增 `backgroundBlur`（默认开）：关闭时移除 `mac-vibrancy` 类，主进程用 `applyWindowSurface` 把窗口 `vibrancy` 置空并设成主题底色。
- 系统设置新增 `backgroundRunning`（默认开，仅 macOS）：关闭后 `window-all-closed` 与三个 `handle*Closed` 不再在 macOS 提前 return，关闭主窗口即退出。
- 预览模式下工具栏只置灰会改正文的按钮与下拉，文件管理器仍可用。
- 新日志格式为 `[类别:级别] 动作：消息`，类别只用 `Desktop` / `Mobile` / `Sync`；构建脚本的自定义 `log()` 也要按此输出。
