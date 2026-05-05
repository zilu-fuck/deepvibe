# 03. 源码阅读路线

## 最短阅读路径

如果你的目标是“尽快读懂主线”，建议按下面顺序读：

1. `F:\github_far\deepagents\README.md`
2. `F:\github_far\deepagents\libs\deepagents\pyproject.toml`
3. `F:\github_far\deepagents\libs\deepagents\deepagents\__init__.py`
4. `F:\github_far\deepagents\libs\deepagents\deepagents\graph.py`
5. `F:\github_far\deepagents\libs\deepagents\deepagents\middleware`
6. `F:\github_far\deepagents\libs\deepagents\deepagents\backends`
7. `F:\github_far\deepagents\examples`

## 为什么这么读

### 第一步：先看 README

目标：

- 了解官方怎么定义这个项目
- 先建立产品视角，而不是一上来陷进实现细节

### 第二步：看 pyproject.toml

目标：

- 看依赖
- 看 Python 版本
- 看测试和 lint 工具
- 判断这个包依赖 LangChain 生态的深度

### 第三步：看 __init__.py

目标：

- 确认对外 API
- 找到最重要的入口函数

这里最关键的是：

- `create_deep_agent`

### 第四步：重点读 graph.py

这是主线中的主线。

你需要回答这几个问题：

1. `create_deep_agent` 需要哪些输入参数
2. 它如何决定默认模型
3. 它如何拼装 middleware
4. 它如何处理 subagents
5. 最终如何返回 LangGraph graph

如果这一步读懂了，你对整个项目就已经有骨架认识了。

### 第五步：读 middleware

推荐顺序：

1. `filesystem.py`
2. `subagents.py`
3. `memory.py`
4. `summarization.py`
5. `skills.py`
6. `permissions.py`

阅读目标：

- 每个 middleware 给 Agent 增加了什么能力
- 是在模型调用前做处理，还是在工具调用后做处理
- 这些能力之间如何协同

### 第六步：读 backends

推荐顺序：

1. `local_shell.py`
2. `filesystem.py`
3. `state.py`
4. `composite.py`
5. `sandbox.py`

阅读目标：

- 为什么 middleware 不直接操作真实文件系统
- 为什么要有 backend 抽象
- 本地执行和远程 sandbox 是怎么统一起来的

### 第七步：回到 examples

推荐先看：

1. `examples\deep_research`
2. `examples\text-to-sql-agent`
3. `examples\deploy-coding-agent`
4. `examples\repl_swarm`

目标：

- 看抽象如何落地
- 看不同 agent 任务需要哪些能力组合

## 一条适合做笔记的问题链

每读一个文件，都可以回答这三个问题：

1. 这个文件解决什么问题
2. 它依赖上游哪一层
3. 它给下游暴露什么能力

这样做能避免“看了很多文件，但脑子里没有结构”。

## 不建议的读法

- 不建议一开始就钻 CLI 细节
- 不建议先看全部 examples
- 不建议按文件名从上到下机械通读

原因很简单：

`deepagents` 的关键不是单个函数，而是模块组合关系。

## 读懂后的标志

如果你已经能回答下面这些问题，就算进入“基本读懂”阶段了：

- 为什么这个项目要有 middleware
- 为什么还要有 backend
- `create_deep_agent` 大概做了哪些组装
- 子代理和主代理是怎么分工的
- 文件系统工具和 shell 执行为什么被单独抽象
