# 业务流程与保证：GitHub 项目本地持续开发

这是 `dsh-auto-workflow`的**唯一主业务示例**：把 GitHub 仓库克隆到本地，每个需求在独立分支/attached worktree 中开发，由工作流发布自己的 draft PR；经过审查、Human brief 和外部 Codex/人 merge 后，只验证并清理。不是托管机器人，不自动监听聊天或抓取 GitHub Issues，也不自行 merge 远端 PR。

[完整操作指南](<examples/development/README.md>) 负责安装后的准备与操作；本页集中说明业务契约。实现由 [节点图](<examples/development/workflow.json>)、[业务存储](<examples/development/store.mjs>)、[本地 Git 模块](<examples/development/worktrees.mjs>) 和 [JSON driver](<examples/development/driver.mjs>) 组成。插件只调度通用 packet 和引用，不解释业务 `dataRef`。

## 执行链

```text
显式用户 intake ───────────────┐
已有 seed → producer / miner ──┴→ 稳定 ID 需求队列
  → 用户优先、priority、FIFO、ID 的确定性准入
  → 用户 / 挖掘 low：直接进入开发
    挖掘 mid/high：GitHub issue 需求审批（维护者评论 @workflow approve/reject）；拒绝反馈 → 同 ID 修订 → 再评估
  → 每需求一个 auto/req-* 分支 + attached worktree
  → begin-engineering → engineer 池（最多 3）
  → snapshot：整个分支压成单 commit，冻结 revision/epoch/commit/tree
  → push 分支并创建 draft PR
  → reviewer 池（最多 3；每需求只分配一位）
    revise → 同 ID / 分支 / worktree / PR 的下一轮开发
  → brief 生成 decision-first PR 摘要
  → ready-pr 标记自己的 PR ready
  → pr-watch 读取授权判决/review/thread/CI 和合并意图（默认 @workflow merge）
  → pr-merge 重新校验后用 merge commit 自己 merge；revise 回到同一分支返修
  → 外部提前 merge 时验证 review commit 在 base
  → 默认 after-verified-merge：清理 worktree 和本地需求分支
```

根并发为 **6**，所有节点共享，命令与 miner 也计入其中。3+3 是工作池容量，不是每项需求三轮审查，也不保证始终有六个模型同时工作。返修回到相同 engineer 流程、ID、分支、worktree 和 PR，不以新建需求或分支替代返修。

Human 等待不占工作槽，不阻挡其他 packet、producer 或新到达的需求。节点池可以 `running`、`idle`、`disabled`；结束的是单项执行/packet，不是整个服务。

## 输入来源与持续 producer

- **用户需求**只由获得授权的 intake 调用写入。优先级强制为 `0`，即使风险为 high 也跳过“需求是否开展”的审批；仍必须通过实现 review 与 Human merge 门禁。宽泛请求可以走图内 intake planner：`intake-record` 先把原文落成 `planning` 需求，`intake-plan`（低 reasoning effort）产出 1 条具体需求 + 0–3 个方向，`intake-apply` 去重后转 `queued`；派生 seed 只进正常轮转，不自动开挖。
- **挖掘需求**来自事先提供的真实证据 seed，优先级为 `1..9`。low 跳过需求审批，mid/high 在业务仓库的审批 issue 上由维护者评论决定：`@workflow approve` 或 `@workflow reject <理由>`，只有 OWNER / MEMBER / COLLABORATOR 生效，拒绝必须带理由。issue 发布前先做确定性脱敏（路径、邮箱、令牌、私有地址），首查立即执行、之后每 30 分钟复查。没有 seed 就不调用挖掘模型；无可行动建议的 seed 回到轮转队列并记下原因，不凭空制造需求，也不会被永久挂起。初始化会写入一组可选的 baseline discovery seeds（docs、refactor、page、chore、tests、dependency 等），它们只是发现方向，不是证据；miner 找不到具体问题仍应返回 idle。seed 的公平性按轮转位置 `rotationRound` 排序（从未挖过的优先，其次最久未挖），不使用时间冷却；`proposal:null` 保留原轮次，需求 merged/rejected 后其 seed 以新的轮转位置重新入队。同一方向的重复提案在前一个需求 settle 后使用 `req-<seed>-r<n>` 后缀，不会覆盖已终止的需求。
- 默认 `dispatch` 只准入有限批次。要持续处理，在同一 run 中显式向 `mine-gate` enqueue **一个** producer。它每轮经 60 秒 gate、backlog 水位检查、seed claim、detached miner packet、队列 dispatch、detached 需求 packet 后返回 gate。`backlog = 待实现需求（含 engineering）+ 正在 mining 的 seed`，达到工程师并发数 3 即只 dispatch 已有队列；`seed-batch` 只领剩余余额并受 `maxMiningSeeds` 限制。中断后留在 `mining` 的 claim 由 `driver status` 报出，只能显式 `recover-seeds` 释放，运行时不自动回收。
- 慢模型和 Human 等待不会牵住 detached producer。后续 seed 与用户需求可以继续写入；需要即时处理时可 enqueue 有限 `dispatch`，不要重复启动 producer。
- 优先级作用于业务队列的 claim；不抢占已经领取/执行的工作，也不承诺重排引擎中已经排队的 token。

