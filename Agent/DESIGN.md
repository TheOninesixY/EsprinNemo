---
name: EsprinNemo
description: Note, Nothing. 本地优先的极简 Markdown 笔记与待办桌面应用。
colors:
  signal-blue: "#58a6ff"
  signal-blue-light: "#0969da"
  signal-blue-tint: "rgba(56, 139, 253, 0.15)"
  signal-blue-tint-light: "rgba(9, 105, 218, 0.1)"
  on-signal: "#1f2328"
  on-signal-light: "#ffffff"
  canvas: "#0d1117"
  canvas-light: "#ffffff"
  surface-titlebar: "#161b22"
  surface-titlebar-light: "#f2f4f3"
  surface-rail: "#0d1117"
  surface-rail-light: "#f2f4f3"
  surface-list: "#161b22"
  surface-list-light: "#ffffff"
  surface-elevated: "#21262d"
  surface-elevated-light: "#ffffff"
  hairline: "#30363d"
  hairline-light: "#d8dee4"
  hairline-soft: "rgba(255, 255, 255, 0.08)"
  hairline-soft-light: "rgba(0, 0, 0, 0.055)"
  ink: "#f0f6fc"
  ink-light: "#1f2328"
  ink-secondary: "#8b949e"
  ink-secondary-light: "#656d76"
  ink-muted: "#6e7681"
  ink-muted-light: "#8c959f"
  wash-hover: "rgba(255, 255, 255, 0.04)"
  wash-hover-light: "rgba(0, 0, 0, 0.03)"
  wash-active: "rgba(255, 255, 255, 0.08)"
  wash-active-light: "rgba(0, 0, 0, 0.055)"
  fill-1: "rgba(255, 255, 255, 0.045)"
  fill-1-light: "rgba(0, 0, 0, 0.025)"
  fill-2: "rgba(255, 255, 255, 0.075)"
  fill-2-light: "rgba(0, 0, 0, 0.04)"
  fill-3: "rgba(255, 255, 255, 0.11)"
  fill-3-light: "rgba(0, 0, 0, 0.06)"
  note-card-hover: "rgba(255, 255, 255, 0.04)"
  note-card-hover-light: "rgba(0, 0, 0, 0.025)"
  note-card-active: "rgba(255, 255, 255, 0.08)"
  note-card-active-light: "rgba(0, 0, 0, 0.05)"
  danger: "#f85149"
  danger-light: "#cf222e"
  danger-tint: "rgba(248, 81, 73, 0.15)"
  danger-tint-light: "rgba(207, 34, 46, 0.1)"
  warning: "#d29922"
  warning-light: "#bf8700"
typography:
  brand:
    fontFamily: "Mohave, 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "0.4px"
  display:
    fontFamily: "'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  doc:
    fontFamily: "'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
  caption:
    fontFamily: "'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "'JetBrains Mono', Consolas, 'Fira Code', monospace"
    fontSize: "11px"
    fontWeight: 400
  icon:
    description: "Lucide SVG 线性图标，随 font-size 缩放，stroke-width 统一 2"
    fontSize: "16px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  card: "12.8px"
  pill: "999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  xxl: "16px"
  section: "24px"
  page: "32px"
components:
  button-icon:
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    size: "26px"
  button-icon-active:
    backgroundColor: "{colors.wash-active}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    size: "26px"
  button-new:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.on-signal}"
    rounded: "{rounded.sm}"
    size: "28px"
  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "0 12px"
  button-outline-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.on-signal}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "0 12px"
  card-note:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  card-note-hover:
    backgroundColor: "{colors.note-card-hover}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  card-note-active:
    backgroundColor: "{colors.note-card-active}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  chip-filter:
    backgroundColor: "{colors.wash-hover}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.pill}"
    height: "24px"
    padding: "0 9px"
  chip-filter-active:
    backgroundColor: "{colors.signal-blue-tint}"
    textColor: "{colors.signal-blue}"
    rounded: "{rounded.pill}"
    height: "24px"
    padding: "0 9px"
  chip-tag:
    backgroundColor: "{colors.signal-blue-tint}"
    textColor: "{colors.signal-blue}"
    rounded: "{rounded.xs}"
    padding: "1px 4px"
  field-search:
    backgroundColor: "{colors.wash-hover}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "28px"
    padding: "0 8px"
  row-settings:
    backgroundColor: "{colors.surface-list}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
  nav-item:
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
  nav-item-active:
    backgroundColor: "{colors.wash-active}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 6px 0 10px"
  tab-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 6px 0 10px"
