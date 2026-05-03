# DeepVibe Core

[English README](./README.md)

面向 DeepSeek 工作流的 CLI 优先 AI 编码引擎。

## 当前状态

当前仓库已经包含 `M1` MVP 基础能力：

- 带 `--help`、`--dry-run`、`--force` 和 `undo` 的 CLI 入口
- 支持 `.gitignore` / `.deepvibeignore` 的项目扫描
- 带 token 预算裁剪的上下文构建
- DeepSeek 请求构造、超时处理、重试/退避和 SSE 解析
- 结构化响应解析，并在首次解析失败时自动修复重试一次
- 差异应用与失败回滚
- AI 提交 / AI 操作记录
- 首版 `undo` 回退能力
- 带安全读写工具和命令白名单执行的 tool-call 循环
- 面向 1M 上下文窗口的 prompt 预算与更大的默认候选窗口
- 持久化会话记忆，存储于 `.deepvibe/context.json`
- 内置 HTTP + JSON-RPC 服务模式
- 基于任务的 SSE 事件流、取消和服务端并发隔离
- 首版本地插件系统，可扩展工具能力
- 插件生命周期 hooks，以及隔离的 initialize/execute/dispose 处理
- 通过 `.deepvibe/prompt.md` 注入项目级自定义系统提示词
- 带 chat-only/project mode 切换、流式输出和逐轮确认的交互式 REPL
- 在非仓库目录下，为 REPL 和单次写请求提供自动 `git init` 引导
- 面向空仓库的最小项目脚手架引导
- 带持久化、切换和历史的会话管理
- 多步骤计划模式，支持逐步执行
- 默认写请求会走 `plan -> confirm -> execute -> verify`
- 通过 DeepSeek beta completions API 与服务端点提供 FIM completion 支持

当前缺口：

- REPL 目前仍是持续演进中的面板式 TUI，而不是完全固定分区的终态布局
- FIM 已接入客户端/服务层，但面向编辑器的内联补全交互还未完成

## 环境要求

- Node.js `18+`
- `pnpm`
- Git
- 真实执行时需要 DeepSeek API key

## 安装依赖

```bash
pnpm install
```

## 本地开发

```bash
pnpm check
pnpm test
pnpm cli --help
```

## 配置

DeepVibe 会从以下位置读取配置：

- 全局：`~/.deepvibe/config.json`
- 项目：`.deepvibe/config.json`

最小配置示例：

```json
{
  "apiKey": "YOUR_DEEPSEEK_API_KEY",
  "defaultModel": "deepseek-v4-pro",
  "ignore": ["coverage/**"],
  "toolPermissions": {
    "command": {
      "enabled": true,
      "commandPolicies": [
        {
          "prefix": "git status",
          "risk": "low",
          "allowInService": true,
          "allowedDirectories": ["."],
          "allowPersistentApproval": true,
          "timeoutMs": 3000,
          "maxOutputChars": 2000
        },
        {
          "prefix": "git add",
          "risk": "medium",
          "allowedDirectories": ["src"],
          "requireCleanGit": true
        },
        { "prefix": "git push", "risk": "high" }
      ],
      "sandbox": {
        "enabled": true,
        "image": "node:20-alpine",
        "network": "none",
        "readOnlyRootFilesystem": true,
        "tmpfsPaths": ["/tmp", "/var/tmp"]
      },
      "requireApproval": true,
      "persistApprovals": true,
      "timeoutMs": 5000,
      "maxOutputChars": 4000
    }
  }
}
```

项目配置会覆盖全局默认值。

也可以通过 CLI 写入配置：

```bash
pnpm cli config set api_key YOUR_DEEPSEEK_API_KEY
pnpm cli config set default_model deepseek-v4-flash --project
```

如果你启动了需要真实模型执行的命令，但尚未配置 API key，CLI 会先提示你完成配置，并保存到全局配置后再继续。

工作区信任说明：