## 身份、修订与存储

| 契约 | 具体保证与边界 |
| --- | --- |
| 稳定 ID | 一项需求一个 ID 和绝对 `dataRef`；需求 ID、seed ID、packet ID、引擎 artifact ID 各自独立。 |
| 同 ID 更新 | 仅 queued 项可 intake upsert，要求当前 `expectedRevision`，保留原 FIFO 顺序；active 项走反馈路径，不可覆盖。 |
| 单一分支/worktree | 每项保存 `auto/req-*`、`worktreePath` 和 `baseRevision`；worktree attached 到该分支。snapshot 压成单 commit，PR head 精确绑定它。返修、拒绝、停止、冲突不删除它。 |
| 需求审批绑定 | GitHub issue 上的决定只对发布时冻结的 `revision` 生效；发布后新增的评论才计入，旧 revision 的评论不能批准新规格。 |
| 工程轮次绑定 | `begin-engineering` 消耗上轮 admission 并增加 `engineeringEpoch`；snapshot 校验冻结的 revision + epoch，拒绝旧轮响应。长期 `claimId` 不是单轮能力凭证。 |
| 不可变实现与 review | 每轮实现、审查都是新记录；review/merge approval 绑定精确需求 revision、artifact 和 commit。脏 worktree 或改变的 HEAD 会阻止继续。 |
| typed busy | 只有 10 秒内未获得业务锁、受保护操作尚未开始时，才产生 `BusinessBusy`。driver 返回 `busy` 和原解析输入，图经 1 秒 gate 只重试该命令；不重跑前面的模型或不确定副作用。 |
| 本地一致性 | 唯一临时文件 + rename 更新单文件，目录锁协调本地进程；多文件不是一个事务，锁不会自动被夺取。 |
| 路径 | 限制 ID 字符、验证引用和所有权路径，拒绝 traversal/symlink 别名。每目标仓库只用一个项目外的绝对 canonical 数据 root。不是恶意文件系统的安全沙箱。 |

有效的审查返修使用业务 outcome **`revise`**，先落盘再进入下一轮，不借用通用失败预算的 `needs_revision`。示例没有自动业务返修次数上限；操作者可暂停节点。失败、取消或无效模型输出也不能冒充一次通过的 review。

示例业务存储为 `version: 4`（decision-first 需求字段 + GitHub merge policy），与包 SemVer 无关。旧 v3 库会被拒绝读取，先运行 `driver migrate`（默认 dry-run）显式升级；不静默迁移、不删除旧数据。

## 人工批准、PR 发布和保留

通用 Human 节点只记录小型 outcome/output；后续示例命令才写入业务决定。需求拒绝、实现返修/拒绝都需要有意义的反馈。PR 模式的新决定面是 GitHub：协作者的 `[verdict=pass|revise]` 评论或正式 review、未 resolve 的 thread，以及 `@workflow merge` / `workflow:merge` 标签；实现返修仍需反馈，但不依赖看板 token。本地 fallback 保留 Human。

Publish/ready/watch/merge 串行使用 store 级 integration lock。PR 发布前必须有当前 artifact 的通过 review；review pass + brief 后即可 ready，不需要内部 Human 先批准；watch 只读取工作流自己记录的 `prNumber`。工作流 push `auto/req-*` 分支、创建/编辑自己的 draft PR，读取授权判决后按 `mergePolicy`（`comment` / `auto` / `label`）用 **merge commit** 合并；外部提前 merge 同样被验证，不绕过 branch protection。

