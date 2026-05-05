# 05. 对 DeepVibe Go 迁移的启发

本文基于 `langchain-ai/deepagents` 当前 upstream 源码与官方文档整理，目标不是复制它的 Python/LangGraph 实现，而是提炼对 DeepVibe Go 重构有用的架构判断。

参考来源：

- https://github.com/langchain-ai/deepagents
- https://docs.langchain.com/oss/python/deepagents/overview
- https://docs.langchain.com/oss/python/deepagents/customization
- https://docs.langchain.com/oss/python/deepagents/subagents

## 一句话结论

`deepagents` 的核心价值不是“多几个工具”，而是把 agent 做成一个 harness：

1. 默认可运行。
2. 能规划。
3. 能读写文件。
4. 能执行命令。
5. 能创建隔离上下文的子代理。
6. 能压缩长上下文。
7. 能把执行环境和产品入口分层解耦。

DeepVibe Go 迁移应该吸收这个方向：从“engine 巨型总控”逐步重构成 `engine + middleware + backend + entrypoints + evals`。

## deepagents 的关键结构

### 1. graph 是总装层

`libs/deepagents/deepagents/graph.py` 的 `create_deep_agent` 负责组装模型、工具、middleware、subagents、backend、HITL、memory、skills、profiles。

对 DeepVibe 的启发：

- `internal/engine` 不应该长期承担所有能力。
- Go 版可以新增 `internal/agent` 或 `internal/harness`，负责组装运行链路。
- `engine` 更适合变成一次执行的编排器，而不是所有能力的归宿。

### 2. middleware 是能力注入层

deepagents 把 filesystem、subagents、summarization、permissions、skills、memory 等做成 middleware。它还保护关键 middleware 不被 profile 排除，例如 filesystem 和 subagent scaffolding。

对 DeepVibe 的启发：

- 现有 `internal/tools`、`internal/context`、`internal/git`、`internal/plugins` 可以继续保留，但应通过中间件进入执行链。
- 建议新增 `internal/middleware`：
  - `filesystem`
  - `permissions`
  - `summarization`
  - `subagents`
  - `skills/plugins`
  - `verification`
- 某些基础能力应该标记为 required，避免 profile 或配置把关键安全层绕掉。

### 3. backend 是落地层

deepagents 的 backend protocol 把文件系统、状态存储、sandbox shell、远程执行等统一成接口。文件工具本身不直接关心数据落在内存、磁盘、store 还是 sandbox。

对 DeepVibe 的启发：

- 当前 Go 版已经有 `internal/workspace` 和 `internal/tools`，下一步应抽出 `internal/backend`。
- 建议先定义接口：
  - `ReadFile`
  - `WriteFile`
  - `EditFile`
  - `ListFiles`
  - `Grep`
  - `Execute`
- 然后提供实现：
  - `LocalBackend`
  - `StateBackend`
  - 未来的 `SandboxBackend`
  - 未来的 `CompositeBackend`

这样工具层可以只依赖 backend protocol，避免本地文件路径、安全策略和执行环境散落在各处。

### 4. 文件权限应该在工具层显式执行

deepagents 的 filesystem permissions 是声明式规则，按顺序匹配 read/write 操作和路径。值得注意的是，它的权限在 filesystem tool 层执行，而不是 backend 层自动兜底。

对 DeepVibe 的启发：

- Go 版 `workspace.PathSafety` 只解决 path traversal 和 reserved directory，不等于完整 permission model。
- 应新增 permission rule：
  - operation: read/write/execute
  - path pattern
  - mode: allow/deny
- 所有 file tools 调用 backend 前必须走 permission check。
- 直接 backend 调用也要谨慎，尽量不要绕过 tool/middleware。

### 5. task/subagent 是上下文隔离工具

deepagents 的 `task` tool 用来启动 ephemeral subagent。子代理有自己的 system prompt、tools、middleware、permissions，可以继承或覆盖父代理配置。它的意义是隔离上下文，而不只是并发。

对 DeepVibe 的启发：

- 先不要急着做复杂多 agent UI。
- 可以先做一个 Go 版 `internal/subagent` 抽象：
  - `Spec{Name, Description, Prompt, Tools, Profile, Permissions}`
  - `Runner.Run(ctx, task)`
  - 返回单条 final report。