- DeepVibe 默认把新工作区视为 **sandbox**
- 第一次进入工作区时，CLI 可以询问当前目录保持 sandbox，还是标记为 fully trusted
- sandbox 模式会使用隔离的临时工作副本，因此不会直接修改原始项目目录
- 当 sandbox 模式产生真实文件修改时，DeepVibe 会先执行单独的 **Sandbox Landing Review**，再把变更落回原始工作区
- 之后也可以手动切换信任模式：

```bash
pnpm cli config trust sandbox
pnpm cli config trust full
pnpm cli config trust clear
```

- 只有明确的人工操作才应该把工作区提升为 full access

项目提示词说明：

- 如果存在 `.deepvibe/prompt.md`，其内容会追加到系统提示词中
- 这样仓库可以加入本地编码规则，而不需要完全替换内置提示词

命令工具说明：

- `run_command` 默认关闭
- 只有当 `toolPermissions.command.enabled` 为 `true` 时才会启用
- 命令必须匹配已配置的 `commandPolicies` 或兼容模式下的 `allowedPrefixes`
- 策略匹配使用 **最长前缀优先**，也就是更具体的规则优先生效
- 每条策略支持以下字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `prefix` | string | *(必填)* | 要匹配的命令前缀，例如 `"git status"`、`"pnpm test"` |
| `risk` | `"low" \| "medium" \| "high"` | 从前缀推断 | 风险等级；`high` 需要显式输入 `"allow"` |
| `allowInService` | boolean | `false` | 是否允许在 HTTP/JSON-RPC 服务模式下执行 |
| `allowPersistentApproval` | boolean | `low` 风险时为 `true` | 是否允许把 `"Always"` 选择持久化到 `.deepvibe/command-approvals.json` |
| `allowedDirectories` | string[] | *(任意目录)* | 把命令限制在指定项目子目录内 |
| `requireCleanGit` | boolean | `false` | Git 工作区有未提交改动时拒绝执行 |
| `timeoutMs` | number | 全局 `timeoutMs` | 单条策略级别的超时覆盖，最小 1000ms |
| `maxOutputChars` | number | 全局 `maxOutputChars` | 单条策略级别的输出长度限制，最小 256 |

- 可选的 `toolPermissions.command.sandbox` 可以强制 `run_command` 在 Docker sandbox 中执行，而不是直接在宿主机执行
- 推荐的只读 sandbox 示例：

```json
{
  "toolPermissions": {
    "command": {
      "enabled": true,
      "sandbox": {
        "enabled": true,
        "image": "node:20-alpine",
        "network": "none",
        "readOnlyRootFilesystem": true,
        "tmpfsPaths": ["/tmp", "/var/tmp"]
      }
    }
  }
}
```

- 开启 Docker sandbox 后：
  - 项目会以只读方式挂载到容器内
  - 容器根文件系统默认只读
  - 仅通过 `tmpfsPaths` 提供临时可写空间
  - 网络默认关闭（`none`）
- 这套机制的目标是把 AI 命令执行和宿主机上的破坏性操作隔离开
- 通过 DeepVibe 自身 patch/apply 流程执行的写操作，仍然由另一套机制控制
- `low` 风险：若启用了持久化审批，可以选择 `Always`
- `medium` 风险：仅支持一次性批准
- `high` 风险：需要显式强确认文本（输入 `"allow"`）
- 当 `persistApprovals` 为 `true` 时，选择 `Always` 会写入 `.deepvibe/command-approvals.json`
- 只有在完全可信的仓库里，才建议把 `toolPermissions.command.requireApproval` 设为 `false`
- 工作目录仍然会被限制在项目根目录下

旧版 `allowedPrefixes`（仅字符串数组、没有细粒度字段）仍然兼容，但不推荐继续使用；更建议改用 `commandPolicies`。

完整命令策略示例：