---

# Design System: EsprinNemo

## Overview

**Creative North Star: "纸盘 The Paper Tray"**

整个窗口是一张摊开的桌面。左侧 48px 图标栏与顶部 40px 标签栏是同一种材质的一整块表面（代码里叫 ChromeBar），内容卡片像一张纸压在上面，四周露出 6px 的底，四角 12.8px 圆角，1px 描边。macOS 上这块表面换用系统 vibrancy 毛玻璃（`under-window`），磨砂透出桌面，再压一层主题色半透明罩；Windows 与 Linux 仍是纯色表面。标签是这张纸的分隔页：非活动标签不描边，活动标签只有上、左、右三边描边并向下延伸 1px 压住纸的上沿，两侧带一段反向圆角，于是标签和编辑器连成一片，看不出接缝。

界面不做表演。没有渐变、没有装饰图形、没有入场动画的炫耀；强调色在整屏的占比被压得很低，只在活动标签、选中项、主按钮和极少数确认元素上出现。信息密度优先于留白：正文 13px、卡片标题 13px、页脚 10.5px，控件高度集中在 26–30px，一个 1080p 窗口里能同时放下图标栏、笔记列表与编辑器而不显拥挤。

层次的表达几乎完全依赖三档 `--fill-*` 填充的明度差（画布 / 列表 / 标题栏 + 卡片填充），而不是描边或阴影。描边只留给真正需要边界的控件与浮层外壳。阴影被严格限制在真正悬浮于界面之上的层：弹出菜单、下拉、Toast、拖拽中的标签。

**Key Characteristics:**
- 单套固定布局：48px 图标栏 + 270px 笔记列表 + 弹性编辑器，无布局切换
- 层次靠 `--fill-*` 三档填充的明度差，卡片与行不画常驻描边；描边只留给真正需要边界的控件
- 13px 基准字号，控件 26–30px 高，密度优先
- 四档圆角 4 / 6 / 8 / 999px，内容卡片用 `md × 1.6 = 12.8px`
- 强调色默认 `#58a6ff`（浅色 `#0969da`），可自定义，但始终稀缺
- 所有下拉、菜单与确认框默认自绘，不使用 Chromium 原生 `<select>` 弹出层；macOS 是例外：右键菜单与所有下拉（含 `<select>`）改用系统原生 `Menu.popup`，确认框仍是自绘窗口
- 图标一律 Lucide 线性图标：尺寸随 `font-size` 走，`stroke-width` 统一 `2`（Lucide 参数，不额外覆盖）

## Colors

一套从 GitHub 深/浅色板推导的中性色阶，配一个高信号、可替换的冷蓝强调色；深色是 `:root` 的默认，浅色是 `.light` 覆盖。

### Primary

- **Signal Blue** (`#58a6ff` 深色 / `#0969da` 浅色)：唯一的强调色。只出现在活动标签的描边焦点、选中项文字、主按钮底色、标签片文字、设置分组标题前的 3px 竖条、`blockquote` 的左边线、开关的开启态。它在代码里由 `--accent` 承载，用户可在设置里换成其他预设色或自定义 HEX（`--accent` 会被运行时重写）。
- **Signal Tint** (`rgba(56, 139, 253, 0.15)` / 浅色 `rgba(9, 105, 218, 0.1)`)：强调色的低透明度版本，用于标签片底、选中徽标底、焦点环 `0 0 0 3px var(--accent-bg)`。
- **On Signal** (`#1f2328` 深色 / `#ffffff` 浅色)：主按钮上的文字色。深色主题里强调色偏亮，所以文字用深色；浅色主题里反过来。

