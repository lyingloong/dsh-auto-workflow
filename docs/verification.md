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

- Windows / Node.js 24.12.0 的最后一轮功能回归为 **206 项通过、0 失败、0 跳过**，包含核心、执行器、宿主 `startActivation` 契约、宿主集成、Web API、看板、分支/PR 示例、seed 轮转与恢复及独立审计回归。
- `test:runner` 与默认入口使用同一组测试；`test:watch` 使用明确文件入口，不把测试目录当作模块运行。
- `verify:release` 检查包名、版本、exports、必要文件、包内 Markdown 链接、私有信息泄露以及开发示例的 3+3/root6 配置。它只读文件，不执行模型或业务命令。
- CI 保留仓库原有 Ubuntu / Windows × Node.js 24.x 矩阵。**矩阵配置不是通过声明**：具体提交的完成状态以 [GitHub Actions](https://github.com/lyingloong/dsh-auto-workflow/actions/workflows/test.yml) 为准。Node.js 22.5 是声明的最低版本，本次未单独实跑该下限；也未对 macOS 作完整运行验收。
- 所有测试使用一次性临时目录；Git 测试有独立本地身份，不修改用户仓库，不发布或推送。

测试源码：[默认入口](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.1/tests/run.mjs)、[核心审计](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.1/tests/audit-core.test.mjs)、[集成审计](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.1/tests/audit-integration.test.mjs)、[示例审计](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.1/tests/audit-example.test.mjs)。测试不随运行安装包分发；源码和固定版本链接保留完整用例。

## 开发示例验收

开发示例的真实验收记录和专项审计覆盖见 [开发示例验收记录](<examples/development/verification.md>)。这里只保留插件层回归、发布校验和通用边界。

## 审计覆盖的风险

回归用例包括：旧 checkpoint 覆盖新入队、in-flight 引用提前 prune、迟到 join 分支重复续行、同包提交/失败/决策竞态、父失败后 fanout/nested 新准入、继承属性节点名、重复 native owner、实时暂停、停止后的子进程写入、命令拼接、HTTP 重定向越权、缺失 Web 鉴权与 session token 作用域。


## 不作出的保证

- 常驻运行不等于进程永不停止。Host 退出/重载后状态保留；不确定副作用不会自动重放。
- `historyLimit` 限制历史环，不限制保留的全部失败/中断 hot token 与 packet。持续失败需要人工检查、归档或新建 run。
- JSON 文件和 Git 不是跨文件事务，没有 exactly-once 副作用或掉电 fsync 保证。snapshot 有显式恢复；其他不确定中断须核对实际状态。
- 每仓库一个规范化数据目录、单机可信执行代码。不保证多主协调、恶意文件系统竞态或不可信 Git hooks 的隔离。
- command allowlist 是保守的 literal argv 前缀，不是 agent 工具的文件系统沙盒；复杂 shell 运算不会被隐式授权。
- 旧开发状态不自动迁移。图 apiVersion、运行状态版本、业务 store schema 与 package SemVer 是独立的版本契约。
- 多提供商真实故障、任意项目和所有模型组合未逐一验收；模型回退、reasoning 参数和取消规则由执行器回归验证。

使用方式与恢复步骤见[生命周期说明](<run-lifecycle.md>)和[开发示例](<examples/development/README.md>)。
