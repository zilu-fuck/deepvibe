# 01. 项目定位与技术栈

## 项目定位

`deepagents` 不是单纯的 prompt 样例仓库，也不是只做学术算法的研究项目。

它更像一个“电池齐全”的 Agent 框架，目标是直接提供一个可运行的通用 Agent。它重点解决的是：

- 任务规划
- 文件读写
- Shell 执行
- 子代理分工
- 长上下文压缩
- 技能扩展
- 权限与执行边界

如果把它放到产品语境里理解：

- `libs/deepagents` 是核心 Agent SDK
- `libs/cli` 是终端产品形态
- `libs/evals` 是质量评测体系
- `libs/partners` 是不同执行环境和 sandbox 的适配层

## 主技术栈

### 后端语言

- Python 3.11+

核心包的 Python 版本要求：

- `libs/deepagents`：`>=3.11,<4.0`
- `libs/cli`：`>=3.11,<4.0`
- `libs/evals`：`>=3.12`

### Agent 框架

- `langchain`
- `langchain-core`
- `langgraph`

这说明它不是自己从零实现整套 Agent runtime，而是建立在 LangChain 生态上进行封装和增强。

### 观测与平台

- `langsmith`

它主要承担：

- tracing
- 调试
- 评测集成
- 部分 sandbox 能力支持

### 模型提供方适配

项目大量依赖 LangChain 的 provider 包，比如：

- `langchain-openai`
- `langchain-anthropic`
- `langchain-google-genai`
- 以及 CLI 中更多 provider 扩展包

这代表 `deepagents` 的风格是“借助统一抽象接入多模型”，而不是自己维护每家模型 SDK 的差异。

### 命令行和终端 UI

- `textual`
- `rich`
- `prompt-toolkit`

这部分主要在 `libs/cli`，用来做交互式 TUI，功能方向接近 Claude Code 或 Cursor 的终端模式。

### 前端 Web 栈

`libs/cli/frontend/package.json` 显示前端栈包括：

- React 19
- TypeScript 5
- Vite 6
- Tailwind CSS 4
- `@langchain/langgraph-sdk`
- `@langchain/react`
- Clerk
- Supabase

说明这个项目不只是本地 CLI，也考虑浏览器端部署和 Web 交互。

### 包管理与构建

- `uv`：依赖管理和 lockfile 非常明显
- `setuptools` / `hatchling`：不同子包分别使用

### 代码质量工具

- `ruff`：lint 和 format
- `pytest`：测试
- `ty`：类型相关静态检查

## 学习角度的价值

这个项目最值得学的不是“模型本身”，而是 AI 工程化：

- 如何组织 Agent 的能力边界
- 如何把工具系统做成可组合的 middleware
- 如何抽象本地和远程执行后端
- 如何给 Agent 加 tracing、评测和部署能力
- 如何从 SDK 延伸到 CLI 产品

## 一句话记忆

`deepagents = LangChain/LangGraph 生态上的通用 Agent 工程化封装`
