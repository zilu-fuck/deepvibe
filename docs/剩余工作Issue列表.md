# DeepVibe Core 剩余工作 Issue 列表

基于以下材料整理：

- [项目计划.md](</F:/deepseek code/docs/项目计划.md>)
- [开发任务拆解.md](</F:/deepseek code/docs/开发任务拆解.md>)
- [README.md](</F:/deepseek code/README.md>)
- 当前实现代码与测试（截至 `2026-05-01`）

说明：

- 这里只列“还没收口”或“实现已有基础，但还没达到可交付状态”的工作。
- 已完成的 M1 主链、`@web`、Tool Calls、服务化第一版、插件系统第一版不再重复拆单。
- 每个 issue 都尽量落到可验证结果，避免只写方向不写完成标准。

进度更新：

- `2026-05-01`：Issue 1 已完成。
- `2026-05-01`：Issue 2 已完成，下一项为 Issue 3（命令执行权限模型二期）。
- `2026-05-01`：Issue 3 已完成，下一项为 Issue 4（插件生命周期与资源治理增强）。
- `2026-05-01`：Issue 4 已完成，补齐了插件生命周期语义、`dispose()` 失败清理保障、`maxResultChars` 结果大小限制与取消支持。
- `2026-05-01`：Issue 5 已完成，SSE 事件流已补充稳定事件信封、顺序验证与终态语义。

## 优先级总览

| ID | 优先级 | 标题 | 目标结果 |
|------|------|------|------|
| Issue 1 | P1 | 发布闭环与可安装验证 | 让 `deepvibe` 真正具备可重复发布、可验证安装的发布流程 |
| Issue 2 | P1 | CLI 逐文件选择性应用 | 把当前“看 diff 后全量接受/拒绝”补成“按文件选择应用” |
| Issue 3 | P1 | 命令执行权限模型二期 | 把当前命令策略从“能跑”补成“可解释、可治理、可文档化” |
| Issue 4 | P2 | 插件生命周期与资源治理增强 | 让插件不只“能隔离执行”，还具备更稳定的生命周期与资源边界 |
| Issue 5 | P2 | 服务端增量事件协议收口 | 把 `/tasks/:taskId/events` 从第一版能力收口成可对接客户端的协议 |

## Issue 1：发布闭环与可安装验证

- 优先级：`P1`
- 背景：
  - README 仍标注 `no README-driven installable release yet`。
  - 当前已有 [发布流程.md](</F:/deepseek code/docs/发布流程.md>)，但更像人工清单，还缺少“打包产物可安装、可执行”的自动化验证。
  - 文档里“安装包名/命令名/发布步骤”的叙述还没有完全收口，容易让第一次发布时踩坑。
- 目标：
  - 把当前仓库变成“按文档即可发布，并能在本地验证安装成功”的状态。
- 范围：
  - 明确对外发布名与安装文案：
    - 保持 npm 包名 `deepvibe-core`，还是改名为更贴近 CLI 命令的名字。
  - 增加本地发布 smoke test：
    - 从 `npm pack` 产物安装。
    - 验证 `deepvibe --help` 可运行。
    - 验证 `deepvibe serve --help` 或基础命令可运行。
  - 收口 README 与发布文档：
    - 安装方式
    - 发布前检查
    - 发布后验证
    - 包内容检查
  - 如有必要，补一个脚本化命令，例如 `pnpm release:smoke`。
- 非目标：
  - 不要求这一次补自动 changelog。
  - 不要求这一次接入完整 CI/CD 发布流水线。
- 建议改动位置：
  - [package.json](</F:/deepseek code/package.json>)
  - [README.md](</F:/deepseek code/README.md>)
  - [发布流程.md](</F:/deepseek code/docs/发布流程.md>)
  - `scripts/`
- 验收标准：
  - `pnpm release:check` 之后，可以在临时目录中用打包产物完成一次安装验证。
  - `deepvibe --help` 在安装后的环境中可直接运行。
  - README、发布文档、`package.json` 的包名与安装示例一致。
  - 打包内容不包含测试目录、临时文件、工作区垃圾文件。
- 依赖：
  - 无

## Issue 2：CLI 逐文件选择性应用

- 优先级：`P1`
- 背景：
  - 当前 CLI 已支持 `[A]/[R]/[N]` 确认与 diff review。
  - 但 review 之后仍然只能“整批接受”或“整批拒绝”，还不能按文件跳过。
  - README 也明确把 `interactive per-file selective apply` 标成当前缺口。