### Neutral

- **Canvas** (`#0d1117` / `#ffffff`)：编辑器背景与窗口底层，最"深"的一级。
- **Surface Titlebar** (`#161b22` / `#f2f4f3`)：标题栏、ChromeBar、toast 底色。macOS 的 ChromeBar 改用 `--chrome-vibrancy-tint`（同色 45% / 58% 透明）叠在系统磨砂层上。
- **Surface Rail** (`#0d1117` / `#f2f4f3`)：左侧图标栏，深色下与画布同色，浅色下比画布深一档。
- **Surface List** (`#161b22` / `#ffffff`)：笔记列表与弹出菜单底色，比画布高一级。
- **Surface Elevated** (`#21262d` / `#ffffff`)：标签页的活动态、`pre` 代码块、需要再"浮起一点"的面。
- **Hairline** (`#30363d` / `#d8dee4`)：所有 1px 分割线、控件描边、活动标签描边。
- **Hairline Soft** (`rgba(255,255,255,0.08)` / `rgba(0,0,0,0.055)`)：悬停时出现的二级描边，以及编辑器内部分隔线。
- **Ink** (`#f0f6fc` / `#1f2328`)：正文与标题。
- **Ink Secondary** (`#8b949e` / `#656d76`)：次要文字、图标默认色、导航项。
- **Ink Muted** (`#6e7681` / `#8c959f`)：时间戳、页脚、占位符、禁用态。
- **Wash Hover** (`rgba(255,255,255,0.04)` / `rgba(0,0,0,0.03)`)：悬停底色，也是搜索框、标签片、文件夹片的底色。
- **Wash Active** (`rgba(255,255,255,0.08)` / `rgba(0,0,0,0.055)`)：按下与选中底色。

### Fills（填充分层）

描边不再承担"区分层次"的职责。需要让一个面从背景里"浮出来"时，用同一套中性色、三档透明度的填充来表达深浅，而不是画线——这是 Apple 式做法：边界靠明度差，不靠线。

- **Fill 1** (`rgba(255,255,255,0.045)` / `rgba(0,0,0,0.025)`)：卡片、设置行、密钥项、成员项、AI 回复气泡、AI 输入框、预览块的**静止态**底色。
- **Fill 2** (`rgba(255,255,255,0.075)` / `rgba(0,0,0,0.04)`)：输入框、下拉、次要按钮、标签片的静止态；也是卡片与行的**悬停态**。
- **Fill 3** (`rgba(255,255,255,0.11)` / `rgba(0,0,0,0.065)`)：输入框悬停、分段控件的滑块。

**Note Card Exception.** 笔记卡是列表里重复次数最多的面，通用 fill 叠满整个卡片仍然偏重。它单独用更轻的一档：悬停 `--note-card-hover`、选中 `--note-card-active`，浅色下只有 2.5% / 5% 黑（约 `#f8f8f8` / `#f2f2f2`），靠标题字重与时间戳维持可读性。

**The Fill-Not-Line Rule.** 一个新面板/行/输入框需要与背景区分时，先加一档 `--fill-*` 底色；只有在"可聚焦控件"上才允许常驻 1px 描边，且默认必须是 `transparent`，只在 `:focus` 时转 `--accent`。

### Semantic

- **Danger** (`#f85149` / `#cf222e`)：删除、不可逆操作、加密笔记、窗口关闭按钮的悬停底。
- **Danger Tint** (`rgba(248,81,73,0.15)` / `rgba(207,34,46,0.1)`)：删除项的悬停底、危险按钮的描边。
- **Warning** (`#d29922` / `#bf8700`)：未保存标记、需要留意的状态。

### Named Rules

**The Scarcity of Signal Blue.** 强调色在任意一屏的覆盖面积不超过 10%。它标记"当前"和"可提交"，不用于装饰、不用来做图标默认色、不给整块面板上色。稀有性是它唯一的作用。