- 主 agent 侧暴露 `task` 工具。
- 子代理默认不共享完整会话历史，只拿任务说明、必要文件和工具能力。

### 6. planning 应成为工具，而不是只存在于 prompt

deepagents 通过 built-in todo tool 让模型显式维护计划。计划是可更新状态，不只是自然语言。

对 DeepVibe 的启发：

- 当前 `engine.Plan` 是一次性结构。
- 可以新增 `internal/todo` 或 `internal/planning`：
  - `write_todos`
  - `update_todo`
  - `list_todos`
- REPL 和 server 可以把 todo state 暴露给用户或前端。

### 7. 上下文管理要有“主动减压”机制

deepagents 把文件系统工具和 summarization 一起作为 context management：大输出可以进入文件，长对话可以自动摘要。

对 DeepVibe 的启发：

- 现有 `.deepvibe/context.json` 已经能存 session/turn/history。
- 下一步应加：
  - conversation summarizer
  - large tool output offload
  - per-session token usage tracking
- 摘要不应该只是 UI 功能，而应该进入执行链路。

### 8. CLI 是产品层，不应承载 agent 能力

deepagents CLI 很重，但它的 agent 能力仍然来自 SDK/harness。CLI 负责 TUI、session、approval、remote server、config、MCP、skills 等产品体验。

对 DeepVibe 的启发：

- Go 版 `internal/cli` 继续保持入口层。
- TUI、slash command、approval UI 可以逐步增强，但不要把权限、backend、工具执行逻辑写进 CLI。

### 9. 安全边界要写清楚

deepagents 的 README 明确说 agent 的边界应由 tool/sandbox 控制，而不是指望模型自律。CLI threat model 也把 HITL、MCP、hooks、sandbox、local server、env var 等边界拆得很细。

对 DeepVibe 的启发：

- Go 版需要自己的 `docs/security` 或 threat model。
- 优先关注：
  - shell command approval
  - plugin/MCP trust
  - local server auth
  - env var 泄漏
  - tool result prompt injection
  - session store plaintext
  - sandbox/full workspace 模式切换

## 建议调整 Go 迁移路线

在当前已经完成的基础上，推荐下一步顺序：

1. `internal/backend`
   - 定义统一文件/执行 backend protocol。
   - 先实现 local backend。

2. `internal/middleware`
   - 先做最小 pipeline。
   - 把 filesystem tools、permissions、context summary 逐步迁入。

3. `internal/planning`
   - 做 `write_todos` 状态工具。
   - 让 REPL/session 能保存当前 todo list。

4. `internal/subagent`
   - 做最小 `task` tool。
   - 子代理先复用当前 engine，但隔离 history/context。

5. `internal/verification`
   - 对齐迁移文档中的自动 lint/test/build。
   - 执行结果进入 turn record。

6. `docs/security`
   - 写 DeepVibe Go threat model。
   - 明确 trust LLM、tool/sandbox boundary、HITL 和 plugin/MCP 风险。

## 不建议照搬的部分

- 不要照搬 LangGraph 运行时。DeepVibe Go 版已经有自己的 server/task/engine 骨架。
- 不要为了“像 deepagents”而过早做复杂 async subagent remote protocol。
- 不要把 Python CLI 的 local dev server 模式原样搬到 Go。Go 版可以直接内嵌 HTTP server。
- 不要把权限只写进 prompt。权限必须是代码路径上的硬约束。

## 对当前 DeepVibe Go 代码的直接判断

当前方向基本正确：

- 已经有 `engine`。
- 已经有 `tools`。
- 已经有 `workspace.PathSafety`。
- 已经有 `server` 和 `task manager`。
- 已经有 `plugins` manifest 发现层。
- 已经有 `context store` 和 REPL session。

但下一轮重构需要把能力从 engine 外移：

- `engine` 负责跑一次 agent turn。
- `middleware` 负责把能力挂到 turn 上。
- `backend` 负责落地文件/命令/状态。
- `cli/repl/server` 只负责入口、展示、协议和审批。

这会让 Go 版更接近一个可长期演进的 agent harness，而不是一个越堆越大的 CLI engine。
