# 更新记录

## v1.0.1 — 2026-11-08

分支/worktree/PR 开发流、外部 merge 与 Human 批准后的 self-merge。

- 初始化业务存储时写入 docs/refactor/page/chore/tests/security 等 baseline discovery seeds；它们只是发现方向，不是证据。
- miner 先发散 3–5 个方向再收敛，覆盖 correctness、reliability、performance、UX/accessibility、tests/observability、security 和 maintainability，并读取现有需求避免重复。
- 新增 `queue-check`：待实现需求（含 engineering）不超过工程师并发数时才自动挖掘，否则只 dispatch 已有队列。
- 真实 merge 冲突改为自动 `git merge --abort` 并回同一需求工程返修，不再进入人工冲突节点。
- 默认 `after-verified-merge`：验证合并后强制删除 worktree、本地 `auto/req-*` 分支及 ignored/untracked 临时文件；批准 commit、artifact/review、PR 引用和清理记录保留。
- 改为每需求一个 `auto/req-*` 分支 + attached worktree；snapshot 把分支压成一个 commit，分支推动对应 PR。
- 新增 pull-request 默认集成：第一次 snapshot 后推送分支并创建 draft PR；review pass 后用同一份 brief 更新 PR body 并标记 ready，外部可直接 merge，不需要内部 Human 先批准。只有 `selfMergeAfterMs` 宽限期后仍未合并时，才进入 `self-merge-human`；Human 同意后工作流自己用 merge commit 合并，再 fetch/verify/cleanup。
- Human 待处理详情改为结构化 merge brief（需求、改动、验证、审查、风险），原始输入折叠；同一 brief 作为 PR body。
- 看板节点队列改为可滚动彩色方块网格；简化节点图模式保留。
- 旧的 detached worktree 数据不迁移、不重放；新流程使用新的 dataRoot。

## v1.0.0 — 首个公开发布

`dsh-auto-workflow`（短名 Auto Workflow）是 DeepSeek Harness 的持久化、并发节点图工作流插件。仓库为 [lyingloong/dsh-auto-workflow](https://github.com/lyingloong/dsh-auto-workflow)，包名、看板和工具身份统一使用 `dsh-auto-workflow` / `auto_workflow_*`。

### 首发内容

- 持久化、并发节点图运行时：独立 packet、根与节点并发上限、detached fan-out、join、Human 门禁、调度 gate 和串行 subworkflow。
- 七个 `auto_workflow_*` 工具覆盖定义、创建、常驻运行、新任务入队、人工决策、控制与只读状态查询。
- Host 常驻期间，idle 和 Human 等待不结束 job，也不阻塞无关 packet；运行状态以引用落盘，产物与有界历史分离。
- 用户批准的 command/HTTP 权限，默认 deny；有序模型回退与逐候选 reasoning effort。有效的业务返修或拒绝不触发模型回退；模型任务默认无截止时间。
- 会话看板显示节点池容量、队列与 Human 待办，支持模型选择与按需读取历史/产物；节点队列在独立滚动区域中展示。
- 唯一主示例：GitHub 项目本地 clone 的持续开发。用户需求 priority `0`、稳定 ID、每需求保留一个 detached worktree、3 engineer + 3 reviewer 池（每需求一位 reviewer）、精确产物绑定的 Human merge 门禁、串行本地集成及默认 `retain`。
- 示例包含 typed `busy`、需求 revision 与 `engineeringEpoch` 防陈旧响应、不可变实现/审查记录、显式 snapshot reconciliation、冲突保留和受保护的清理。
- 源码树使用当前布局 `src/`；历史版本化目录已清理。旧开发期 tag 和本地 `3.0.x` 快照不属于本次发布序列。
- 中文优先的安装与使用指南、发布说明和公开验证概况；不加入自动 GitHub Issue 抓取、远端 push/PR、远端 merge 或部署。

### 编号与兼容边界

本次从 **v1.0.0 建立公开发布序列**。旧开发标签 `v0.1.0` 至 `v2.7.0`（包括旧的同名 `v1.0.0`），以及本地 `3.0.x`，均属于废弃开发序列；它们不是本次首发的兼容基线。Git 历史仍保留，不提供旧工具别名、旧定义/运行状态/业务存储的兼容层，也不作迁移承诺。已有开发期数据应先保留检查，再使用新的存储和 run，不能靠改版本字段转换。

以下版本各自描述不同契约，**不是 package SemVer**：

| 层 | 首发采用的版本 |
| --- | --- |
| 插件包 / GitHub Release / tag | `1.0.0` / `v1.0.0` |
| 节点图定义 | `apiVersion: 2` |
| 持久化运行状态 | `version: 3` |
| 示例业务存储 | `version: 2` |

### 持久化不等于自动恢复

Host 停止、插件重载或执行所有者丢失时，失败/中断证据保留，不自动重放有副作用的工作。单文件原子替换不构成多文件、Git 或 HTTP 的掉电事务。使用者须检查现场并显式恢复。

详见 [v1.0.0 发布说明](<docs/releases/v1.0.0.md>)、[验证说明](<docs/verification.md>) 与 [运行生命周期](<docs/run-lifecycle.md>)。
