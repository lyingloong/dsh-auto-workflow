# PR 交流规范

这是 `dsh-auto-workflow` **开发示例**的仓库侧 PR 契约，不是插件核心功能。会话在基于本示例创建 workflow 前，应先完成 [PR 初始化](#pr-初始化)。

## 1. 身份

优先为 Codex、captain、verifier、reviewer 使用独立 GitHub App / bot 账号。做不到时使用方案 C：

- 一个 workflow GitHub 身份；
- 机器评论必须带角色头：

```text
[role=reviewer] [task=dev-0038] [head=ff446ec3]
```

- `role` 只接受 `captain`、`engineer`、`verifier`、`reviewer`、`codex`、`workflow`；
- `head` 是该评论针对的 commit，至少 12 位；
- 没有角色头、task 或 head 的机器评论不参与合并判断；
- 人类普通评论不承担状态，讨论放 inline thread。

## 2. 单一状态源

PR body 顶部只维护一个状态块：

```md
<!-- workflow
task=dev-0038
head=ff446ec3
base=eea1a85b
stage=merge-ready
next=codex-merge
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

评论不是状态。head 变化时，状态立即失效，回到 `reviewing` 并移除 merge-ready 标签。

## 3. 顶层评论

顶层评论只允许四类，且必须带角色头：

- `[verify]`：head、CI run、验证结论和证据；
- `[review]`：verdict、finding id、残余风险；
- `[repair]`：修复了哪些 finding、新 head；
- `[merge-gate]`：Codex / 用户的合并决定。

其他讨论放 inline thread。顶层评论不写过程流水账。

## 4. Finding 生命周期

- finding 使用稳定编号 `F1/F2/...`；
- inline thread 记录问题和修复；
- `[repair]` 必须写明“F1 已修，head=xxx”；
- 验证/审查复核后 resolve thread；
- **未 resolve 的 thread 不能合并**；
- push 新 head 后，旧 head 的 finding 标记 `superseded`，不留在待办。

## 5. 合并门

只有同时满足才算 merge-ready：

- 状态块 `stage=merge-ready`；
- head 与状态块一致；
- CI 全绿；没有 CI 时记录 `ci=none`；
- 无 unresolved thread；
- `order` 已记录；
- workflow 已添加 `workflow:merge-ready` 标签。

Codex 只认 `workflow:merge-ready` 标签。head 变化、CI 失败或 thread 未关闭时，workflow 必须移除该标签。

## 6. 自动化职责

workflow 统一负责：

- 生成/更新状态块；
- 校验角色头、task、head；
- head 变化时撤销 merge-ready 和标签；
- 检测 unresolved review thread；
- 检查 CI；
- 分配合并顺序；
- 合并后清理状态和标签。

仓库侧只读状态和标签，不维护另一套规则。

## 7. 一句话原则

**评论负责讨论，状态块负责决策；head 变了结论就失效，未 resolve 的 thread 不算关闭。**

## 需求审批 issue

mid/high 风险的挖掘需求在**业务仓库的 issue**上审批，每个需求复用一个 issue：

- issue body 以 `<!-- workflow-requirement` 状态块开头，携带 `requirement`、`revision`、`risk`。
- 标签：`workflow:requirement-review`（待审）、`workflow:requirement-approved`、`workflow:requirement-rejected`。
- 决定写在评论里：`@workflow approve` 或 `@workflow reject <理由>`。只有 OWNER / MEMBER / COLLABORATOR 的评论生效；拒绝必须带理由，否则工作流回评论要求补充。
- 决定按 revision 绑定：发布前已有的评论不计入，返修后工作流更新同一 issue 并重新打开；旧 revision 的评论不能批准新内容。
- **发布前确定性脱敏**：绝对路径、用户主目录、邮箱、长令牌和私有地址替换为占位符；审批对象是脱敏后的公开版，执行以本地记录为准。
- 发布后立即首查，之后每 30 分钟复查一次。

## PR 初始化

在创建/启动 workflow 前，先检查仓库：

```bash
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data"}'
node docs/examples/development/driver.mjs pr-init
```

只读检查：GitHub 认证、merge commit、branch protection、`workflow:merge-ready` 标签、PR template、required checks，以及三个需求审批标签。

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

此时 branch protection、conversation resolution 和 required checks 只是警告，不再阻止启动；`gh` 认证、仓库访问、允许 merge commit、`workflow:merge-ready` 标签和带状态块的 PR template 仍是硬性要求。merge commit 不能降级：工作流靠它把审查过的 commit 绑定进集成分支，squash/rebase-only 仓库无法满足。
