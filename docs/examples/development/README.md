# GitHub 项目本地持续开发

这是 `dsh-auto-workflow`的**唯一主示例**：克隆 GitHub 项目，在本地持续处理真实需求。每个需求拥有独立 `auto/req-*` 分支、attached worktree 和 draft PR；工作流审查并生成 brief，外部 Codex/人 merge PR 后，工作流只验证并清理。示例是应用代码，插件只提供通用调度；没有远端 Issue/聊天监听器或外部审批端点。

**阅读文档不会启动任何操作。** 下面是供操作者检查、替换路径并明确授权后执行的说明，不是对当前仓库或远端的自动操作。首次使用先看 [项目首页](<../../../README.md>)；业务不变量集中在 [流程与保证](<../../workflow-summary.md>)。

## 组件与准备条件

| 组件 | 职责 |
| --- | --- |
| [workflow.json](<workflow.json>) | 一个 run 中的周期 producer、分支/worktree、3+3 工作池、PR 发布/轮询与 Human brief。 |
| [store.mjs](<store.mjs>) | 稳定 ID、优先级/FIFO、claim、revision/epoch、审批与反馈。 |
| [worktrees.mjs](<worktrees.mjs>) | 每需求分支/attached worktree、单 commit 快照、review、brief 与受限清理。 |
| [pr.mjs](<pr.mjs>) | push 需求分支、创建/更新自己的 draft PR、维护 PR 状态块/标签、轮询外部 merge。 |
| [pr-protocol.md](<pr-protocol.md>) | 角色头、状态块、finding、merge-ready 标签和 PR 初始化约定。 |
| [driver.mjs](<driver.mjs>) | command 节点使用的 JSON-only CLI。 |

开始前逐项确认：

