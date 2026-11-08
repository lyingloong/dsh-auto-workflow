# 运行生命周期与排障

`dsh-auto-workflow`把一个 run 作为持久化容器，让多份独立 packet 在其中流动。**持续运行不是免审批；状态落盘不是副作用可自动重放的承诺。**

## 创建、挂载与新任务

1. `auto_workflow_define` 保存节点图和用户批准的 command/HTTP 权限。
2. `auto_workflow_start` 绑定不可变的绝对项目 `cwd`、记录初始输入并创建 run；此时不执行节点。
3. `auto_workflow_run` 挂载当前会话的 managed job，立即返回回执。Host 活跃期间，idle、暂停或 Human 等待不要求不断重启 job。
4. `auto_workflow_enqueue` 接收 JSON `input` 和可选 `nodeId`，为现有 run 增加独立 packet 并唤醒调度；无 job 且控制允许时可冷启动。

新工作通过 enqueue 进入，不靠 start 新 run。一个 run 有一个 `runId`，但其中可以有许多 packet；某个 packet completed 时，run 仍可等待其他任务。

需求 ID、seed ID、packet ID 和 artifact 引用互不等同。业务 `dataRef` 由工作流应用主动读取，插件不会沿该路径自动加载业务文件。

## 先看什么

`auto_workflow_status` 是只读操作，优先检查：

- 绑定 `cwd`、`runId`、native `jobId`、运行状态和 error；确认不是在另一个项目执行。
- packet/token 的 running、queued、waiting、completed、failed、interrupted 计数。
- 节点池 `running / idle / disabled`、active/capacity、queued/waiting。
- 当前 Human token 及允许的 outcomes。
- 私有看板 URL；不要把含访问 token 的地址贴到公开记录。

`idle` 仅代表节点池当前没有活跃工作，不是“以后不会再运行”。`execution.mounted` 表示 native job 所有权；`execution.active` 表示当前调度工作，两者不同。挂载但空闲的 job 仍可 Stop。

## Human 是逐项等待

Human token 不占 worker 槽，也不停止其他 packet、节点或新到达的工作。对一个具体 token 使用 `auto_workflow_decide`，outcome 必须来自该 token 的声明；可提交小型 note/output。

不要把“新增 packet”当成 Human 决定。通用决策只保存引擎产物，不直接改业务 JSON；[开发示例](<examples/development/README.md>) 通过后续 command 记录 revision/产物绑定的业务审批。人工同意需求开展也不等于同意 merge，更不授权 push/PR。

## 暂停、禁用和 Stop 不同

| 控制 | 新准入 | 已在执行 | 已排队数据 |
| --- | --- | --- | --- |
| `continuous:false` | 全局暂停 | 排空在途执行，不主动取消 | 保留；`continuous:true` 继续 |
| `nodeId` + `enabled:false` | 暂停这个节点的队列 | 该节点在途工作仍可完成 | 保留；重新 enabled 唤醒 |
| `stop:true` | 停止当前 native job | 取消/收束执行，保存不确定状态 | 不授权自动重放；先检查再决定下一步 |

禁用一个节点不是取消。Stop 不是 rollback，也不会调用示例的业务 cleanup。单独关闭 producer gate 可停止后续周期，但已准入分支仍可完成；若还要阻止未启动的 miner，要同时关闭对应队列。

## 落盘、Host 重启与恢复

运行时在执行器副作用前记录 running token，在输出与后继节点确定后记录状态。payload 存于独立 artifact，checkpoint 主要存引用和有界元数据。

Host 停止、插件重载或执行所有者丢失后：