**The Two-Tier Surface Rule.** 界面只有三级表面：画布、列表、标题栏。新增面板时先用现有表面色，不要发明第四种深浅；需要区分时加一档 `--fill-*` 填充，不要改底色，也不要画线。

## Typography

**Display Font:** Segoe UI（回退 `system-ui, "Helvetica Neue", Arial`；中文回退 `Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, Noto Sans SC`）
**Body Font:** 同上，文档区另有 `--font-doc` 供用户单独替换
**Label/Mono Font:** JetBrains Mono（回退 `Consolas, "Fira Code"`）
**Brand Font:** Mohave（随应用分发的可变字重字体，仅用于左上角品牌字）

**Character:** 一套几乎看不见的字体系统。字号被压得很紧，13px 是基准，所有层级靠 1–2px 的差距和字重区分；品牌字 Mohave 是唯一带性格的地方，15px、600、0.4px 字距、强调色，像仪器面板上的刻字。等宽字体专门负责数字——时间戳、字数、缩放比例、令牌摘要，让它们纵向对齐。

### Hierarchy

- **Brand** (600, 15px, 0.4px 字距)：仅左上角品牌字 `EsprinNemo`，颜色为强调色。
- **Display** (600, 20px, 1.3)：编辑器笔记标题、设置页大标题。窗口里最大的字。
- **Title** (600, 13px)：笔记卡片标题、设置行标签（14px/500）、分组标题（13px/600）。
- **Body** (400, 13px, 1.5)：界面正文与控件文字；文档区是 13.5px / 1.7。
- **Label** (400, 12.5px)：导航项、设置顶部当前分类、常规按钮文字；11px 用于页脚、时间戳、卡片分类信息。
- **Caption** (400, 10.5px)：笔记卡片页脚、标签片、等宽数字。

### Named Rules

**The 13px Rule.** 界面基准字号固定 13px。需要更小的信息时用 11px / 10.5px 加次要色，不要用 14px 去"强调"；需要更强层级时先加字重，再加字号。

**The Numbers Are Mono Rule.** 任何会纵向对齐或需要逐位比较的数字（时间、字数、百分比、序列号、令牌摘要）一律使用 `--font-mono` 与 `font-variant-numeric: tabular-nums`。

## Layout

固定三段式：`48px` 图标栏 / `270px` 笔记列表 / 弹性编辑器，整块由 `.app-chrome` 以 CSS Grid 排布（`grid-template-columns: 48px minmax(0,1fr) auto`，`grid-template-rows: 40px minmax(0,1fr)`）。顶部标签栏与图标栏共享同一层表面，没有各自的背景与右边框，视觉上是连续的一整块。

内容卡片占第 2 列第 2 行，`margin: 0 6px 6px 0`，1px 描边、12.8px 圆角、`background: var(--bg-editor)`，让四边都露出 6px 的 ChromeBar。AI 面板展开时占第 3 列、宽 360px，与内容卡片同一套造型与留白。

间距节奏是 2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 32。列表项间距 6px，面板内边距 8–10px，设置内容区 20px 32px 32px，设置分组之间 24px。

没有断点，也没有响应式重排：这是桌面应用，窗口有最小尺寸。窄到一定程度时整体隐藏编辑器（`html.narrow-hide-editor`），而不是把三栏改成两栏。设置是独立窗口，左侧为分类导航、右侧为内容区，内容区保持 20px 32px 内边距，不参与主窗口的布局重排。

## Elevation & Depth

**The Flat-By-Default Rule.** 静止状态没有任何阴影。深度由 1px 描边加三级表面色表达；只有当元素真的脱离文档流、浮在界面之上时才允许阴影，而且只用一档。

阴影词汇表极短：

- **浮层** (`0 8px 24px rgba(0, 0, 0, 0.25)`)：右键菜单、自绘下拉、设置里的弹出面板。
- **轻浮层** (`0 4px 12px rgba(0, 0, 0, 0.15)`)：Toast、拖拽中的标签、卡片悬停时的微抬。
- **焦点环** (`0 0 0 3px var(--accent-bg)`, 强态 `0 0 0 4px`)：键盘焦点与输入框聚焦，替代 outline。
- **内描边模拟** (`0 0 0 1px var(--border-color)`)：少数需要双层描边的地方。

