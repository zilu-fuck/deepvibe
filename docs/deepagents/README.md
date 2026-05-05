# deepagents 学习资料

这套资料围绕本地仓库 `F:\github_far\deepagents` 整理，目标不是逐行解释源码，而是帮你快速建立三个认识：

1. 这个项目在做什么。
2. 它的技术栈和模块关系是什么。
3. 应该按什么顺序读，才能尽快读懂。

建议阅读顺序：

1. `01-overview-and-stack.md`
2. `02-architecture-and-folders.md`
3. `03-source-reading-path.md`
4. `04-practice-plan.md`
5. `05-deepvibe-go-migration-lessons.md`

对应仓库位置：

- 根目录：`F:\github_far\deepagents`
- 核心 SDK：`F:\github_far\deepagents\libs\deepagents`
- CLI：`F:\github_far\deepagents\libs\cli`
- 评测：`F:\github_far\deepagents\libs\evals`
- 示例：`F:\github_far\deepagents\examples`

如果你只想先抓主线，优先看：

- `F:\github_far\deepagents\libs\deepagents\deepagents\__init__.py`
- `F:\github_far\deepagents\libs\deepagents\deepagents\graph.py`
- `F:\github_far\deepagents\libs\deepagents\deepagents\middleware`
- `F:\github_far\deepagents\libs\deepagents\deepagents\backends`

一句话总结：

`deepagents` 是一个基于 LangChain 和 LangGraph 的 Python Agent 工程化项目，重点在于把模型、工具、文件系统、执行环境、子代理、上下文管理和评测体系组合成一个可运行的产品。