1. 无 live owner 的 persisted running token 被视为 interrupted 证据；不会因为收到另一次 Run 就隐藏地多执行一次。
2. 失败/中断执行不自动重放。先检查目标仓库、命令副作用、业务 store、Git 状态与意图记录，再显式恢复或创建新 run。
3. failed/interrupted 的 latest run 不阻止检查后创建新 run；仍有 ready、running 或 Human-waiting packet 的当前 run 应先继续或停止，而非绕开它并行新建。
4. 不支持的开发期状态保留并拒绝执行，例如缺少因果输入快照会返回 `unsupported_run_state`。不修改版本字段“升级”，不隐式迁移。
5. runner 会尽可能核实持久化执行所有权，不会仅因某个进程内映射为空就宣告仍活跃的 native job 已失联。

**不确定意味着需要检查，不等于可以重试。** 文件落盘与单文件原子替换不是多文件事务；Git/HTTP 已发生的操作无法靠回滚 checkpoint 撤销。不承诺掉电耐久性、分布式协调或 exactly-once。

开发示例对 `snapshot-pending` 提供显式 `reconcile-snapshot`；其余不确定边界和 Git 冲突仍需人工处理。具体步骤见 [恢复与排障](<examples/development/README.md#恢复与排障>)。

## 定义与模型变更

已有 run 使用冻结的定义；`auto_workflow_define` 保存的会话定义供新 run 使用。模型编辑仅在没有 running/queued packet 时允许，看板在执行期间锁定编辑。

有序 `config.models` 候选只在 provider/model 调用失败时切换。有效的负面业务 outcome 按边执行；返修、拒绝、取消、无效输出都不是要求换一个模型“直到同意”的信号。

模型/开发任务默认无截止时间。需要时显式指定正值 `timeoutMs` / `agentTimeoutMs`，`0` 禁用；command/HTTP 操作超时另行计算。控制 gate 的 `delayMs` 只是准入延迟，不是任务超时。

## Artifact 与大数据

引擎 artifact 默认上限 256 KB。大数据应保存在业务拥有的文件中，节点只返回类似下列小 envelope：

```json
{
  "dataRef": "C:/work/workflow-data/requirements/req-example.json",
  "cwd": "C:/work/workflow-data/worktrees/req-example",
  "label": "Example requirement"
}
```

看板按需加载 history/artifact，不将完整对话和业务文件复制到热状态。运行时 pruning 只清理不可达的引擎 artifact，不清理业务文件或 Git worktree。数据布局和协议见 [插件参考](<plugin-summary.md>)。

## 常见现象

| 现象 / 错误 | 排查方向 |
| --- | --- |
| start 成功但没有执行 | 是否调用 run/enqueue？`continuous` 是否开启？start 本身不执行。 |
| 节点一直 idle | 这是服务状态；检查有无该节点的 queued 输入，不要当作永久完成。 |
| 节点队列不前进 | 检查节点 enabled、根/节点并发容量以及 `pauseReason`。 |
| `control_off` / `nodes_disabled` | 控制暂停，不等于 job 已取消；按意图继续或 Stop。 |
| 开发示例不再领取新需求 | 是否仅运行了默认有限 dispatch，而未向 `mine-gate` enqueue 一次 producer？不要为每次运行重复添加 producer。 |
| `permission_denied` | 命令或 HTTP host 超出 grant；先取得用户批准，不能静默放宽。 |
| `invalid_command_cwd` | 检查绑定目录、静态 cwd、直接 npm script 所需的项目配置，不要在错误目录创建假的项目文件。 |
| `run_not_replayable` | 运行失败/中断；检查证据后显式创建新 run，不循环 Run。 |
| `failure_budget_exhausted` | 检查该 packet+node 的结果与历史；不是 provider fallback。示例有效业务返修用 `revise`，不借此预算。 |
| `artifact_too_large` | 把大 payload 写入业务文件，返回小引用。 |
| 示例反复 `busy` | 仅锁准入超时可延迟重试；检查锁所有者、活跃 job 与 Git 状态，不可自动夺取锁。 |
| `snapshot-pending` | 检查保留的精确 artifact 意图，再显式 reconcile；不要重跑工程阶段。 |

完整验证范围见 [验证说明](<verification.md>)。本地文件锁不是安全权限边界；模型工具、可信脚本、备份与项目操作授权仍需独立管理。