侧边栏、标题栏与标签栏共用同一块 ChromeBar 表面。Windows / Linux 上它是纯色表面，整窗不叠加桌面壁纸与毛玻璃：深度只由 1px 描边与三级表面色表达，不做「窗口是屏幕壁纸上的一个洞」的效果。macOS 上 ChromeBar 改用系统 vibrancy（`under-window`）磨砂透出桌面，再叠一层 `--chrome-vibrancy-tint` 主题色半透明罩；内容卡片、AI 面板、设置窗口的内容区与所有浮层保持不透明，因此毛玻璃只停留在窗口外框，不会渗进正文。原生材质外观由应用主题驱动：主进程在启动和主题变更时同步 `nativeTheme.themeSource`，系统外观与应用主题不一致时磨砂层也跟随应用主题，不会出现「深色界面 + 浅灰磨砂」。系统开启「降低透明度」、在「设置 → 外观 → 窗口」里关闭「背景模糊」，或不在 macOS 时，回落到原来的纯色表面。

## Shapes

**The One Hairline Rule.** 所有边界都是 1px。没有 2px 分割线、没有 3px 描边（`blockquote` 的 3px 强调色左边线与分组标题的 3px 竖条是唯一的例外，它们是标记而非边界）。

圆角四档，全部由 `radius.css` 用 `--radius-factor` 缩放（`square` 0 / `slight` 0.5 / `default` 1 / `large` 1.5）：

- `--radius-xs` 4px：标签片、文件夹片、`code`、`kbd`、颜色块。
- `--radius-sm` 6px：按钮、输入框、菜单项、导航项、搜索框、`switch` 内部。
- `--radius-md` 8px：笔记卡片、设置行、弹出菜单外壳、标签页上圆角。
- `--radius-pill` 999px：筛选芯片、`switch` 外壳、滚动条滑块、徽标。
- `calc(var(--radius-md) * 1.6)` ≈ 12.8px：内容卡片，唯一一处"更大"的圆角，用来表达"这是桌面上的纸"。

标签页两侧有一段反向圆角（`::before` / `::after` 用 `radial-gradient` 画出外翻的弧），半径等于 `--radius-md`，跟随圆角设置一起变化，主题切换时与标签底色同步渐变，避免跳色。

## Components

### Buttons

- **Shape:** `--radius-sm`（6px），高度集中 26px（图标按钮）/ 28px（新建）/ 30px（设置按钮）。
- **Icon button:** 26×26，透明底，`--text-secondary` 图标；悬停 `--item-hover` + `--text-primary`；按下 `scale(0.94)`。标题栏、编辑器顶栏、工具栏都用它。
- **Editor toolbar:** 10 个 24×24 图标按钮 + 2 个下拉，按「标题 / 行内格式 / 列表 / 插入与文件」四组排列，组间用 1px 分隔线。「标题」下拉排在最前，只有 H1–H6；行内是加粗、斜体、删除线、行内代码、链接；列表是无序、有序、待办、引用；插入是「插入」下拉（代码块、表格、分割线、图片或文件）与文件管理器。预览模式下会修改正文的按钮与下拉置灰（`opacity: 0.4`、`cursor: not-allowed`），文件管理器保持可用。
- **Primary:** 底色 `--accent`、图标/文字 `--accent-fg`。新建笔记是 28×28 的方形主按钮，不是悬浮圆钮。
- **Outline:** `1px var(--border-color)` 描边 + `--bg-body` 底 + `--text-secondary` 文字；悬停描边转 `--text-muted`、文字转 `--text-primary`。
- **Danger:** 透明底 + `--danger-bg` 描边 + `--danger` 文字。
- **Hover / Focus:** 过渡 0.15s；键盘焦点用 `box-shadow: 0 0 0 3px var(--accent-bg)`，不用 outline。

