# 更新记录

## 未发布

- 示例 store/integration 锁改为自描述、自愈：owner.json 记录 token/pid/host/runId/tokenId 与获取/更新时间，持有期间心跳；TTL 到期且心跳停止的锁原子备份到 `locks/.stale/` 并写 `locks/events.log`，活锁只返回带 owner 摘要的有界 `BusinessBusy`；释放校验 owner token，旧 owner 不会删除新锁；新增 `driver locks` 只读检查/显式清理和 `status` 锁报告；command 节点获得 `DSH_WORKFLOW_RUN_ID`/`TOKEN_ID`/`PACKET_ID` 环境变量用于锁审计。（#36）
- 旧 head/revision 的授权 `@workflow` 命令不再被静默忽略：issue/PR watcher 回一条“目标/当前值 + 未自动应用”的回执（按评论 id 去重），并支持 `@workflow 确认按当前 head/revision 处理` 显式复用最近一条旧指令；不会自动应用旧命令。（#37）

- 需求 issue 与 PR 支持协作者自然语言 `@workflow` 命令：低思考 intent agent 只把授权命令当指令，最近评论（Codex 等）只作证据，输出 approve/revise/stop/clarify 或 merge/revise/stop/clarify；修订/返修生成引用评论 id 的 brief，新 revision/head 只通知一次“请检查”并附逐条 resolved/unresolved 映射；模糊或意图失败回澄清，精确命令仍是 fallback。agent 节点新增可选 `fallbackOutcome`，让意图模型失败走业务澄清而不是失败 packet。（#35）

- 看板节点图新增**极简**视图：只保留 agent 与关键 gate 节点，隐藏节点路径压缩为直接边，busy 重试门和 human/command 节点不显示；按钮按 完整 → 简化 → 极简 循环。
- PR watcher/merge 对 GitHub 瞬态失败重试：连接/超时/5xx/429 写入 `pr.retry` 有界退避并返回 `waiting`，连续 6 次后进入 `attention`；永久错误（auth/scope/404/validation/merge 状态）仍然失败 packet；丢失的 merge 响应在下次轮询先重读，绝不重复 merge。（#34）

- 需求 issue 与 PR body 改为 decision-first 模板：首屏是 What / Why / Acceptance / Decision 或 Change / Verification / Review verdict / Merge decision，完整证据折叠在 `<details>`；需求记录升到 store `v4`（summary/why/acceptance/evidence），旧 v3 通过 `driver migrate` 显式升级，保留审计字段。（#33）
- PR 合并决定移到 GitHub：`pr-watch` 读取协作者 `[verdict=pass|revise]` 评论、正式 review、未 resolve thread、CI 和 `@workflow merge`（`mergePolicy` 默认 `comment`，也支持 `auto`/`label`）；`pr-merge` 重新校验后用 merge commit 合并，阻塞反馈经 `pr-request-changes` 回到同一分支；PR 路径移除 `self-merge-human`/`merge-human` 看板 token，local fallback 保留看板 Human。（#32）

- agent 节点改用宿主结构化输出契约：provider 声明 `outputSchema` 能力时（内置 `spawn` 支持），子 agent 通过 `structured_output` 工具提交 `{outcome, output}`，宿主按 schema 校验后返回 `SubagentResult.structured`；未提交或不支持时保留文本 JSON 协议。无效结果附带最终文本节选。（#31）

- 新增图内 intake planner：`intake-record` → `intake-plan`（`reasoningEffort: low`）→ `intake-apply`，把宽泛用户请求固化为 1 条具体需求 + 0–3 个去重后的 seed。原文先以 `planning` 状态落盘（不可 claim、计入 backlog），planner 失败不丢输入；派生 seed 只进正常轮转、不自动开挖。（#28）

- 修复失败后的调度楔子：每个调度切片把所属 packet 已非 active 的 `ready`/`waiting` token 归档为 `cancelled`（reason `packet_not_active`），不再出现"状态 running、队列非空但永不执行"；失败/中断 token 仍作为 hot 证据保留。（#30）
- `summarizeRun` 的 `error` 只表示 run 级错误，新增有界 `lastFailure` 记录最近一次失败；`auto_workflow_control` 新增 `recover:true`，清理陈旧 pause/error 并唤醒 live run，不重放失败或中断工作。（#30）

- 需求审批从看板移到业务仓库的 GitHub issue：mid/high 挖掘需求由 `publish-requirement-issue` 脱敏发布，`check-requirement-issue` 读取维护者评论（`@workflow approve` / `@workflow reject <理由>`，仅 OWNER / MEMBER / COLLABORATOR 生效），`requirement-gate` 每 30 分钟复查；决定按 revision 绑定，旧评论不会批准新内容。移除 `requirement-human` 与 `requirement-decision` 节点/命令；`pr-init` 增加三个需求审批标签的检查与创建。
- `runner.updateModels` 的忙碌判定改为只看 `running`/`ready` token。v1.2.0 里"等待调度切片收尾"的写法会与调度锁互等，罕见情况下延迟 2 秒后仍然返回 409；现在与定义更新的守卫一致，parked 或无工作的收尾切片不再阻止改模型。

## v1.2.0 — 2026-11-23

