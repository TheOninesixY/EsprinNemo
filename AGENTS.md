- 任何用完即删，仅用来给你测试的东西，都需放在`.github/agents/tmp`文件夹下。
- 严禁更改`AGENTS.md`和`.opencode`文件夹下的任何文件
- 当有东西更新时，要自己看情况更改`README.md`、`DESIGN.md`、`PRODUCT.md`文件
- 文件名、文件夹名必须用`_`下划线分割
- 该项目使用Bun开发，严禁使用npm等其他nodejs包管理器
- 严禁在代码中添加任何注释
- 项目输出要有`[INFO]`、`[WARN]`、`[ERROR]`这三种日志输出，且要加上`[项目]`，例如：`[INFO] [Nemo] 本地预览已启动。`、`[INFO] [Sync] 构建成功。`。
- 该项目支持Windows和Linux，因此在编写代码时必须有这三个平台的针对性支持。
- 严禁自绘svg当图标，所有图标（除应用图标和托盘图标）都应使用`material-symbols`。
- 要确保应用的设计风格统一。
- 必须使用中文开发以及用中文和用户对话。
- 严禁任何外部在线依赖，所有依赖必须在`package.json`中声明。
- 在任务结束时，必须把你开启的终端全部关掉。
- 任何用户未要求的事情都不允许做，且在做任何事情之前都必须征得用户的同意。
- 当有任何不确定的事情时，必须征求用户的意见。
- 严禁擅自将自己的修改提交以及推送至仓库。
- 严禁自己测试以及启动应用。
- 要尽可能规避任何版权风险。
- 当你认为有东西能帮助以后的你，因此想把它记下时，请将记忆写在`MEMORY.md`中。

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.

OpenCode puts the MCP server's key in front of each tool's name, so it lists this tool as `codegraph_codegraph_explore` where other agents list `codegraph_explore`; if the server is registered under another key, that key replaces the first `codegraph_`.
<!-- CODEGRAPH_END -->
