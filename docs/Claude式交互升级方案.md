# DeepVibe Claude式交互升级方案

最后更新：`2026-05-03`

## 1. 背景

当前 DeepVibe 已具备以下能力：

- CLI 单次执行
- `chat` 交互式 REPL
- `--plan` 计划模式
- 工具调用、联网搜索、会话记忆
- 服务模式与插件系统

但从用户体验上看，仍更接近“仓库内 AI 编码工具”，还没有达到 Claude Code / Codex CLI 那种“先能对话，再自然进入工程协作”的感觉。

目前最明显的落差有三点：

1. 进入 `chat` 后，非 Git 目录下虽然已经能聊天，但仍缺少“自动接管工程环境”的能力。
2. 用户提出工程意图时，系统还不会主动把“纯聊天”切换为“工程协作准备阶段”。
3. Git 仓库初始化、模式切换、后续执行之间的衔接还不够自然。

## 2. 目标

把 DeepVibe 的交互从“能聊天的编码工具”推进为“更像 Claude Code 的开发搭档”。

当前已完成两个阶段：

- 第一阶段：非 Git 目录下的 chat-only mode 与工程意图触发的 `git init`
- 第二阶段：REPL 体验升级（欢迎页、模式提示、思考流与思考详情视图）
- 第三阶段：prompt/persona 重构（从“工程师人格”切换为“DeepVibe CLI 产品人格”）
- 第四阶段：执行约束升级（`run_command` 支持 Docker 只读沙箱）
- 第五阶段：工作目录信任模型（默认沙箱、手动切换 full access）

## 2. 当前进展

### 2.1 已完成：chat-only mode + 仓库初始化引导

已实现：

- 非 Git 目录下 `chat` 模式可直接聊天
- 识别工程意图后提示是否执行 `git init`
- 初始化成功后自动切换到 `project mode`
- 当前消息无需重输，继续原流程

### 2.2 已完成：REPL 基础体验升级

已实现：

- 进入 REPL 时显示 ASCII 欢迎图案
- 显示 `DeepVibe Chat ready.` 的就绪提示
- 明确提示当前是 `project mode` 还是 `chat-only mode`
- 顶部状态信息已收口为统一的 `Status` 面板
- 模型流式输出中，思考过程与正式输出分离：
  - 先显示 `Thinking...`
  - 正式回复以 `Assistant:` 分区展示
- `/help`、错误提示、工作区切换、变更确认已开始使用统一的面板式输出
- 思考内容默认收起
- 回复完成后可通过 `/thoughts` 查看最近一条完整思考过程

仍待提升：

- 点击式交互仍未实现，当前以键盘操作为主

### 2.3 已完成：Prompt / Persona 产品化

已实现：

- 主系统提示不再把模型定义成“经验丰富的软件工程师”
- `SYSTEM_PROMPT` 已重写为 `DeepVibe CLI` 的产品身份
- `PLAN_SYSTEM_PROMPT` 已重写为 `DeepVibe CLI in plan mode`
- `REPL_SYSTEM_PROMPT` 已重写为 `DeepVibe CLI in project mode`
- `REPL_CHAT_ONLY_SYSTEM_PROMPT` 已重写为 `DeepVibe CLI in chat-only mode`
- 项目自定义提示的拼接头从中文工程师语境，切换为更中性的 `Project-Specific Guidance`

### 2.4 已完成：命令执行 Docker 只读沙箱

已实现：

- `run_command` 可以按配置改为在 Docker 容器中执行
- 项目目录以只读方式挂载到容器
- 容器根文件系统默认只读
- 可写区域仅通过 `tmpfsPaths` 提供
- 网络默认可配置为 `none`
- 目标是把 AI 的命令执行与宿主项目文件系统隔离，降低误删/误操作风险

### 2.5 已完成：工作目录信任模型

已实现：

- 用户首次进入工作目录时，默认权限保持在受限制沙箱中
- CLI 会持久化记录工作目录的信任状态
- 用户只能通过显式手动操作将工作目录切换到 `full` 信任
- `sandbox` 模式下，DeepVibe 使用临时副本作为实际工作目录
- 这使得默认路径更偏安全，而不是直接拿真实项目目录做全部操作
- 当 sandbox 里产生真实文件差异时，系统会进入专门的 `Sandbox Landing Review` 阶段，再决定是否回灌真实工作目录

## 3. 阶段目标

下一轮优先做体验收尾：

- 为后续更完整的 TUI/点击式交互预留结构
### 第一阶段目标

- 在非 Git 目录中，`chat` 模式继续保持正常聊天能力。
- 当用户表达明确的工程意图时，系统主动识别。
- 若当前目录不是 Git 仓库，系统主动提示是否执行 `git init`。
- 用户确认后，DeepVibe 自动初始化仓库，并继续原始请求，而不是要求用户重输。

## 4. 产品行为设计

### 3.1 模式定义

DeepVibe REPL 分为两种模式：

- `chat-only mode`
  - 当前目录不是 Git 仓库
  - 正常问答、讨论、解释、脑暴都可继续
  - 不允许文件编辑、补丁、提交、仓库操作