`brief` 在 review pass 后生成 decision-first 摘要（Change、Verification、Review verdict、Merge decision），同一份内容进入 PR body；完整需求/审查证据折叠。review/rework 会 force-push 同一 PR 的新单 commit，并重新绑定 artifact/review/反馈窗口。

PR body 顶部维护状态块（task/head/base/stage/next/order/ci），评论不承担状态。workflow 只在 head 匹配、CI 全绿或 `none`、review thread 全 resolve、合并意图满足时设置 `stage=merge-ready` 并添加 `workflow:merge-ready` 标签；head 变化、CI 失败、thread 未关闭或出现 `revise` 时撤销标签并回到返修。完整的判决标记、finding 和合并门规则见 [PR 交流规范](<examples/development/pr-protocol.md>)。

`pr-watch` 看到外部 `MERGED` 后 fetch `origin/baseBranch`、fast-forward 本地 base，并验证 review commit 是祖先；`pr-merge` 在真正合并前重新读取 PR，处理评论变化、外部抢先合并和 PR 关闭。所有合并都必须使用 **merge commit**，squash/rebase 会改变 SHA 并被明确拒绝。PR `CLOSED` 未合并时回到同一需求返修，不自动本地 merge。GitHub 瞬态失败（连接/超时/5xx/rate limit）会写入 `retry` 退避状态并返回 `waiting`，连续 6 次后进入 `attention`；永久错误仍然失败 packet。

需求 issue 和 PR 还支持**协作者自然语言 `@workflow` 命令**：低思考 intent agent 读取完整讨论（全部评论/正式 review，含旧 head/revision；分页、最新正文优先、旧正文可截断但元数据保留），只把授权命令当指令，评论只作证据，输出 approve/revise/stop/clarify 或 merge/revise/stop/clarify；修订/返修 brief 引用评论 id，新 revision/head 只通知一次"请检查"。精确命令与 verdict 仍是确定性 fallback。旧 head/revision 的授权命令会收到一次“未自动应用”的回执，并可用显式确认复用旧指令。命令按 accepted → running → completed/queued/stale 跟踪：返修完成的通知显示 `A → B`，不会把触发它的命令误判为 stale；运行期间到达的命令排队等待确认。示例锁使用 owner token、心跳和 TTL 接管；hard kill 留下的 stale 锁会被自动备份并审计，新 run 不需要手工移动锁文件。

`integrationMode:"local"` 只保留给没有 GitHub remote/token 的显式 fallback：跳过 PR，使用 `integrate` 本地合并与冲突 abort。正常开发不混用两种模式。

默认 **`after-verified-merge`**：验证外部合并后删除 worktree（含 ignored/untracked 临时文件），再删除本地 `auto/req-*` 分支。删除前复核批准 commit、祖先关系和 worktree HEAD；拒绝、关闭、冲突、未合并状态不清理。业务 JSON、不可变 artifact/review、PR 引用以及 `cleanedWorktreePath`/`cleanedBranch` 记录保留。

## 中断与显式 reconciliation

“持续”只在 Host 常驻运行期间成立；“持久化”提供状态、引用和意图证据，不是跨文件/Git 的掉电事务。失败或中断执行不自动重放，重启 Host 不会替操作者推断哪些副作用已经成功。

snapshot 会先保留精确 `snapshot-pending` 意图。若发布中断，可在检查 HEAD/tree/revision/epoch 后显式 `reconcile-snapshot`：只完成保留的那份 artifact，既有字节不得覆盖；成功后从 `review-input` 进入 review，而不是重跑工程阶段。其他 `preparing`、`integrating`、review 发布或清理的多文件不确定状态仍须人工检查与对账。步骤见 [操作指南的恢复部分](<examples/development/README.md#恢复与排障>)。

## 验证与非目标

[验证说明](<verification.md>) 区分可重复回归与隔离的真实模型/Git 执行，覆盖 3+3 并发、Human 返修、保留 worktree、review/epoch 绑定、typed busy、snapshot reconciliation、冲突和 ignored 数据保护。验证不是任意项目都能无人值守运行的保证。

使用前仍须 materialize 脚本并本地提交干净、配置模型工具与项目实际验证命令、提供真实需求、批准权限，并在运行中避免外部同时修改集成 checkout。备份、远端 PR/push、受保护分支策略、部署和外部数据发现属于操作者职责，不在示例图内。

更多运行时恢复语义见 [生命周期](<run-lifecycle.md>)。