修复 agent 节点在 DSH 0.2.2-rc.2 及之后无法启动的问题，并把最低 DSH 版本提升到该边界。

- `ctx.subagents.startActivation` 现在把 `prompt`、`parent`、`cwd`、`agentOptions` 按宿主 `SubagentActivationSpec` 放在顶层。真实分界线是 **0.2.2-rc.2**：`@deepseek-ai/dsh-subagent` 0.2.1-rc.5 与 0.2.2-rc.1 读 `spec.request.*`，0.2.2-rc.2 起读 `spec.*`（安装包里的 `docs/upgrade-guide/v0.2.1-rc.2/subagent-activation-options` 目录名早于实际发布边界，只能说明形状变化，不能当版本号用）。旧形状会让宿主读到 `undefined` 的 `parent`，表现为 `all model candidates failed: … Cannot read properties of undefined (reading 'id')`（#23）。
- **破坏性边界**：`engines.dsh` 由 `>=0.2.1-rc.5` 提升为 `>=0.2.2-rc.2`。已发布的 v1.0.0 / v1.0.1 / v1.1.0 在 0.2.2-rc.2+ 上会命中 #23；新代码也不能在 0.2.1-rc.5–0.2.2-rc.1 上启动 agent 节点。本机在 0.2.2-rc.5 上用真实模型冒烟验证过（单 agent 节点，返回 `{"ok":true}`）。
- 新增 `tests/host-contract.test.mjs`：用按宿主方式读取 spec 的桩锁定顶层形状、`parent` 身份和“不配置模型”的情形，并守住 `engines.dsh` 不落回嵌套区间。

### 其他修复

- `runner.updateModels` 不再把「刚收尾且没有剩余工作」的调度切片当成忙碌：run 刚 park 时从看板改模型不再偶发 409；真正有 running/ready 工作时仍立即拒绝。

### 示例：seed 轮转、在途水位与显式恢复

开发示例的业务存储升到 `version: 3`；版本 2 的旧库会被拒绝，需要新的 dataRoot（#24、#25、#27）。

- seed 状态收敛为 `queued` / `mining` / `proposed` / `retired`，公平性改为轮转位置 `rotationRound`：从未挖过的优先，其次最久未挖；`proposal:null` 保留原轮次（按最久未挖重排），需求 `merged`/`rejected` 则取新位置排到队尾。既不会像旧 `idle` 那样永久停止，也不使用时间冷却。
- 同一方向在前一个需求 settle 后再次挖掘会创建 `req-<seed>-r<n>` 后缀需求，不会与已终止的 `req-<seed>` 冲突；首次仍使用稳定 id。
- `queue-check` 的 backlog 改为「待实现需求 + 正在 mining 的 seed」，报告的 `headroom` 同时受水位与 store 的 `maxMiningSeeds` 限制；`seed-batch` 显式接收同一个 `maxPending`，只领剩余余额，14 个 baseline seed 不会在第一个需求出现前被领光。
- 模型返回的 `reason` 只作诊断元数据：非字符串或超长值不会把有效的 `idle` 结果变成失败的 packet。
- `pr-init` 新增 `manualGate`：把 branch protection、conversation resolution 与 required checks 降为警告（`required:false`），只保留 `gh` 认证、仓库访问、merge commit、`workflow:merge-ready` 标签和 PR template 作为硬性要求；每个检查现在带 `required` 字段，结果新增 `warnings`。（#26）
- 中断后 `mining` 的 claim 不再无声卡死：`status` 报出过期 claim（`staleClaimMs` 默认 30 分钟），新增 `recover-seeds`（支持 `dryRun` 和 `olderThanMs`）显式释放，运行时不自动回收——年龄分不清「慢 miner」和「中断 miner」。
- 新增 `retire-seed` / `rearm-seed`；`mining` 的 seed 必须先恢复再退役，已退役方向不会被需求 settle 复活，需求仍在进行中的方向也不能重新启用。
- miner 提示词要求先查已有需求、分支和 PR；方向已被覆盖时返回 `proposal:null` 并给出 `reason`，理由落到 seed 的 `lastReason`。
- 回归新增 12 项（轮转顺序、store 在挖上限与 headroom、显式恢复、在途水位、settle 回队、settle 后再挖、retire/rearm、版本拒绝、manual gate 等），全量 147 项通过。
- 示例脚本是 materialize 到业务仓库的副本；升级插件后要重新 materialize 才会生效。

## v1.1.0 — 2026-11-09

开发示例的 PR 交流规范与初始化。

- 新增 PR 契约：状态块、角色头、finding/thread、CI、merge 顺序与 `workflow:merge-ready` 标签。
- 新增 `pr-init`：创建 workflow 前检查仓库；默认只读，`apply` 只创建标签和缺失的 PR template，不自动修改 branch protection 或 merge method。
- head 变化、CI 失败、unresolved thread 或缺少角色头时撤销 merge-ready。
- 项目名统一为 `dsh-auto-workflow`；新增项目页。

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

`dsh-auto-workflow`是 DeepSeek Harness 的持久化、并发节点图工作流插件。仓库为 [lyingloong/dsh-auto-workflow](https://github.com/lyingloong/dsh-auto-workflow)，包名、看板和工具身份统一使用 `dsh-auto-workflow` / `auto_workflow_*`。

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