```json
{
  "toolPermissions": {
    "command": {
      "enabled": true,
      "requireApproval": true,
      "persistApprovals": true,
      "timeoutMs": 15000,
      "maxOutputChars": 16000,
      "commandPolicies": [
        { "prefix": "git status", "risk": "low", "allowInService": true, "allowPersistentApproval": true },
        { "prefix": "git diff", "risk": "low", "allowInService": true },
        { "prefix": "pnpm test", "risk": "low" },
        { "prefix": "npm test", "risk": "low" },
        { "prefix": "git add", "risk": "medium", "requireCleanGit": false },
        { "prefix": "git commit", "risk": "high", "allowedDirectories": ["src"], "requireCleanGit": true },
        { "prefix": "git push", "risk": "high", "allowInService": false },
        { "prefix": "pnpm build", "risk": "medium", "timeoutMs": 120000, "maxOutputChars": 32000 },
        { "prefix": "npm run build", "risk": "medium", "timeoutMs": 120000 }
      ]
    }
  }
}
```

会话记忆说明：

- DeepVibe 会把首版会话记忆存储在 `.deepvibe/context.json`
- 其中会记录轮次摘要、涉及文件、搜索摘要、工具摘要和结果引用
- 不会持久化原始 chain-of-thought，也不会存储大块原始文件内容

插件说明：

- 项目级本地插件可以放在 `.deepvibe/plugins/<plugin-name>/`
- 每个插件都必须提供一个 `plugin.json`
- 入口模块可以导出 `createTools(context)` 来贡献 `LocalTool[]`
- 插件可以在 `plugin.json` 中声明首版权限
- 服务模式下，如果插件清单没有显式允许，服务可以拒绝插件工具
- 插件代码通过隔离的子进程 host 执行
- 每次 `describe` / `execute` 调用都会使用新的插件 host 进程，插件状态不会跨调用持久化
- 插件源码仍会经过一层受限风格的预校验：
  - 禁止静态导入
  - 禁止动态导入
  - 不暴露 `process` / `require`
  - 不暴露基于字符串的代码生成
- 每次插件 host 调用都有超时、内存上限和返回结果大小限制
- 即使插件初始化或执行失败，也会尝试调用 `dispose()`
- 插件 host 调用会响应引擎取消信号 `abortSignal`
- 插件还可以声明：
  - `version`
  - `runtime.timeoutMs`
  - `runtime.memoryLimitMb`
  - `runtime.maxResultChars`
  - 可选生命周期钩子，例如 `initialize(context)` 和 `dispose()`

## 用法

Dry run 只会构建扫描/上下文状态，不会真正调用模型：

```bash
pnpm cli --dry-run "summarize the project"
```

带 `@web` 的 dry run 会把实时搜索结果注入上下文：

```bash
pnpm cli --dry-run "@web deepseek api timeout retry"
```

当前 `@web` 有两条路径：

1. 上下文注入
   - 当用户指令中包含 `@web` 时，引擎会先执行本地 Web 搜索
   - 搜索结果会格式化后放进上下文，模型能直接看到
2. 工具调用
   - 当用户指令中包含 `@web` 时，工具注册表还会暴露一个 `web_search` 工具
   - 模型可以在后续 tool loop 中再次调用它做补充搜索

搜索后端说明：

- 当前实现是本地多 provider 适配层
- 支持的 provider：
  - `duckduckgo`，默认/兜底的 HTML 搜索路径
  - `tavily`，通过 API key 调用
  - `bing`，通过 API key 调用
- DuckDuckGo 结果通过本地 HTML 抓取与解析获得
- 如果 DuckDuckGo 的 `fetch` 失败，会退回到 Python `urllib`
- 这不是 DeepSeek 原生的 web-search 请求参数

真实执行需要：

- 一个 Git 仓库
- 一个已配置的 API key

交互式执行：

```bash
pnpm cli "update API timeout handling"
```

CLI 会：

1. 如果当前目录不是 Git 仓库且请求需要写入，会先提示是否初始化 `git`
2. 对写请求自动切换到 plan mode，除非你显式使用 `--force`
3. 在执行前先展示计划给你确认
4. 逐步执行，并支持按文件 review 后再应用
5. 变更落盘后，如果工作区存在允许的测试/构建命令，会自动执行最佳努力验证