- 目标：
  - 用户在 review 阶段可以逐文件决定“应用 / 跳过 / 终止”。
- 范围：
  - 扩展当前 review 流程：
    - 展示每个文件的 diff。
    - 支持逐文件 `apply` / `skip`。
    - 保留 `apply all` 或 `reject all` 的快捷路径。
  - 在进入 patch 阶段前，仅保留用户选中的文件变更。
  - 更新结果摘要、AI commit、AI operation record：
    - 只记录实际应用的文件。
  - 明确“全部跳过”的行为：
    - 不写盘
    - 不生成 commit / operation record
    - 给出清晰提示
- 非目标：
  - 不做 hunk 级别选择。
  - 不做手工编辑 diff 的交互式 TUI。
- 建议改动位置：
  - [src/cli.ts](</F:/deepseek code/src/cli.ts>)
  - [src/engine.ts](</F:/deepseek code/src/engine.ts>)
  - [src/patcher.ts](</F:/deepseek code/src/patcher.ts>)
  - [tests/cli.test.ts](</F:/deepseek code/tests/cli.test.ts>)
  - [tests/engine-integration.test.ts](</F:/deepseek code/tests/engine-integration.test.ts>)
  - [tests/git-manager.test.ts](</F:/deepseek code/tests/git-manager.test.ts>)
- 验收标准：
  - 用户可以在 review 流程中跳过某个文件，只应用其余文件。
  - 跳过的文件不会进入 patch、commit、undo 记录。
  - 当所有文件都被跳过时，程序退出为“无变更应用”而不是“成功写盘”。
  - 干净工作区与脏工作区都各有覆盖测试。
- 依赖：
  - 无

## Issue 3：命令执行权限模型二期

- 优先级：`P1`
- 背景：
  - 当前实现其实已经不止 `low / medium / high` 三档风险：
    - 已支持 `allowInService`
    - 已支持 `allowedDirectories`
    - 已支持 `requireCleanGit`
    - 已支持 `allowPersistentApproval`
  - 但这些能力在 README 中没有完整体现，整体仍偏“实现可用、对外不可解释”。
  - 现在的策略仍主要依赖命令前缀匹配，离“更细粒度治理”还有一段距离。
- 目标：
  - 把命令权限能力收口成一套可配置、可解释、可测试的策略模型。
- 范围：
  - 第一部分：收口已有能力
    - README/示例配置补全现有字段说明。
    - 明确 `allowedPrefixes` 与 `commandPolicies` 的推荐关系。
    - 明确 service 模式、脏工作区、目录限制触发时的错误提示。
  - 第二部分：补一轮真正有价值的细粒度控制
    - 为单条 policy 增加局部资源控制，例如：
      - `timeoutMs`
      - `maxOutputChars`
    - 评估是否增加环境变量白名单类控制；若做，必须有清晰边界。
  - 第三部分：把测试矩阵补齐
    - policy 命中优先级
    - 目录约束
    - service 模式约束
    - clean git 约束
    - 持久授权与单次授权差异
- 非目标：
  - 不在这一单里实现完整 shell sandbox。
  - 不在这一单里做复杂的多代理授权编排。
- 建议改动位置：
  - [src/config.ts](</F:/deepseek code/src/config.ts>)
  - [src/tools.ts](</F:/deepseek code/src/tools.ts>)
  - [README.md](</F:/deepseek code/README.md>)
  - [tests/config.test.ts](</F:/deepseek code/tests/config.test.ts>)
  - [tests/tools.test.ts](</F:/deepseek code/tests/tools.test.ts>)
  - [tests/engine-integration.test.ts](</F:/deepseek code/tests/engine-integration.test.ts>)
- 验收标准：
  - README 中的配置示例能覆盖当前真正支持的 command policy 字段。
  - 每条 policy 可以覆盖全局超时/输出上限，且测试通过。
  - service 模式、脏工作区、目录限制的拒绝原因清晰可读。
  - `allowedPrefixes` 仍可兼容，但文档明确标注其定位。
- 依赖：
  - 无

## Issue 4：插件生命周期与资源治理增强

- 优先级：`P2`
- 背景：
  - 当前插件系统已经支持：
    - manifest 校验
    - 权限边界
    - 子进程隔离
    - 超时 / 内存上限
    - `initialize` / `dispose` hooks
  - 但当前 host 是“每次 describe / execute 新起一个进程”，生命周期非常短。
  - 这意味着：
    - 插件状态无法在同一次 run 中稳定复用。
    - `initialize` / `dispose` 更像单次调用钩子，而不是完整生命周期。
    - 结果大小、事件输出、取消清理等治理能力还不够细。
