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

## PR 初始化

在创建/启动 workflow 前，先检查仓库：

```bash
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data"}'
node docs/examples/development/driver.mjs pr-init
```

只读检查：GitHub 认证、merge commit、branch protection、`workflow:merge-ready` 标签、PR template、required checks。

初始化标签和 PR template：

```bash
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data","apply":true}'
node docs/examples/development/driver.mjs pr-init
```

默认只创建标签和缺失的 PR template；**不自动修改 branch protection 或仓库 merge method**。这两项会影响所有贡献者，必须由仓库管理员单独确认后手动配置。