在 review 模式下，CLI 会逐个文件展示 diff，你可以在真正写入之前按文件决定应用或跳过。

如果仓库是刚初始化的空目录，且你的请求是“开始一个项目”，DeepVibe 会先尽量生成最小可行脚手架，而不是直接铺开可选基础设施。

跳过确认：

```bash
pnpm cli --force "update API timeout handling"
```

使用更快/更低成本的模型：

```bash
pnpm cli --flash "fix typo in README"
```

使用更高推理强度：

```bash
pnpm cli --deep "refactor the authentication module"
```

撤销最近一次成功的 AI 变更：

```bash
pnpm cli undo
```

启动内置服务：

```bash
pnpm cli serve --host 127.0.0.1 --port 4242
```

服务端点：

- `GET /health`
- `POST /run`
- `POST /completions/fim`
- `POST /undo`
- `POST /rpc`，用于 JSON-RPC 2.0
- `POST /tasks/run`
- `GET /tasks/:taskId`
- `GET /tasks/:taskId/events`（SSE）
- `POST /tasks/:taskId/cancel`
- `GET /sessions`
- `POST /sessions/new`
- `POST /sessions/switch`
- `GET /sessions/history`

任务事件流说明：

- `GET /tasks/:taskId/events` 会返回 SSE 事件，格式为 `event: <type>` 和 `data: <json>`
- JSON payload 使用稳定信封结构：
  - `id`：任务内事件序号
  - `taskId`：任务 ID
  - `type`：事件名
  - `source`：`task` 或 `engine`
  - `status`：事件发出时的任务状态
  - `terminal`：是否为终态任务事件
  - `timestamp`：ISO 时间戳
  - `version`：当前固定为 `1`
  - `payload`：事件专属字段
- 常见 task 级事件：
  - `task.started`
  - `task.cancel_requested`
  - `task.completed`
  - `task.failed`
  - `task.canceled`
- 常见 engine 级事件目前包括：
  - `scan.started`
  - `scan.completed`
  - `context.built`
  - `model.requested`
  - `model.completed`
  - `tool_calls.requested`
  - `tool_calls.completed`
  - `apply.completed`
  - `apply.skipped`
- SSE 流在终态事件后会自动关闭

## 交互式 REPL（聊天模式）

启动一个交互式 REPL 会话：

```bash
pnpm cli chat
pnpm cli chat --flash      # 优先 flash 模型
pnpm cli chat --deep       # 优先更高推理强度
pnpm cli chat --lang zh    # 强制中文界面
pnpm cli chat --lang en    # 强制英文界面
pnpm cli chat --session <id>   # 恢复指定会话
```

在 REPL 中：

- 如果当前目录不是 Git 仓库，DeepVibe 会先进入 chat-only mode
- 输入任意指令后，引擎会分析、流式输出结果，并在需要时要求确认
- 当存在拟议改动时，可以用 `[A]ccept`、`[R]eview`（看 diff）或 `[N]o`
- 粘贴的多行文本如果几乎同时到达，会被自动聚合为单次 turn
- 三个反引号包裹的 fenced block 会自动作为单次 turn 捕获；在闭合围栏前输入 `.cancel` 可以取消
- Slash commands：
  - `/new` - 开始新会话
  - `/history` - 查看对话历史
  - `/sessions` - 列出所有会话
  - `/switch <id>` - 切换到指定会话
  - `/effect [low|medium|high|xhigh]` - 设置推理强度；不带参数时按顺序轮转
  - `/model [flash|pro]` - 设置模型系列；不带参数时在两者之间切换
  - `/cost` - 查看计费轮次、最近一轮 usage 和当前会话总 usage
  - `/multiline` - 进入显式多行输入模式；空行发送，`.cancel` 取消
  - `/thoughts` - 打开最近一条被隐藏的 reasoning trace 查看器
  - `/clear` - 清屏（仅 TTY）
  - `/help` - 显示帮助
  - `/quit` 或 `/exit` - 退出 REPL

