---
version: 1
slug: "github-pages-index-html"
primary_target: ".github/pages/index.html"
related_targets: []
---

## Direction contract

THESIS: 官网是一块安静的展台，把「做好一个笔记」放在正中央，其余一切都退到产品截图之后。拒绝的品类默认：上方导航 + 左文右图 + 一排图标卡片的功能清单。

OWN-WORLD: 纯黑与纯白两种底色，中间只留一层 #1d1d1f 的面板与极细的 8% 白描边；字阶从 88px 到 12.5px 一档一档落下；唯一的彩色是系统蓝 #0071e3（浅色）与 #2997ff（深色），再加五个只出现在图标上的点色（紫、青、橙、粉、绿）。没有渐变文字、没有玻璃装饰、没有卡片描边套卡片。

STORY: 访客先读到「做好一个笔记，而非其他。」这一句，理解这不是又一个 All-in-one；然后看到真实界面截图，相信它确实只做笔记；接着确认数据就是普通 Markdown、同步是可选项、做不到的地方已经写明白；最后按下唯一的下载按钮。

FIRST VIEWPORT: 居中单列。导航是 52px 的半透明顶栏，品牌在左、四个锚点在正中、下载与主题开关在右。标题两行、88px、字距 -0.02em，正下方是一段 21px 的说明，再下方是胶囊主按钮「下载」与纯文字的「查看源码 ›」。之后是一行 13px 的版本与平台说明，再往下才是占满内容宽度的产品截图，截图周围有一圈极淡的蓝色辉光，向下渐隐进黑场。

FORM: code-led（`.impeccable/config.json` 的 `buildPath: code`），无 comp；签名交互是滚动进入时的单次上浮淡入与顶栏滚动进度线。seed: none (pinned)，方向由用户一句话钉住：「优化官网，要有 Apple 的风格。」

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
