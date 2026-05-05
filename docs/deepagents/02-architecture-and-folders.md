# 02. 架构与目录结构

## 仓库整体结构

仓库核心在 `F:\github_far\deepagents\libs`，主要目录如下：

- `deepagents`：核心 SDK
- `cli`：终端产品层
- `acp`：Agent Client Protocol 集成
- `evals`：评测系统
- `partners`：sandbox 和执行环境适配
- `repl`：REPL 相关能力
- `code`：预留包名，当前内容很少

## 核心 SDK 的三层结构

核心代码位于：

`F:\github_far\deepagents\libs\deepagents\deepagents`

这里最重要的三层是：

### 1. graph

代表文件：

- `graph.py`

职责：

- 提供 `create_deep_agent`
- 组装模型、工具、middleware、subagents
- 产出最终可运行的 LangGraph graph

可以把这层理解成“总装厂”。

### 2. middleware

目录：

- `middleware\filesystem.py`
- `middleware\memory.py`
- `middleware\skills.py`
- `middleware\subagents.py`
- `middleware\async_subagents.py`
- `middleware\summarization.py`
- `middleware\permissions.py`

职责：

- 给 Agent 注入能力
- 在模型调用前后做拦截和改写
- 处理上下文压缩、权限控制、技能加载、文件系统工具等

这是项目最有学习价值的一层，因为它体现了 Agent 能力如何模块化组合。

### 3. backends

目录：

- `backends\local_shell.py`
- `backends\filesystem.py`
- `backends\state.py`
- `backends\store.py`
- `backends\sandbox.py`
- `backends\composite.py`
- `backends\langsmith.py`

职责：

- 抽象底层执行和存储
- 决定工具能力最终落到哪里
- 支持本地 shell、状态存储、远程 sandbox 等

可以把它理解成“middleware 下面的基础设施层”。

## CLI 层在做什么

核心位置：

`F:\github_far\deepagents\libs\cli\deepagents_cli`

关键特点：

- 用 `Textual` 做 TUI
- 有会话状态和线程恢复
- 支持模型切换
- 支持 MCP 工具
- 支持审批流和技能调用
- 支持非交互模式和部署相关逻辑

这里更像一个完整产品，而不只是 demo。

## 评测层在做什么

核心位置：

`F:\github_far\deepagents\libs\evals`

你会看到：

- 单元测试
- 行为评测
- benchmark 数据
- LangSmith 集成
- Harbor 集成

这说明团队很重视“Agent 是否真的稳定可用”，不是只靠手动试一下。

## partner integrations 的意义

目录：

`F:\github_far\deepagents\libs\partners`

当前可见的适配包括：

- Daytona
- Modal
- Runloop
- QuickJS

这说明 `deepagents` 的执行环境是可插拔的。也就是同一个 Agent 框架，可以切换不同 sandbox 或代码执行后端。

## examples 的意义

目录：

`F:\github_far\deepagents\examples`

可学习的示例类型包括：

- deep research
- text-to-sql
- coding agent
- content writer
- GTM agent
- swarm / subagent

这些示例的价值在于帮助你把 SDK 抽象和真实 Agent 场景联系起来。

## 推荐的理解方式

读这个项目时，可以一直带着这条主线：

1. `graph` 负责组装
2. `middleware` 负责能力注入
3. `backends` 负责能力落地
4. `cli` 负责把 SDK 变成产品
5. `evals` 负责验证它到底好不好用
