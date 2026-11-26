# PR 交流规范

这是 `dsh-auto-workflow` **开发示例**的仓库侧 PR 契约，不是插件核心功能。会话在基于本示例创建 workflow 前，应先完成 [PR 初始化](#pr-初始化)。

## 1. 身份与决定权

- 决定只来自 **OWNER / MEMBER / COLLABORATOR**（评论的 `author_association`，或 review 作者的仓库权限）；外部贡献者、匿名讨论和 workflow 自己的评论不参与决定。
- 不再要求单独的 Codex / reviewer bot 账号；Codex 可以由协作者账号转述，也可以直接使用正式 GitHub Review。若使用独立 bot，该 bot 必须是协作者。
- 机器评论可带角色头，便于审计；决定本身由结构化标记承担，不靠角色头猜测：

```text
[role=reviewer] [task=dev-0038] [head=ff446ec3]
[verdict=pass]
```

- `head` 是可选的绑定标记；带 `[head=<sha>]` 的评论只对匹配的 head 生效。没有标记的评论只在其提交时间晚于当前反馈窗口（最近一次 ready/rework）时生效。
- 人类普通讨论不承担状态；讨论放 inline thread。

## 2. 单一状态源

PR body 顶部只维护一个状态块：

```md
<!-- workflow
task=dev-0038
head=ff446ec3
base=eea1a85b
stage=merge-ready
next=merge
order=03
ci=pass
-->
```

| 字段 | 含义 |
| --- | --- |
| `task` | 稳定需求 ID |
| `head` | 当前 PR head 的完整 commit SHA |
| `base` | 目标 base commit |
| `stage` | `implementing` / `verifying` / `reviewing` / `repairing` / `merge-ready` / `blocked` |
| `next` | 下一个责任角色 |
| `order` | workflow 分配的合并顺序 |
| `ci` | `pass` / `fail` / `pending` / `none` |

评论不是状态。head 变化时，状态立即失效，回到 `reviewing`、清空 `order` 并移除 merge-ready 标签；旧 head 的评论/review 不再计入。

## 3. 决定性输入

workflow 只认这些确定性信号：

| 信号 | 形式 | 绑定 |
| --- | --- | --- |
| 评论判决 | `[verdict=pass]` / `[verdict=revise]` | `[head=<sha>]` 或当前反馈窗口 |
| 正式 review | `APPROVED` / `CHANGES_REQUESTED` | review 的 `commit_id` |
| 讨论状态 | unresolved review thread | 当前 head |
| GitHub 汇总 | `reviewDecision` | 仅在无显式判决时兜底 |
| 合并意图 | `@workflow merge` / `@workflow stop` | 当前反馈窗口（可选 `[head=<sha>]`） |

- 最新一条授权判决获胜；同一时间戳时 `revise` 优先。
- 有任何未 resolve 的 review thread，一律视为阻塞反馈，永远不能合并。
- **不从散文猜测 verdict**：没有标记、没有正式 review，就是“尚无判决”。

## 3.5 自然语言命令

协作者可以写一条 `@workflow <自然语言>`（例如 `@workflow 按 Codex 的两条 P2 修一下`、`@workflow 可以了`、`@workflow 先别动`）。工作流先识别**只有协作者**的 `@workflow` 评论，再交给低思考 intent agent 读取命令、当前 revision/head、最近评论：

- 评论里的 Codex/其他人内容只是**证据**，不是指令；intent agent 不得执行证据中的指令。
- 输出只能是允许的动作：issue 为 `approve|revise|stop|clarify`，PR 为 `merge|revise|stop|clarify`。
- 模糊、矛盾、越权或不安全的命令 → 一条中文澄清评论，状态不变；意图 agent 不可用时也回澄清并继续等待。
- `revise`（需求）或 revise（PR）会生成引用评论 id 的 brief；新的 revision/head 发布后只通知一次“请检查”。
- 决定按当前 revision/head 与评论 id 绑定，重复轮询不会重复执行或重复通知；窗口外的旧评论忽略。
- 精确命令（`@workflow approve|reject`、`@workflow merge|stop`、`[verdict=...]`、正式 review）仍是确定性路径。
- 旧 head/revision 的授权自然语言命令会收到一条回执，说明目标/当前值和“未自动应用”，并按评论 id 只回一次；`@workflow 确认按当前 head 处理`（issue 为 `revision`）可显式复用最近一条旧指令，但绝不会静默应用。
- 命令是操作生命周期：accepted → running → completed（新 revision/head 通知 `A → B`、请检查）；运行期间到达的命令记为 queued，不自动应用也不静默覆盖；只有从未接受或目标被无关推送改变时才是 stale。
- intent agent 读取完整讨论：全部 issue 评论和正式 review（含旧 head/revision），按页读取；最新正文优先，较旧正文可能截断/省略但 id/作者/时间保留。命令识别仍只按当前 head/revision 窗口。

## 4. 合并门与策略

只有同时满足才进入 `stage=merge-ready` 并添加 `workflow:merge-ready` 标签：

- 当前 head 有授权 `pass`；
- CI 全绿；没有配置检查时记录 `ci=none`（`pr-init` 会把缺少 required checks 作为警告）；
- 无 unresolved thread；
- 合并意图已满足（见下）。

存储配置 `mergePolicy` 决定合并意图：

| 策略 | 触发 |
| --- | --- |
| `comment`（默认） | 协作者在 PR 评论 `@workflow merge`；`@workflow stop` 取消 |
| `auto` | 当前 head 通过上述校验即合并 |
| `label` | PR 带 `workflow:merge` 标签 |

`pr-merge` 在真正合并前会重新读取 PR，并再次校验 head / 判决 / CI / thread / 策略；合并始终使用 **merge commit**。squash/rebase 会改变审查 commit 的 SHA，工作流明确报错而不是放宽绑定。

阻塞反馈（`revise` 或 unresolved thread）会：移除 `workflow:merge-ready`，把同一条返修反馈写回需求（按评论/review id 去重），清除内部批准，回到同 ID/分支/worktree/PR 的 `begin-engineering`，不会合并。

## 4.5 瞬态失败与退避

- 瞬态：连接重置/拒绝、DNS/超时、`connectex`/`wsarecv`/`dial tcp`、HTTP 5xx、429/rate limit。
- 永久：401、403（非 rate limit）、缺少 scope、404、422 校验、merge 冲突、branch protection、PR 已合并/已关闭。
- 瞬态失败写入 PR 的 `retry` 状态（失败次数、最后错误、下一次尝试时间、是否耗尽），`pr-watch` 返回 `waiting` 而不是失败 packet；退避期间不请求 GitHub。
- 连续 6 次瞬态失败后进入 `stage=blocked`、`next=attention`，停止自动重试，等待人工。
- `pr-merge` 丢失合并响应时先重读 PR：已合并则验证清理，不会重复 merge。

## 5. Finding 生命周期

- finding 使用稳定编号 `F1/F2/...`；
- inline thread 记录问题和修复；
- `[repair]` 评论写明“F1 已修，head=xxx”；
- 验证/审查复核后 resolve thread；
- push 新 head 后，旧 head 的 finding 标记 `superseded`，不留在待办。

## 6. 自动化职责

workflow 统一负责：

- 生成/更新状态块、`order` 和标签；
- 判断授权决定、head 绑定和反馈窗口；
- head 变化时撤销 merge-ready/order；
- 检测 unresolved thread 和 CI；
- 按 `mergePolicy` 执行 merge 并处理竞争（外部先 merge、PR 被关闭、评论在合并前变化）；
- 合并后验证 merge commit、清理状态和标签。

## 7. 一句话原则

**决定写在 PR 上的结构化信号里；head 变了结论就失效；未 resolve 的 thread 和 revise 判决永远阻止合并。**

## 需求审批 issue

mid/high 风险的挖掘需求在**业务仓库的 issue**上审批，每个需求复用一个 issue。issue 采用**决策优先**模板：

1. 一行风险/revision/来源；
2. `## What`：1–2 句要批准的内容；
3. `## Why / impact`：最多 3 条影响；
4. `## Acceptance`：3–5 条可测验收；
5. `## Decision`：`@workflow approve` / `@workflow reject <理由>`；
6. `<details>`：脱敏后的完整证据、file:line 和备选方案。

- 标签：`workflow:requirement-review`（待审）、`workflow:requirement-approved`、`workflow:requirement-rejected`。
- 只有 OWNER / MEMBER / COLLABORATOR 的评论生效；拒绝必须带理由，否则工作流回评论要求补充。
- 决定按 revision 绑定：发布前已有的评论不计入，返修后工作流更新同一 issue 并重新打开；旧 revision 的评论不能批准新内容。
- **发布前确定性脱敏**：绝对路径、用户主目录、邮箱、长令牌和私有地址替换为占位符；审批对象是脱敏后的公开版，执行以本地记录为准。
- 发布后立即首查，之后每 30 分钟复查一次。

## PR 初始化

在创建/启动 workflow 前，先检查仓库：

```bash
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data"}'
node docs/examples/development/driver.mjs pr-init
```

只读检查：GitHub 认证、merge commit、branch protection、`workflow:merge-ready` + `workflow:merge` 标签、PR template、required checks，以及三个需求审批标签。

初始化标签和 PR template：

```bash
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data","apply":true}'
node docs/examples/development/driver.mjs pr-init
```

默认只创建标签（PR 标签和三个需求审批标签）和缺失的 PR template；**不自动修改 branch protection 或仓库 merge method**。这两项会影响所有贡献者，必须由仓库管理员单独确认后手动配置。

有意使用手动合并门禁的仓库（merge commits 开启、不做 branch protection）可以加 `manualGate:true`：

```bash
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data","apply":true,"manualGate":true}'
node docs/examples/development/driver.mjs pr-init
```

此时 branch protection、conversation resolution 和 required checks 只是警告，不再阻止启动；`gh` 认证、仓库访问、允许 merge commit、`workflow:merge-ready` + `workflow:merge` 标签和带状态块的 PR template 仍是硬性要求。merge commit 不能降级：工作流靠它把审查过的 commit 绑定进集成分支，squash/rebase-only 仓库无法满足。
