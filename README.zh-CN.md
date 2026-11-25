# dsh-auto-workflow

**DeepSeek Harness 的持久化、并发节点图工作流插件。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/lyingloong/dsh-auto-workflow/actions/workflows/test.yml/badge.svg)](https://github.com/lyingloong/dsh-auto-workflow/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

工作流是一张节点与边组成的图。一个 run 常驻挂载，packet 在其中流动：模型调用、shell 命令、HTTP 请求和人工决策共享同一条长期运行的流水线。某个 packet 等待 Human 时，其他 packet 继续执行；新任务可以随时进入。

**“Auto”指已授权流程的持续调度，不是免审批。** Host 运行期间，空闲或 Human 等待不会结束 run，状态与数据引用会落盘。Host 停止、插件重载或执行中断后，不确定的工作不会被自动重放，也不承诺跨 Git/HTTP 的 exactly-once 事务。

项目页：<https://lyingloong.github.io/dsh-auto-workflow/>

## 特性

- **持久 run、并发 packet。** 启动一次，之后继续 enqueue；Human 等待、慢模型或失败 packet 都不会拆掉整个 run。
- **覆盖真实自动化的节点类型。** `agent`、`command`、`http`、`human`、`fanout`、`join`、`gate`、`subworkflow` 分别对应模型、脚本、远程 API、审批和调度边界。
- **显式控制面。** 有序模型回退、节点并发、可选截止时间、暂停/继续、队列开关、`recover:true` 和 Stop 都是引擎能力，不靠提示词约定。
- **引用而非内联大对象。** 大输入/输出以引用存放，checkpoint 保持有界。
- **实时看板。** 从私有 loopback UI 查看节点容量、队列、Human 待办、运行历史和产物。
- **完整主示例。** GitHub clone 本地持续开发：每需求分支/worktree/PR、GitHub issue 需求审批，以及 GitHub 原生的 PR 合并决定。

## 环境要求

- Node.js **22.5+**
- DeepSeek Harness **0.2.2-rc.2+**（本机在 0.2.2-rc.5 验证）
- 开发示例还需要 Git、`gh` 认证，以及可供子 agent 使用的模型路由

## 安装

推荐固定 release，避免跟随开发分支：

```bash
dsh plugin --profile desktop add github:lyingloong/dsh-auto-workflow#v1.2.0
```

也可以安装 release `.tgz` 或本地 checkout：

```bash
dsh plugin --profile desktop add /absolute/path/dsh-auto-workflow-1.2.0.tgz
dsh plugin --profile desktop add /absolute/path/dsh-auto-workflow
```

安装后重启 DSH Host，再刷新 Web GUI。安装插件**不会**把示例脚本复制进业务仓库，也**不会**自动启动工作流。

## 快速开始：持续开发一个本地 GitHub clone

唯一主示例是 [GitHub 项目持续开发](docs/examples/development/README.md)。它维护每需求分支、worktree 和 PR，并把需求审批与 PR 合并决定都放到 GitHub 上。

1. **准备仓库。** 克隆你有权修改的 GitHub 仓库，配置 `origin` 和 `gh auth login`（或 `GITHUB_TOKEN`）；把示例脚本 materialize 到仓库内并本地提交，选择项目外的 canonical `dataRoot`。
2. **提交真实需求。** 初始化业务存储（会写入 baseline discovery seeds），再提交用户需求。用户需求优先级固定为 `0`；示例不监听所有聊天，也不自动导入 GitHub Issues。
3. **授权并定义。** 检查[示例图](docs/examples/development/workflow.json)与模型提示词，明确批准命令 allowlist，再调用 `auto_workflow_define`。HTTP 默认拒绝；agent 工具权限另行控制。
4. **开始运行。** `auto_workflow_start` 绑定仓库绝对 `cwd` 和 `{ "dataRoot": "…" }`，`auto_workflow_run` 挂载 run。在同一个 run 中向 `mine-gate` **只 enqueue 一次** producer；后续需求继续送入现有 run。
5. **审核与合并。** 每个需求在 `auto/req-<id>` 分支和独立 worktree 中开发；第一次 snapshot 后推送分支并创建 draft PR。review pass + decision-first brief 后 PR 标记 ready；`pr-watch` 读取协作者的 `[verdict=pass]` 评论或正式 review、未 resolve thread 和 CI，`pr-merge` 在 `mergePolicy` 满足后用 merge commit 合并（默认要求 `@workflow merge` 评论，也支持 `auto` / `label`）。阻塞反馈回到同一分支返修；外部提前 merge 同样会被验证并清理。

### 主业务图

```mermaid
flowchart TD
  U[用户 intake · priority 0] --> Q[稳定 ID 的需求队列]
  U -->|宽泛请求| IP[intake planner · low effort]
  IP --> Q
  S[已有证据 seeds] --> M[周期 producer / 挖掘]
  M --> Q
  Q --> R{需求来源与风险}
  R -->|用户 / 挖掘 low| W[每需求一个 auto/req-* 分支和 attached worktree]
  R -->|挖掘 mid / high| H[GitHub issue 需求审批]
  H -->|approve| W
  H -->|reject + 反馈| A[同 ID 修订需求]
  A --> R
  W --> E[engineer 池 · 最多 3]
  E --> I[冻结 revision / epoch / one commit]
  I --> P[push 分支并创建 draft PR]
  P --> V[reviewer 池 · 最多 3，每需求一位]
  V -->|revise| E
  V -->|pass| B[decision-first brief]
  B --> L[标记自己的 PR ready]
  L --> W2[pr-watch · 授权 verdict/review + thread + CI]
  W2 -->|revise| E
  W2 -->|pass| M2[pr-merge · mergePolicy 满足]
  M2 --> T[merge commit + 验证 · 默认清理 worktree]
  L -->|外部提前 merge| T
```

根并发上限为 **6**；命令和挖掘也共享这六个槽位。3+3 是两个工作池上限，不是每项需求三位 reviewer。返修保留同一需求 ID、分支、worktree 和 PR；snapshot 把分支压成一个 commit。完整语义见[业务流程与保证](docs/workflow-summary.md)。

## 七个工具

| Tool | 用途 |
| --- | --- |
| `auto_workflow_define` | 校验并保存节点图和用户批准的权限。 |
| `auto_workflow_start` | 绑定不可变 `cwd`、预检并创建 run；不执行节点。 |
| `auto_workflow_run` | 挂载或继续当前会话的常驻 job，立即返回。 |
| `auto_workflow_enqueue` | 向现有 run 添加独立 packet；新工作不靠重启 run 输入。 |
| `auto_workflow_decide` | 解决一个指定 Human token，不影响其他审批。 |
| `auto_workflow_control` | 暂停/继续、单节点队列开关、`recover:true` 唤醒卡住的 live run，或显式 Stop。 |
| `auto_workflow_status` | 只读查看队列、并发、Human 待办和私有看板 URL。 |

节点类型为 `agent`、`command`、`http`、`human`、`fanout`、`join`、`gate`、`subworkflow`。字段与协议见[插件参考](docs/plugin-summary.md)。不要轮询 `auto_workflow_run`。

## 权限

命令和 HTTP 默认 **deny**。定义含特权节点的图之前，先决定 full 还是 allowlist，并传给 `auto_workflow_define`：

```json
{ "command": { "mode": "allowlist", "allow": ["node", "pnpm"] }, "http": { "mode": "allowlist", "allow": ["api.github.com"] } }
```

运行时强制执行授权，图不能静默放宽。命令 allowlist 不是文件系统沙箱，也不替代 Host 的 agent 工具权限。

## 看板

- **Human 待处理详情**：查看等待 token 的输入 JSON，并在同一处记录 outcome。
- **节点图模式**：“简化”隐藏 `busy-*` 重试门；“极简”只保留 agent 与关键 gate 节点并压缩隐藏路径；“完整”显示全部边。
- **节点方块**：空闲/运行/等待/错误/关闭使用不同颜色；点击查看数据包和历史。

## 设计边界

- 插件负责通用调度和引用；需求优先级、Git worktree、审查与合并策略属于示例业务代码。
- 暂停或禁用节点不会取消在途工作；Stop 不等于回滚。恢复或新建 run 前先检查副作用。
- 失败/中断尝试保留为证据，失败 token 会从 live 调度状态归档。`recover:true` 只清理陈旧 pause/error，不重放工作。
- 单 Host、本地文件锁；不是分布式队列、外部审批服务或 exactly-once Git/HTTP 事务。示例会在 `mergePolicy` 下推送自己的需求分支并合并自己的 PR，但不会改写他人 PR，也不会部署。

## 开发

```bash
git clone https://github.com/lyingloong/dsh-auto-workflow.git
cd dsh-auto-workflow
npm test            # 全量回归
npm run verify:release
```

仓库约定见 [AGENTS.md](https://github.com/lyingloong/dsh-auto-workflow/blob/main/AGENTS.md)。欢迎 issue 和 pull request；请附最小复现，并保持测试确定性、离线。

## 版本边界

包版本 `1.2.0`、图 `apiVersion: 2`、run 状态 `version: 3`、示例业务存储 `version: 4` 是不同层的契约。示例的 v3 store 必须用 `driver migrate` 显式升级，绝不原地迁移。发布历史见 [CHANGELOG.md](CHANGELOG.md)。

## 文档

- [文档导航](docs/README.md)
- [运行生命周期与排障](docs/run-lifecycle.md)
- [业务流程与保证](docs/workflow-summary.md)
- [开发示例](docs/examples/development/README.md)
- [v1.2.0 发布说明](docs/releases/v1.2.0.md) · [v1.0.0](docs/releases/v1.0.0.md)

## 许可证

[MIT](LICENSE)