- 目标：
  - 让插件运行时具备真正可用的生命周期与更明确的资源边界。
- 范围：
  - 定义插件运行期生命周期：
    - 一次 run / 一次 task 内是否复用 host
    - `initialize` 在何时调用
    - `dispose` 在成功、失败、取消时如何保证执行
  - 增强资源治理：
    - 区分加载期与执行期超时
    - 限制插件执行返回结果大小
    - 明确插件异常如何上抛给引擎/服务端
  - 根据设计决定是否支持“同一任务内多次工具调用共享状态”
- 非目标：
  - 不在这一单里做插件市场。
  - 不在这一单里做跨任务持久插件状态。
- 建议改动位置：
  - [src/plugins.ts](</F:/deepseek code/src/plugins.ts>)
  - [plugin-host.cjs](</F:/deepseek code/plugin-host.cjs>)
  - [src/engine.ts](</F:/deepseek code/src/engine.ts>)
  - [src/server.ts](</F:/deepseek code/src/server.ts>)
  - [tests/plugins.test.ts](</F:/deepseek code/tests/plugins.test.ts>)
  - [tests/engine-integration.test.ts](</F:/deepseek code/tests/engine-integration.test.ts>)
- 验收标准：
  - 生命周期语义有文档化说明，并与代码一致。
  - 至少覆盖“成功执行”“执行报错”“任务取消”三种 `dispose` 行为。
  - 插件返回超大内容时会被稳定拒绝，而不是让引擎失控。
  - 如果支持任务内状态复用，测试能证明同一次 run 中状态可见；如果不支持，也要明确文档说明。
- 依赖：
  - 建议在 Issue 5 的事件协议之前完成，避免服务端行为反复调整

## Issue 5：服务端增量事件协议收口

- 优先级：`P2`
- 背景：
  - 当前已具备：
    - HTTP / JSON-RPC 第一版
    - task 并发隔离
    - SSE 事件流
    - 取消/中断语义
  - 但计划书和 README 仍承认，这一层还没有收口为“可稳定对接客户端”的增量协议。
  - 如果后续接桌面 App、VS Code 插件或其他 GUI，这一层会先成为集成摩擦点。
- 目标：
  - 把服务端 SSE / task 事件定义成一套稳定、可文档化、可测试的协议。
- 范围：
  - 明确事件类型与 payload：
    - task created
    - progress
    - model reasoning/content delta
    - tool call start/end
    - prepared execution / confirmation needed
    - completed
    - failed
    - cancelled
  - 保证事件顺序、终态一致性与错误语义。
  - 文档化最小客户端消费方式。
  - 如有必要，统一 CLI 与服务端对“流式增量内容”的表示。
- 非目标：
  - 不在这一单里做多节点服务治理。
  - 不在这一单里做鉴权系统。
- 建议改动位置：
  - [src/server.ts](</F:/deepseek code/src/server.ts>)
  - [src/task-manager.ts](</F:/deepseek code/src/task-manager.ts>)
  - [README.md](</F:/deepseek code/README.md>)
  - [发布流程.md](</F:/deepseek code/docs/发布流程.md>)
  - [tests/server.test.ts](</F:/deepseek code/tests/server.test.ts>)
- 验收标准：
  - SSE 事件类型与 JSON 结构有明确文档。
  - success / failure / cancel 三条主路径都有事件顺序测试。
  - 新客户端不需要依赖“解析人类可读日志文本”来驱动 UI。
- 依赖：
  - 与 Issue 4 有耦合；若插件事件要流式暴露，建议先确定插件生命周期语义

## 暂不建议现在建单的方向

这些方向不是不重要，而是按当前仓库阶段，先不建议排到最近一轮：

- 自动 changelog 生成
- 完整 CI/CD 发布流水线
- 插件市场与插件版本兼容矩阵
- 多节点服务治理
- Prefix Completion / FIM 集成实验

## 推荐执行顺序

1. Issue 1：发布闭环与可安装验证
2. Issue 2：CLI 逐文件选择性应用
3. Issue 3：命令执行权限模型二期
4. Issue 4：插件生命周期与资源治理增强
5. Issue 5：服务端增量事件协议收口