- `project mode`
  - 当前目录是 Git 仓库
  - 启用完整工程能力：扫描、改文件、工具调用、计划执行、验证等

### 3.2 工程意图识别

在 `chat-only mode` 下，系统对用户输入做轻量意图识别。

识别为工程意图的典型场景：

- 明确要求“写代码 / 改代码 / 实现功能 / 创建项目 / 新建文件”
- 明确要求“修 bug / 重构 / 搭脚手架 / 建接口 / 补测试”
- 明确要求“帮我开始一个项目”

非工程意图示例：

- 解释概念
- 讨论技术方案
- 闲聊
- 纯问答

当前实现已升级为“对话式分类 + 启发式兜底”，既保留无 API key 时的本地判断，也能在有模型可用时获得更稳的工程意图识别。

### 3.3 Git 初始化交互

当满足以下条件时触发提示：

- 当前为 `chat-only mode`
- 用户输入被识别为工程意图

提示文案：

- 英文：`This directory is not a Git repository. Initialize one now so I can create and edit project files? [Y]es [N]o:`
- 中文：`当前目录不是 Git 仓库。是否现在初始化仓库，以便我创建和修改项目文件？[Y] 是 [N] 否：`

用户选择：

- `Yes`
  - 执行 `git init`
  - 成功后切换到 `project mode`
  - 继续处理当前这条用户消息

- `No`
  - 保持 `chat-only mode`
  - 当前消息继续按纯聊天回复
  - 若消息本身是代码修改请求，则提示需要 Git 仓库才能真正执行修改

## 5. 实现范围

第一阶段已实现范围：

- `docs/Claude式交互升级方案.md`
- `chat` 模式中的工程意图检测
- 非 Git 目录下的 `git init` 提示与执行
- 初始化成功后的模式切换
- 覆盖测试与 README 更新

当前仍未包含：

- 自动创建首个 commit
- 依赖安装、环境准备等多阶段初始化
- 更完整的点击式交互

## 6. 技术设计

### 6.1 第一阶段新增能力

- 在 `src/project/git-manager.ts` 中新增仓库初始化能力
- 在 `src/cli.ts` 中新增一次性写请求下的仓库初始化引导、自动计划模式与写后验证接入
- 在 `src/intent.ts` 中新增工程意图分类能力
- 在 `src/project-bootstrap.ts` 中新增空仓库最小脚手架引导
- 在 `src/verification.ts` 中新增写后验证能力
- 在 `src/repl.ts` 中新增：
  - 工程意图检测
  - Git 初始化确认
  - 初始化成功后的本地模式状态刷新

### 6.2 第一阶段状态流转

初始状态：

- 进入 REPL
- 检测 `inspectRepository(rootDir)`

处理一条用户消息时：

1. 若已是 Git 仓库：直接走现有 `executeReplTurn`
2. 若不是 Git 仓库且消息非工程意图：继续 `chat-only mode`
3. 若不是 Git 仓库且消息是工程意图：
   - 提示是否初始化仓库
   - 若确认：执行 `git init`
   - 刷新 `repositoryState`
   - 继续处理当前消息

### 6.3 第二阶段新增能力

- 在 `src/repl.ts` 中新增欢迎图案与就绪提示
- 新增思考内容缓存
- 新增 `/thoughts` 查看最近一条 reasoning trace
- 思考内容默认收起，正式回复单独展示

### 6.4 第三阶段已完成能力

- `/thoughts` 已切换为更明确的全屏查看模式
- 已支持 `Enter` / `q` / `Esc` 返回主 REPL
- 已保证 REPL 主会话上下文与输入焦点不丢失
- `Thinking...` 已从静态提示升级为动态状态展示
- 正式输出开始时会自动收起 thinking 动画，只保留正式回复与隐藏提示
- REPL 已开始采用轻量 TUI 布局：
  - 顶部 `Status` 面板
  - `You` 面板
  - `Assistant` 面板
  - `Commands` 面板
  - `Workspace` / `Error` / `Proposed Changes` 面板
- `You` / `Assistant` 已进一步从普通面板升级为更像聊天窗口的消息块样式

## 7. 验收标准

满足以下条件即可视为第一阶段完成：

- 非 Git 目录下运行 `pnpm cli chat` 时可以正常聊天
- 非 Git 目录下输入明显工程请求时，会主动提示初始化 Git 仓库
- 用户确认后，仓库被成功初始化
- 初始化后当前消息无需重输，直接继续处理
- 用户拒绝初始化后，仍可继续聊天，不会中断 REPL
- 相关测试通过

## 8. 后续阶段

当前状态：

1. 已完成：普通 CLI 单次执行已支持同样的自动 `git init` 引导
2. 仍待推进：将轻量面板布局进一步演进为更完整的固定区块式 TUI（状态栏 / 消息区 / 输入区）
3. 已完成：工程意图检测已从规则升级为对话式判断，并保留启发式兜底
4. 已完成：仓库初始化后已支持最小项目脚手架引导
5. 已完成：默认写操作已收口为 `plan -> confirm -> execute -> verify` 流程