### Chips

- **Filter chip:** `--radius-pill`、24px 高、`--item-hover` 底、12px 文字；选中态改为 `--accent-bg` 底 + `--accent` 描边 + `--accent` 文字。
- **Tag chip:** `--radius-xs`、`1px 4px` 内边距、`--accent-bg` 底 + `--accent` 文字 + 11px，是笔记卡片上唯一有颜色的元素。
- **Folder chip:** 与标签同尺寸，但用 `--item-hover` 底 + `--text-secondary` 文字，刻意比标签更低一档。

### Cards / Containers

- **Corner Style:** `--radius-md`（笔记卡片、设置行）/ 12.8px（内容卡片）。
- **Background:** 笔记卡片默认 `transparent`，悬停 `--note-card-hover`，选中 `--note-card-active`（比通用 fill 更轻，避免整块发灰）；设置行固定 `--fill-1`，悬停 `--fill-2`。
- **Shadow Strategy:** 无。见 Elevation & Depth。
- **Border:** 无。卡片的层次全部由 `--fill-*` 的明度差表达——描边不再常驻，只在控件可聚焦时出现。
- **Internal Padding:** 10px 12px（笔记卡片）、14px 16px（设置行）。
- **Card meta icons:** 置顶用 `pin`、`--text-secondary`、常规描边，不用强调色也不加粗——状态标记只是提示，不抢标题。

### Inputs / Fields

- **Style:** 无描边的 `--fill-2` 填充 + `--radius-sm`；悬停加深到 `--fill-3`。搜索框同样无描边，用 `--item-hover` 填充。
- **Focus:** 描边由 `transparent` 转 `--accent`，部分场景叠加 `0 0 0 4px var(--accent-bg)`。
- **Disabled:** `opacity: 0.45`，不改描边颜色。

### Navigation

- 图标栏导航项：`6px 8px` 内边距、`--radius-sm`、12.5px，三项之间 `8px` 间距；悬停 `--item-hover`；活动 `--item-active` + `--text-primary`，字重不变粗（选中只换色与底色，避免和相邻项糊在一起）。
- 分组标题：11px / 600 / 大写 / 0.5px 字距 / `--text-muted`。
- 设置左导航：12.5px 文字，活动态同一套 `--item-active`。
- 设置是独立窗口：有自己的标题栏与窗口控件，打开时不占用主窗口的标签栏与内容区。

### Signature: Browser Tab with Flare

高度 36px，`--radius-md` 只作用于上方两角。非活动标签完全透明、无描边；活动标签上/左/右各 1px `--border-color`、无底边、底色 `--bg-editor`，并且高度比容器多 1px 以压住内容卡片的上边框。两侧用两个径向渐变画出外翻的反向圆角，描边沿弧线连续，不出现"直边描边 + 圆角背景"的断层。相邻标签 `margin-left: -1px`，避免两条描边叠成 2px。

标签栏左侧不再有独立的「返回列表」按钮：取消当前选中即可回到列表，那枚按钮会让标题栏多出一条 40px 的空槽。

新建笔记 / 新建待办先开一个草稿标签（标题为「新建笔记」「新建待办」），只有真的写入标题或正文、经过一次自动保存后才落盘成正式条目；草稿期间关闭标签或切走会直接丢弃，不留下空文件。

### Signature: Note Card

10px 12px 内边距、`--radius-md`、默认透明。标题 13px/500 单行省略，预览 11.5px `--text-secondary` 单行省略，页脚 10.5px `--text-muted` 左侧相对时间、右侧文件夹片与最多两个标签片。待办卡片改为横向布局，左侧是 20px 的勾选框（`--radius-sm`，勾选后转 `--accent`）。

### Signature: Settings Row

`--fill-1` 底、无描边、`--radius-md`、14px 16px、最大宽 680px，悬停底色加深到 `--fill-2`。左侧两行：14px/500 标签 + 12px `--text-secondary` 描述；右侧控件（开关 44×24、下拉、30px 按钮）。分组标题前有一条 3px 宽、13px 高、`--radius-pill`、`--accent` 透明度 0.8 的竖条。