- Node.js 22.5+、Git、已安装的插件以及可用模型路由。agent 能在指定 worktree 读写、运行项目实际验证命令并本地提交；reviewer 只读审查，不改代码或提交。
- 目标是已有提交的非 bare GitHub clone，有 `origin`、本地 Git author identity，并已 `gh auth login` 或设置 `GITHUB_TOKEN`。需要 `Contents: Write` 和 `Pull requests: Write`；自行处理项目 hooks、签名和依赖。
- 选择一个**项目及其 worktree 外部**的绝对、canonical `dataRoot`，不使用 symlink/junction 别名。每个目标仓库只用一个 store。
- 集成 checkout 始终处于配置的 `baseBranch`，干净且无进行中的 merge；外部 merge 后工作流会 fetch 并 fast-forward 本地 base。运行期间不要由其他工具同时改动它。
- 仓库的 PR 合并方式应为 **merge commit**；squash/rebase 会改变批准 commit 的 SHA，工作流会报错而不是静默接受。
- 创建 workflow 前先运行 [PR 契约初始化](#15-仓库-pr-契约初始化)：检查 label、PR template、branch protection 和 merge method；默认只做只读检查。
- 检查图里的 agent prompts，补充目标项目的实际验证命令和限制。示例未固定 provider/model，使用 Host 配置；如需有序候选，按 [插件参考](<../../plugin-summary.md>) 设置 `config.models`。模型任务默认没有截止时间。
- command/HTTP 默认 deny，先获得用户明确批准；agent 的工具权限另行配置，命令 allowlist 不会替 agent 建立文件系统沙箱。

## 1. 克隆项目并 materialize 示例

以下 PowerShell 示例使用虚构路径和 `OWNER/PROJECT` 占位符，请先替换。克隆、`gh auth` 和 push/开 PR 都属于明确授权的操作。

```powershell
git clone https://github.com/OWNER/PROJECT.git C:/work/project
Set-Location C:/work/project
git switch -c integration/workflow-batch
gh auth status
```

`integration/workflow-batch` 是 PR 的共享 base 分支；每个需求另有自己的 `auto/req-*` 分支，不从 base 之外复制。不要把受保护的 `main` 直接作为可写 base，除非你们明确允许。

从固定 v1.0.1 的源码 checkout 或解压后的发行包取得上表六个文件（含 `pr-protocol.md`）。安装插件不等于把它们放进业务项目；需要明确复制到图使用的相同路径。若目标已有同名文件，先比较，**不要直接覆盖**。

```powershell
$ExampleSource = 'C:/work/auto-workflow-release/docs/examples/development'
New-Item -ItemType Directory -Force docs/examples/development | Out-Null
Copy-Item "$ExampleSource/driver.mjs", "$ExampleSource/store.mjs", "$ExampleSource/worktrees.mjs", "$ExampleSource/pr.mjs", "$ExampleSource/pr-protocol.md", "$ExampleSource/workflow.json" -Destination docs/examples/development
# 检查脚本和提示词，补充项目验证要求后，仅本地提交这些文件
git add -- docs/examples/development
git commit -m "Add local development workflow"
git status --porcelain
```

最后一条应无输出；确认脚本已进入基线提交、工作区干净，再开始业务执行。示例模块只依赖 Node.js 内置模块；项目自身的依赖、构建和验证仍需准备。

command 节点执行的是固定命令，例如 `node docs/examples/development/driver.mjs prepare`，其 cwd 为**绑定的项目根目录**。不存在 `${input...}` shell 插值。agent 的 cwd 由小 envelope 指向各需求 worktree。run 创建后不可更换绑定项目。

## 1.5 仓库 PR 契约初始化

在创建/启动 workflow 前，先按 [PR 交流规范](<pr-protocol.md>) 检查目标仓库。默认只读，不改 branch protection 或 merge method：

```powershell
$env:DSH_WORKFLOW_INPUT = '{"repoRoot":"C:/work/project","baseBranch":"integration/workflow-batch"}'
node docs/examples/development/driver.mjs pr-init
```

检查项包括：

- `gh` 认证和仓库权限；
- 是否允许 merge commit；
- branch protection 是否要求 PR、conversation resolution 和 required checks；
- 是否存在 `workflow:merge-ready` 标签；
- PR template 是否包含状态块。

只创建标签和缺失的 PR template：

```powershell
$env:DSH_WORKFLOW_INPUT = '{"repoRoot":"C:/work/project","baseBranch":"integration/workflow-batch","apply":true}'
node docs/examples/development/driver.mjs pr-init
```

`pr-init` **不会**自动修改 branch protection、required checks 或仓库 merge method；这些设置影响所有贡献者，必须由管理员确认后手动配置。检查未通过时，会话不能直接定义/启动 workflow。

## 2. 初始化数据并提交真实输入

继续在目标项目根目录运行；以下 `dataRoot` 与项目并列，位于项目外：

```powershell
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data","repoRoot":"C:/work/project","baseBranch":"integration/workflow-batch","cleanupPolicy":"after-verified-merge","integrationMode":"pull-request","prRemote":"origin","selfMergeAfterMs":300000}'
node docs/examples/development/driver.mjs init
```

配置一经初始化不可静默更换。`integrationMode:"pull-request"` 是新默认：每个需求 push 到 `auto/req-*` 分支并创建自己的 draft PR；review pass 后 PR 标记 ready，外部 Codex/你可以直接 merge，不必先经过工作流内部 Human。宽限期 `selfMergeAfterMs` 内没有外部 merge 时，`check-pr` 才进入 `self-merge-human`；Human 同意后才由工作流用 **merge commit** merge 自己的 PR，再验证/清理。`selfMergeAfterMs` 默认 `300000`（5 分钟），设为 `0` 表示 ready 后立即请求 self-merge 审批。`integrationMode:"local"` 只保留给无 GitHub 的显式本地 fallback；不要在正常开发中混用。`after-verified-merge` 验证 PR 合并后自动删除 worktree，包括开发期 ignored/untracked 临时文件；批准 commit、artifact/review、PR 和 `cleanedWorktreePath` 保留。业务 store 仍是 `version: 2`，不等于包版本；旧 detached worktree 数据被拒绝，不迁移或重置。`init` 同时写入 docs/refactor/page/chore/tests/security 等 baseline discovery seeds；它们是发现方向，不是证据。

### 用户 intake

只有获得授权的用户/调用者应提交用户需求；示例不扫描全部聊天。主会话写需求后，**可选地**再调用一次 `driver seed` 补充 0–3 个相关证据 seed；不强制、不应为了凑数而复述需求：

```powershell
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data","requirement":{"id":"req-example","source":"user","title":"Concrete requested change","description":"Expected behavior and acceptance checks.","risk":"high","tags":["user"]}}'
node docs/examples/development/driver.mjs requirement
```

- ID 形如 `req-<slug>` / `seed-<slug>`；slug 为小写 ASCII 字母/数字开头，仅含字母、数字、`_`、`-`，最长 64 字符。拒绝路径穿越、扩展名/流字符和大小写碰撞风险。
- 用户 priority 强制为 `0`，即使风险 high 也跳过**需求审批**；实现 review 和 Human merge 门禁不跳过。
- 队列按用户优先、priority、原始 FIFO、稳定 ID 准入。小的 priority 更早；已领取工作不被抢占。
- 修改 queued 项时，在 `requirement` 对象中携带当前 `expectedRevision`，沿用同 ID、递增 revision 且保留 FIFO。已领取/执行项不能 intake 覆盖，应走反馈返修。

**主会话 intake 协议（建议，不是强制工具流程）：**

1. 用户提出需求时，先调用一次 `driver requirement`；
2. 可选地再调用 0–3 次 `driver seed`，把需求相关但尚未成为需求的证据/相邻观察写入 seed 池；
3. seed 必须引用证据位置，不能只是复述需求；没有可靠材料就不写；
4. 需要立即处理时再 enqueue 一次 `dispatch`，否则由 producer 下一轮领取。

### 已有证据 seed

```powershell
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data","seed":{"id":"seed-edge-case","title":"Evidence of an edge case","evidence":"A reproducible observation and relevant source/test locations.","tags":["reliability"]}}'
node docs/examples/development/driver.mjs seed
```

miner 只消费这些实际 seed，读取项目后提出一个具体需求，priority 为 `1..9`。`seed-edge-case` 对应稳定需求 `req-edge-case`；与无关已有需求冲突时失败而非覆盖。没有可行动建议时返回 `proposal:null`，该 seed 记为 idle，不反复调用模型或制造假需求。

**没有 GitHub Issue 自动抓取、外部发现 feed 或全聊天监听。** 后续 seed/用户需求仍由授权调用者显式提供。seed 可携带 `relatedRequirementId`，帮助 miner 避开对同一需求的重复提案。

## 3. 定义、运行并只启动一个 producer

在 DSH 会话中使用实际安装的 `auto_workflow_*` 工具。向 `auto_workflow_define` 传入完整 [示例图](<workflow.json>)；先向用户说明 driver 可执行本地 Git 副作用并取得批准，然后传入受限 permissions：

```json
{
  "command": {
    "mode": "allowlist",
    "allow": ["node docs/examples/development/driver.mjs"]
  },
  "http": { "mode": "deny", "allow": [] }
}
```

该授权信任整个 driver，不是只读授权，也不是文件系统沙箱。图不能给自己扩权；agent 工具策略须单独确认。

调用 `auto_workflow_start`：

```json
{
  "cwd": "C:/work/project",
  "input": { "dataRoot": "C:/work/project-workflow-data" }
}
```

再调用 `auto_workflow_run`。默认 `dispatch` 只领取最多三项已有需求，detached fan-out 到 `route`，属于有限入口。要持续运行，向同一 run **仅 enqueue 一个** producer：

```json
{
  "nodeId": "mine-gate",
  "input": { "dataRoot": "C:/work/project-workflow-data" }
}
```

上面的 JSON 是 `auto_workflow_enqueue` 参数。producer 第一次与后续每轮都经过 60 秒延迟：

```text
mine-gate → queue-check
             ├─ 待实现 ≤ 3 → seed-batch → seed-fanout(detached → miner)
             │                         → producer-dispatch → producer-work(detached → route)
             └─ 待实现 > 3 → producer-dispatch
                            → producer-work(detached → route)
             → mine-gate
```

`queue-check` 统计 queued、intake、需求审批、ready、preparing、engineering-ready 和 engineering；待实现超过工程师并发数 3 时暂停新挖掘，只处理已有队列。无 seed 时跳过模型，但仍检查需求队列。miner 晚于本轮 dispatch 完成，其新需求可在下一轮领取。Human 等待与慢 worker 不牵住 detached producer。**每次按 Run 不要重复 enqueue producer。**

新增用户需求后，如需立即准入，可 enqueue `nodeId:"dispatch"`、`input:{"dataRoot":"C:/work/project-workflow-data"}`；否则现有 producer 在后续周期领取。有限 dispatch 不会产生新的持续 producer。

## 4. 开发、review 与 Human merge 门禁

根 `concurrency:6` 被所有节点共享。一个 engineer 节点有三个槽，一个 reviewer 节点有三个槽；**每需求仅一位 reviewer**。命令/miner 也占根容量，不是六个模型槽之外另有无限开销。

1. `route` 让用户需求、挖掘 low 进入准备；挖掘 mid/high 进入 `requirement-human`。Human `reject` 必须有反馈，后续命令落盘后由 analyst 修订**同一个 ID**，递增需求 revision 再评估风险。
2. `prepare` 创建并保存 `auto/req-<id>` 分支、attached `worktreePath` 和 `baseRevision`。需求分支和 worktree 一直保留到 cleanup。所有初次开发与返修先经 `begin-engineering`：校验当前 revision/旧 epoch，消耗 admission 并增加 `engineeringEpoch`。
3. engineer 只在该 worktree/分支实现、运行项目实际验证并提交；不得 merge、push、删除 worktree 或编辑业务 JSON。
4. `snapshot` 使用冻结的 `begin-engineering` 输出校验 revision/epoch，预留 `snapshot-pending` 意图，把整个分支相对 `baseRevision` 压成一个 commit，再冻结 commit/tree/验证说明为不可变 artifact。不能在旧模型回复到达时临时读取新 revision 来绕过校验。
5. `publish-pr` 推送该需求分支，并创建/更新**自己的 draft PR**；PR head 始终是刚冻结的单 commit。外部 Codex/人可以提前在 PR 看 diff 和评论，但 draft 不能 merge。
6. 一位 reviewer 检查精确 artifact/commit 并验证，不改 worktree。`record-review` 复验干净 HEAD 并写入不可变 review。`revise` 先落盘，再回同 ID/分支/worktree/PR 的下一工程轮；有效返修不触发模型回退或通用业务返修上限。
7. `pass` 后 `brief` 生成结构化 Human/PR brief，并用同一内容更新 PR body。PR 模式随后直接进入 `ready-pr`，不需要内部 Human 先批准；本地 fallback 才经 `merge-human`。

PR 模式下外部可以直接 merge ready PR，不必等工作流 Human。只有在宽限期结束、外部仍未 merge 时，`check-pr` 才进入 `self-merge-human`，让 Human 决定是否由工作流自己 merge。反馈 output 示例：

```json
{ "note": "External review did not merge; approve workflow self-merge.", "actor": "human" }
```

| Human token | outcome | 后果 |
| --- | --- | --- |
| `self-merge-human` | `approve` | 批准精确 revision/artifact/commit；`self-merge-pr` 用 merge commit merge 自己的 PR。 |
| `self-merge-human` | `revise` | 反馈并回同 ID/分支/worktree/PR 返修。 |
| `self-merge-human` | `reject` | 保留分支/worktree/PR，不 merge、不隐式重试。 |
| `merge-human`（local） | `approve` | 批准后走本地 `integrate` fallback。 |

Human 引擎决定由后续 command 转成业务记录；旧需求 revision 的回应不能批准新规格。不要把有效拒绝当成换模型的理由。

## 5. PR 发布、外部 merge 与本地 fallback

`publish-pr`/`ready-pr`/`check-pr`/`self-merge-pr` 串行使用 store 级 integration lock。PR 发布前必须有当前 artifact 的通过 review；ready 在 brief 后直接执行，不需要内部 Human 先批准；check 只轮询工作流自己记录的 `prNumber`，不会搜索其他 PR。

### 正常 PR 路径

1. 第一次 snapshot 后 push `auto/req-<id>`，创建 draft PR，base 为配置的 `baseBranch`；
2. review/rework 继续更新同一分支/PR，并 force-push 新的单 commit；
3. review pass + `brief` 后，`ready-pr` 调 GitHub 把 PR 标记 ready，并记录 `readyAt`；
4. Codex/你可以在宽限期 `selfMergeAfterMs` 内直接 merge，不需要工作流内部批准；
5. `check-pr` 每 30 秒查询该 PR；看到外部 merge 就验证/清理；
6. 如果宽限期结束 PR 仍 open，进入 `self-merge-human`；Human `approve` 后 `self-merge-pr` 调用 `gh pr merge --merge`，记录 `selfMergedByWorkflow`；
7. 外部 merge 或 self-merge 后，`check-pr`/`self-merge-pr` fetch `origin/baseBranch`、fast-forward 本地 base、验证 review commit 是祖先，记录 `merged` 并进入 cleanup；
8. PR 被关闭未合并时回到同一需求工程返修，不自动本地 merge。

`selfMergeAfterMs` 默认 5 分钟，`0` 表示 ready 后立即请求 self-merge 审批。无论外部还是自己 merge，都必须使用 **merge commit**；squash/rebase 会改变 commit 的 SHA，工作流会明确报错，而不是悄悄放宽绑定。

### 本地 fallback

初始化时显式选择：

```json
{ "integrationMode": "local" }
```

本地 fallback 跳过 PR 发布，Human 批准后走原有 `integrate`（含冲突自动 abort 和返修）。它只用于没有 GitHub remote/token 的隔离验收；正常开发不要和 PR 模式混用。

PR 被外部 close 或 merge 失败不会被自动重放。先检查 PR/分支/worktree 和业务状态，再显式续接。

**工作流会 push 自己的需求分支并创建/更新 PR；外部可以直接 merge ready PR，只有当它超过宽限期仍未 merge 时，才需要 Human 批准工作流自己用 token merge 这个 PR。** 工作流不会替其他 PR 背书、不会绕过 branch protection、不会部署；仓库保护分支、CI 和 merge 规则继续适用。

## 6. 保留与清理

默认 `after-verified-merge`：验证合并后自动删除 worktree，包括开发期 ignored/untracked 临时文件。删除前仍核对批准 commit 在祖先链、worktree HEAD 未变，然后用受控的 `git worktree remove --force` 删除，再删除本地 `auto/req-*` 分支；提交、不可变 artifact/review、PR 引用和 `cleanedWorktreePath`/`cleanedBranch` 记录保留。

如果项目确实需要保留现场，可以在初始化时显式选择 `retain`；这是例外，不是默认。批量或逐项清理仍可用原 claimed item 的引用与 `claimId` 显式请求：

```powershell
$env:DSH_WORKFLOW_INPUT = '{"dataRef":"C:/work/project-workflow-data/requirements/req-example.json","claimId":"<original claimId>","cleanup":true}'
node docs/examples/development/driver.mjs cleanup
```

未合并、拒绝、冲突、等待或未验证的 worktree 不清理；保留分支/PR 供继续返修。需求 JSON、不可变产物/review 和清理记录保留。

## 恢复与排障

### 查看与控制

- `auto_workflow_status` / 看板显示引擎状态；`driver status` 的输入是 `{dataRoot}`，`driver inspect` 的输入是 item envelope，分别返回业务计数与引用。
- `auto_workflow_control` 使用 `nodeId` + `enabled` 控制单个队列。禁用 `mine-gate` 停后续周期；如需阻止未启动的挖掘，还应禁用 `miner`。禁用 engineer/reviewer 不影响其他节点，已运行工作继续排空。
- `continuous:false` 全局停新准入并排空在途工作；`stop:true` 是显式中断。任何控制都不自动 cleanup。
- Host 停止/重载、中断或失败不会自动重放；先检查仓库和业务存储，再决定显式续接或新 run。状态引用落盘不承诺跨文件/Git 的掉电事务，详见 [生命周期](<../../run-lifecycle.md>)。

### Typed busy 只重试尚未开始的操作

目录锁不会被自动夺取。只有 10 秒未拿到锁且受保护动作尚未开始，才抛 `BusinessBusy`；driver 返回 `busy` 与原解析输入，图经一秒 `busy-<node>` gate 回到该命令，不重跑前一模型、不重新 claim、不重放不确定副作用。其他错误仍为 `fail`，无自动重试边。

死去的所有者可能留下锁，导致 busy 循环。恢复前核查 owner metadata、所有活跃 job 与 Git 状态，不要夺取活锁。关闭命令节点也会暂停其 busy 重试。

### 显式 snapshot reconciliation

snapshot 发布中断可留下 `status:snapshot-pending` 与精确 `pendingSnapshot`。普通 snapshot 重放会被拒绝。授权操作者应检查意图、artifact 和当前 worktree，再对原 claimed item 调用 `reconcile-snapshot`，额外提供：

```json
{
  "decision": "finalize",
  "expectedRevision": 1,
  "engineeringEpoch": 1,
  "note": "Checked the reserved artifact and matching clean HEAD/tree."
}
```

示意数字必须替换为**保留意图对应的真实值**，不能把旧回复改成新轮参数。该命令重新校验干净的需求分支 HEAD/tree、revision、epoch；已存在 artifact 必须逐项匹配且不覆盖，没有发布的只能完成那份保留 artifact。成功写入对账记录并进入 reviewing，**不会**授予 review/merge 批准。

检查失败 packet 后，用命令返回的 artifact envelope 显式 enqueue 到 `review-input`，不要重跑 engineer/snapshot。这个 reconciliation 是单独 CLI 操作，不是自动图边。

其他边界（`preparing`/`integrating` 的 Git 副作用、review 文件先于需求更新、worktree 已移除但清理结果未写回）仍须保留证据并人工对账。没有通用 reset/replay、自动夺锁或迁移命令。

## CLI 协议与阶段速查

每阶段读取 `DSH_WORKFLOW_INPUT` JSON，stdout 只输出一个对象，不混入日志/Git 输出：

```json
{ "outcome": "complete", "output": { "dataRef": "<absolute business JSON path>", "cwd": "<absolute execution directory>", "label": "Short label" } }
```

item envelope 至少携带业务 `dataRef` / `claimId`，按阶段携带冻结的 `revision` / `engineeringEpoch` / artifact 引用；这些不是引擎 artifact ID。driver 失败输出 `outcome:fail` 和有界错误并非零退出；command 节点设置 `json:true`，不能把任意 stdout 文本当批准。

| Stage | 额外输入 / 主要行为 |
| --- | --- |
| `init` | `dataRoot`、`repoRoot`，可选 `baseBranch`、`cleanupPolicy`（默认 `after-verified-merge`）、`integrationMode`（默认 `pull-request`，或 `local` fallback）、`prRemote`（默认 `origin`）、`selfMergeAfterMs`（默认 5 分钟）；初始化固定配置并写入 baseline discovery seeds。 |
| `pr-init` | 创建 workflow 前的 PR 契约检查；输入 `repoRoot`、`baseBranch`，`apply:true` 只创建 label 和缺失的 PR template，不改 branch protection/merge method。 |
| `requirement` / `seed` | `dataRoot` 与 `requirement` / `seed` 对象；显式 intake。seed 可带 `origin`、`category`、`relatedRequirementId`；可选，不强制。 |
| `claim` / `seed-batch` | `dataRoot`、可选 `batchSize` 1..100（图为 3）；返回 ready items 或 idle。 |
| `queue-check` | `dataRoot`、`maxPending`；返回 `mine` 或 `skip`，统计待实现（含 engineering）需求。 |
| `record-proposal` | seed envelope、`proposal` 或 `null`；稳定 ID 需求或 idle seed。 |
| `route` | claimed item；ready 或 needs_approval。 |
| `requirement-decision` | 冻结 `expectedRevision`、`decision`，reject 必须 note；revision 绑定决定。 |
| `revise-proposal` | `proposal` 含 `expectedRevision`、title、description、risk；同 ID revision+1。 |
| `prepare` / `begin-engineering` | 创建 `auto/req-*` 分支和 attached worktree；校验 envelope `revision` / 旧 `engineeringEpoch` 后进入新轮。 |
| `snapshot` | 冻结 `expectedRevision`、`engineeringEpoch`；非空字符串 `summary`、`verification`；把分支压成单 commit，写不可变 artifact/commit。 |
| `reconcile-snapshot` | `decision:finalize`、冻结 revision/epoch、operator note；仅完成已检查意图。 |
| `publish-pr` | 推送需求分支并创建/更新自己的 draft PR；local fallback 返回 `skipped`。 |
| `review-input` | 当前 `artifactRef` / `commit`；生成冻结 review 输入，也是对账后的续接入口。 |
| `record-review` | 精确 artifact/commit、`decision:pass\|revise`，非空字符串 summary/verification/reviewer。 |
| `brief` | pass 后生成 Human/PR 共用的结构化 brief，并更新 PR body。 |
| `merge-decision` | 当前 artifact、decision，返修/拒绝需反馈；精确产物批准。 |
| `integration-route` | 读取 store 配置，返回 `pr` 或 `local`。 |
| `ready-pr` / `check-pr` | review pass + brief 后标记自己的 PR ready；轮询同一 `prNumber`，外部 merge 或超时返回 `approval-needed`。 |
| `self-merge-human` / `self-merge-pr` | 外部未 merge 时的 Human 自合并门禁；批准后用自己的 token 以 merge commit 合并并验证。 |
| `integrate` | 仅 local fallback：本地 merged / 冲突自动 abort 后 revise。 |
| `recover-integration` | 仅异常兜底：操作者已手工恢复 Git 后，`decision:resolved\|aborted`、note；不在主图。 |
| `cleanup` | 默认 `after-verified-merge` 自动强删已合并 worktree，并删除本地需求分支；`retain` 是显式例外。 |
| `status` / `inspect` | `{dataRoot}` / item envelope；有界业务状态与引用。 |

## 验证与限制

[公开验证说明](<../../verification.md>) 区分回归和真实模型执行。在源码 checkout 中运行包含示例与安全回归的完整测试：

```bash
npm test
```

[示例测试](https://github.com/lyingloong/dsh-auto-workflow/blob/main/tests/development-example.test.mjs) 与 [安全回归](https://github.com/lyingloong/dsh-auto-workflow/blob/main/tests/audit-example.test.mjs) 使用可丢弃的真实本地 Git 仓库/worktree、本地 bare remote 和 test-only fake `gh`，覆盖准入、revision/epoch、3+3 并发、分支/单 commit、draft PR、brief、external merge、PR close、busy、backlog 水位、snapshot reconciliation 和默认清理；自动回归不调用付费模型或真实 GitHub。实际运行仍需要有效模型工具、`gh` 授权、真实输入及项目专属验证。

这不是多 Host 数据库、身份认证服务或恶意文件系统沙箱。操作者负责可信调用者、数据备份、保留期限、项目适配以及经明确授权的远端发布；不要把“持续运行”解释为自动恢复一切或无需人工决策。