**会话：**

- 每个会话都有自己的对话历史和轮次历史
- 会话持久化在 `.deepvibe/context.json` 中（最多 20 个会话，每个会话最多 200 条聊天消息）
- 会话历史摘要会被注入上下文，用于跨轮次延续理解

chat-only mode 说明：

- 即使不在 Git 仓库里，普通聊天也能正常工作
- 在进入 Git 仓库之前，文件编辑、补丁应用和仓库操作都会保持禁用
- 如果你在 chat-only mode 下提出明确的建项目/建文件类需求，DeepVibe 可以提示是否执行 `git init` 并切换到 project mode
- 如果具备模型能力，DeepVibe 会优先使用对话式工程意图分类；否则回退到启发式判断
- 当你在 Git 仓库里打开 REPL 后，DeepVibe 会恢复完整项目模式

## FIM Completion

DeepVibe 现在通过以下接口暴露 Fill-in-the-Middle completion：

- HTTP：`POST /completions/fim`
- JSON-RPC：`deepvibe.completion.fim`

这条链路使用 DeepSeek 的 beta completions 端点，面向未来编辑器或 IDE 的 prompt/suffix 式补全接入。

## 多步骤计划模式

先生成计划，再按步骤执行：

```bash
pnpm cli --plan "add user authentication with JWT"
```

引擎会：

1. 生成包含概览、步骤和备注的多步骤计划
2. 让你先审阅并确认这份计划
3. 逐步执行，每一步都支持单独确认（`[A]ccept/[S]kip/[R]eview/[N]o stop`）

撤销行为：

- Git 工作区干净：如果最近一次 AI 提交仍在 `HEAD`，就直接回退该提交
- Git 工作区不干净：只有当前文件内容仍与记录的 AI 后像哈希一致时，才会恢复文件

## 脚本

```bash
pnpm check
pnpm test
pnpm build
pnpm cli --help
```

发布前的门禁命令：

```bash
pnpm prepublishOnly
```

推荐的完整发布检查：

```bash
pnpm release:check
pnpm release:smoke
```

`release:check` 会检查 typecheck、tests、build 和 tarball 内容。  
`release:smoke` 会把打包产物安装到临时前缀里，并验证发布后的 `deepvibe` 二进制能运行 `--help` 和 `serve --help`。

详细发布说明：

- [docs/发布流程.md](./docs/发布流程.md)

## 仓库说明

关键实现文件：

- [src/engine.ts](./src/engine.ts)
- [src/cli.ts](./src/cli.ts)
- [src/repl.ts](./src/repl.ts)
- [src/status.ts](./src/status.ts)
- [src/intent.ts](./src/intent.ts)
- [src/project-bootstrap.ts](./src/project-bootstrap.ts)
- [src/verification.ts](./src/verification.ts)
- [src/context-store.ts](./src/context-store.ts)
- [src/cli-confirmation.ts](./src/cli-confirmation.ts)
- [src/command-approval-store.ts](./src/command-approval-store.ts)
- [src/workspace-access.ts](./src/workspace-access.ts)
- [src/workspace-landing.ts](./src/workspace-landing.ts)
- [src/search.ts](./src/search.ts)
- [src/tools.ts](./src/tools.ts)
- [src/plugins.ts](./src/plugins.ts)
- [src/server.ts](./src/server.ts)
- [src/task-manager.ts](./src/task-manager.ts)
- [src/fim.ts](./src/fim.ts)
- [src/project/scanner.ts](./src/project/scanner.ts)
- [src/context/builder.ts](./src/context/builder.ts)
- [src/llm/deepseek-client.ts](./src/llm/deepseek-client.ts)
- [src/llm/response-parser.ts](./src/llm/response-parser.ts)
- [src/patcher.ts](./src/patcher.ts)
- [src/project/git-manager.ts](./src/project/git-manager.ts)

设计参考：

- [docs/项目计划.md](./docs/项目计划.md)
- [docs/开发任务拆解.md](./docs/开发任务拆解.md)