### Signature: Popover Menu

`--bg-list` 底、`1px var(--border-color)`、`--radius-md`、4px 内边距、`0 8px 24px rgba(0,0,0,0.25)`。菜单项 6px 10px、`--radius-sm`、12px，悬停 `--item-active`；危险项文字 `--danger`，悬停 `--danger-bg`。分组之间用 1px `--border-color` 横线分隔。入场动画 `dropdownIn 0.12s ease-out`。

macOS 的右键菜单与下拉菜单都不走这套自绘样式：主进程用 `Menu.popup` 弹出系统 NSMenu，菜单图标使用 macOS 内置的 SF Symbols；工具栏两个下拉也走同一条通道，只在 Windows / Linux 保留自绘菜单。

### Signature: Dialog Window

独立的无边框窗口，整窗只有一层表面，不做卡片：没有标题栏、没有窗口控件、没有内层描边与圆角。底色 `--bg-body`，四周 20px 内边距，内容直接摊在这块面上。

- **标题**：12px / `--text-secondary`，作为消息上方的分类标签，不抢主句。
- **消息**：13px / 600 / `--text-primary`，是弹窗的主句；详情 12px / 1.6 / `--text-secondary`，可换行。
- **图标**：20px Lucide，`--accent`，警告转 `--warning`、错误转 `--danger`。
- **按钮**：28px 高、`--radius-sm`；次要按钮用 `--fill-2` 底、悬停 `--fill-3`；主按钮 `--accent`、危险按钮 `--danger`。
- **拖动**：整个窗口都是拖动热区，输入框、标签片、勾选框与按钮区声明 `no-drag`，正文文字因此不可选中。
- **关闭**：只用取消按钮与 `Esc`，不提供关闭控件。

## Do's and Don'ts

### Do:
- **Do** 需要区分层次时先用 `--fill-1/2/3` 的明度差，而不是画线。
- **Do** 把新面板放进现有的三级表面（画布 / 列表 / 标题栏）之一，需要浮起时才加 `0 8px 24px rgba(0,0,0,0.25)`。
- **Do** 把控件高度控制在 26 / 28 / 30px 三档，内边距用 6 / 8 / 10 / 12 / 16 这几个步长。
- **Do** 让强调色保持在 10% 以内，并且只用于"当前"与"可提交"。
- **Do** 数字用 `--font-mono` + `tabular-nums`。
- **Do** 图标用 Lucide 线性图标，14 / 16 / 18px 三档，`stroke-width` 统一 `2`，不给单个图标或状态改描边。
- **Do** 用 `calc(var(--radius-md) * 1.6)` 给内容卡片，保持"纸"的一致感。
- **Do** 所有下拉、菜单、确认框自绘，保持与现有弹出层同一套描边与圆角；确认框本身不做外壳，见 Signature: Dialog Window。macOS 的右键菜单与所有下拉走系统原生 `Menu.popup`，不在此列。
- **Do** 让输入类控件的描边默认 `transparent`，只在 `:focus` 转 `--accent`。

### Don't:
- **Don't** 给静止状态的卡片、面板、按钮加阴影。
- **Don't** 给卡片、设置行、列表项、消息气泡加常驻描边——它们靠 `--fill-*` 分层。
- **Don't** 发明第四级表面色，或把 `--bg-elevated` 用在整块面板上。
- **Don't** 用 2px 以上的描边做分隔（`blockquote` 左边线与分组竖条除外）。
- **Don't** 把强调色用作图标默认色、大面积底色或页面背景。
- **Don't** 把基准字号提到 13px 以上来做层级；先加字重。
- **Don't** 使用 Chromium 原生 `<select>` 弹出层或自绘 SVG 图标（应用图标与托盘图标除外）。
- **Don't** 给整行设置项加位移或缩放反馈；底色加深已经够了。
- **Don't** 引入第二套圆角刻度或第二种阴影强度。
