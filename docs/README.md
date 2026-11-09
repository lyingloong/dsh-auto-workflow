# 文档导航

`dsh-auto-workflow` 的当前发布为 **v1.1.0**，首个公开发布为 **v1.0.0**。先安装插件，再选择目标项目和权限；阅读文档或打开看板不会自行启动业务。

## 第一次使用

1. [项目首页](<../README.md>)：安装、快速使用、主业务图、七个工具与安全边界。
2. [GitHub 项目本地持续开发](<examples/development/README.md>)：唯一主示例；克隆项目、materialize 脚本、初始化外部数据目录、PR 契约、输入需求、启动 producer、Human brief 和外部/self-merge。
3. [验证说明](<verification.md>)：回归覆盖、真实模型执行概况及尚未承诺的边界。

## 参考与排障

| 文档 | 负责回答的问题 |
| --- | --- |
| [插件参考](<plugin-summary.md>) | 定义、节点、输入映射、模型回退、JSON command 协议、权限和状态存储。 |
| [业务流程与保证](<workflow-summary.md>) | 用户优先、稳定 ID、每需求分支/worktree/PR、3+3 池、revision/epoch、审批与保留策略。 |
| [运行生命周期与排障](<run-lifecycle.md>) | idle、Human 等待、入队、暂停/Stop、Host 中断及显式恢复。 |
| [v1.1.0 发布说明](<releases/v1.1.0.md>) | PR 交流规范、状态块、merge-ready gate、`pr-init` 和外部/self-merge。 |
| [v1.0.1 发布说明](<releases/v1.0.1.md>) | 分支/worktree/PR 开发流、外部 merge 和 self-merge 的首个补丁发布。 |
| [v1.0.0 发布说明](<releases/v1.0.0.md>) | 历史首发范围、固定版本安装和发布边界。 |
| [更新记录](<../CHANGELOG.md>) | 公开版本重编号与废弃开发序列说明。 |

## 两层责任不要混淆

- **插件运行时**调度通用 packet、节点和引用；不会自动读取业务 `dataRef`，也不知道需求或 Git 分支是什么。
- **开发示例**是运行在插件上的应用代码。它只接收已有 seed 和显式用户 intake，不监听全部聊天、不自动抓 GitHub Issues；远端 push/PR 不在图内。
- **操作者**批准权限、提供真实输入和项目验证命令、处理 Human 门禁、检查中断现场，并负责备份与远端发布策略。

“持续”只描述 Host 常驻期间的调度；“持久化”描述落盘状态与引用。两者都不代表免审批、自动重放或掉电事务保证。
