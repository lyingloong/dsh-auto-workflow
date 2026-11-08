# 验证范围与已知边界

这份公开说明保留可核查的测试方法和结果，不发布维护者的本机目录、访问 token、会话 ID 或临时工作目录截图。完整原始验收材料留在维护者本地；公开回归测试在仓库中。

## 本地回归与发行校验

在源码 checkout 中执行：

```bash
npm test
npm run test:runner
npm run verify:release
npm pack --dry-run --json --ignore-scripts
```

- Windows / Node.js 24.12.0 的最后一轮功能回归为 **128 项通过、0 失败、0 跳过**，包含核心、执行器、宿主集成、Web API、看板、分支/PR 示例及独立审计回归。
- `test:runner` 与默认入口使用同一组测试；`test:watch` 使用明确文件入口，不把测试目录当作模块运行。
- `verify:release` 检查包名、版本、exports、必要文件、包内 Markdown 链接、私有信息泄露以及唯一示例的 3+3/root6 配置。它只读文件，不执行模型或业务命令。
- CI 保留仓库原有 Ubuntu / Windows × Node.js 24.x 矩阵。**矩阵配置不是通过声明**：具体提交的完成状态以 [GitHub Actions](https://github.com/lyingloong/dsh-auto-workflow/actions/workflows/test.yml) 为准。Node.js 22.5 是声明的最低版本，本次未单独实跑该下限；也未对 macOS 作完整运行验收。
- 所有测试使用一次性临时目录；Git 测试有独立本地身份，不修改用户仓库，不发布或推送。

测试源码：[默认入口](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.0/tests/run.mjs)、[核心审计](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.0/tests/audit-core.test.mjs)、[集成审计](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.0/tests/audit-integration.test.mjs)、[示例审计](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.0/tests/audit-example.test.mjs)。测试不随运行安装包分发；源码和固定版本链接保留完整用例。

## 真实 Harness / 模型 / Git 验收

2026-11-06，在 DeepSeek Harness **0.2.1-rc.5** 中加载完整开发示例，在新的隔离 Git 仓库里执行了用户需求处理路径。首发沿用该内核与示例；此前本地开发快照编号不是本次公开版本序列。

| 验收项 | 观测结果 |
| --- | --- |
| 完整图 | 首发验收使用 51 节点、78 边；当前未发布示例为 59 节点、95 边（新增 backlog 水位、分支/worktree、draft PR、brief、PR 轮询和默认清理） |
| 需求 | 6 个真实需求全部实现、审查、批准并在隔离仓库中本地合并 |
| 原生模型执行 | 14 次：工程 7 次、审查 7 次 |
| 同刻并发 | 3 个工程师与 3 个审查者的原生子会话同时存在并执行，总并发 6 |
| Human 隔离 | 4 项待审批时，其余 2 项审查继续运行 |
| 同 ID 返修 | 一项经过 Human 修改请求；ID/worktreePath 不变，工程轮次、产物、审查均进入第 2 轮 |
| 完成计数 | 84 次节点执行、8/8 packets 完成、0 失败 |
| 独立检查 | 逐项验证变更范围、洁净 HEAD、不可变产物/审查绑定、合并祖先关系和额外边界断言 |
| 合并后测试 | 79/79 通过 |
| 工作目录 | 首发时 6 个 detached worktree 全部保留；当前未发布模型已改为 `auto/req-*` 分支 + attached worktree |
| 停止 | 所有包结束到 idle 后明确停止验收作业，无残留执行 |

实跑覆盖了**用户需求分派、工程/审查池、Human 返修/批准、本地集成与保留**，不代表每个图分支都调用了真实模型。挖掘/风险审批、busy 重排、真实 Git 冲突恢复和故障注入由实际 CLI/Git 加确定性模型桩验证。当前未发布的分支/draft PR 模型使用本地 bare remote 与 test-only fake `gh` 回归，**没有对真实 GitHub 执行 push/开 PR/外部 merge 验收**；真实运行前必须由用户配置 `gh` token 并在目标仓库验证。

首发时节点队列仍为限高列表，并曾用真实浏览器验证内部滚动、键盘 PageDown、刷新后保留位置和 Human 卡片不被挤出视口。当前未发布看板已改为每节点彩色方块网格，保留网格内部滚动；该项 UI 改动由脚本回归覆盖，未改动审批策略。

## 审计覆盖的风险

回归用例包括：旧 checkpoint 覆盖新入队、in-flight 引用提前 prune、迟到 join 分支重复续行、同包提交/失败/决策竞态、父失败后 fanout/nested 新准入、继承属性节点名、重复 native owner、实时暂停、停止后的子进程写入、命令拼接、HTTP 重定向越权、缺失 Web 鉴权与 session token 作用域。

示例另外覆盖：ignored 文件合并/清理保护、超过十秒的普通锁竞争、连续合法返修、旧审批或 snapshot 跨轮重放，以及显式 snapshot 对账。

## 不作出的保证

- 常驻运行不等于进程永不停止。Host 退出/重载后状态保留；不确定副作用不会自动重放。
- `historyLimit` 限制历史环，不限制保留的全部失败/中断 hot token 与 packet。持续失败需要人工检查、归档或新建 run。
- JSON 文件和 Git 不是跨文件事务，没有 exactly-once 副作用或掉电 fsync 保证。snapshot 有显式恢复；其他不确定中断须核对实际状态。
- 每仓库一个规范化数据目录、单机可信执行代码。不保证多主协调、恶意文件系统竞态或不可信 Git hooks 的隔离。
- command allowlist 是保守的 literal argv 前缀，不是 agent 工具的文件系统沙盒；复杂 shell 运算不会被隐式授权。
- 旧开发状态不自动迁移。图 apiVersion、运行状态版本、示例 store schema 与 package SemVer 是独立的版本契约。
- 多提供商真实故障、任意项目和所有模型组合未逐一验收；模型回退、reasoning 参数和取消规则由执行器回归验证。

使用方式与恢复步骤见[生命周期说明](<run-lifecycle.md>)和[唯一开发示例](<examples/development/README.md>)。
