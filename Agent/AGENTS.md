# 项目协作规则

## 一、授权与边界

1. 用户未要求的事一律不做。任何改动动手前先说明范围并征得同意。
2. 遇到不确定的地方先问，不得自行假设后继续执行。
3. 严禁擅自提交与推送。`git add`、`commit`、`push`、`stash`、`reset`、`checkout` 等改变仓库状态的操作，未经同意不得执行。
4. 严禁自行测试或启动应用。需要验证时，把命令交给用户执行。
5. 任务结束时，关闭自己开启的全部终端会话。

## 二、文件与目录

6. 仅供临时测试、用完即删的文件，一律放在 `Agent/tmp/` 下，任务结束时清理。
7. 严禁修改 `AGENTS.md` 与 `.opencode/` 目录下的任何文件。
8. 文件名、文件夹名一律用下划线 `_` 分词，不使用空格、连字符或驼峰。
9. 内容有变更时同步更新 `README.md`、`DESIGN.md`、`PRODUCT.md`；改动前先说明要改哪几处。
10. 认为对以后有用的结论写入 `MEMORY.md`，只记跨会话有效的内容。需要注意的是，它虽然链接至 `.opencode/skills/esprin-nemo/SKILL.md` 但并不受规则 7 的限制。

## 三、技术栈与依赖

11. 项目使用 Bun 开发。严禁使用 npm、pnpm、yarn 等其他 Node.js 包管理器，锁文件只保留 `bun.lock`。
12. 严禁任何运行时在线依赖：不得从 CDN、远程地址或在线字体服务加载资源。所有依赖必须在 `package.json` 中声明，并通过包管理器本地安装。
13. 项目需同时支持 Windows、Linux、MacOS。路径分隔符、换行符、环境变量、文件权限、shell 命令等差异处必须分别处理，不得只按一方编写。

## 四、代码与日志

14. 代码中不添加任何注释。
15. 日志统一为 `[类别:级别] 动作：消息`，级别仅三种：`INFO`、`WARN`、`ERROR`，类别仅三种：`Desktop` 、`Mobile`、`Sync`。示例：
    - `[Desktop:INFO] 本地预览已启动。`
    - `[Sync:INFO] 构建成功。`
    - `[Mobile:ERROR] 本地预览启动失败，退出码 1。`
16. 类别名为英文单词、首字母大写、不含空格；同一模块的类别名保持固定。

## 五、界面与资源

17. 设计风格必须统一；颜色、间距、圆角、字号取自项目已有的设计变量，不新增一次性样式值。若不知道此项目的设计风格，请查看 `Agent/DESIGN.md`。
18. 图标一律使用 Lucide。严禁自绘 SVG 充当图标，严禁使用已弃用的 `material-symbols`。应用图标与托盘图标不在此限。
19. 尽可能规避版权风险：不复制来源不明的代码与素材，不内嵌未获授权的字体、图片、图标。

## 六、语言

20. 必须全程使用中文：与用户对话、界面文案、项目文档均使用中文。

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.

OpenCode puts the MCP server's key in front of each tool's name, so it lists this tool as `codegraph_codegraph_explore` where other agents list `codegraph_explore`; if the server is registered under another key, that key replaces the first `codegraph_`.
<!-- CODEGRAPH_END -->
