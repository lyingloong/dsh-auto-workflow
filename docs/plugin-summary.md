# dsh-auto-workflow 插件参考

**dsh-auto-workflow**是 DeepSeek Harness 的通用节点图运行时，负责调度、packet 隔离、数据引用、权限检查与看板。需求、优先级、风险、Git worktree 和合并策略属于 [开发示例](<examples/development/README.md>)，不是插件 schema。

安装与常用工具顺序见 [首页](<../README.md>)；此页保留定义和协议参考。package `1.1.0`、定义 `apiVersion: 2`、run `version: 3`、示例 business store `version: 2` 分别编号。

## 1. 运行模型

| 概念 | 含义 |
| --- | --- |
| Definition | 节点图；每个 run 使用冻结的定义。 |
| Run | 会话内的持久化运行容器，绑定不可变的绝对项目 `cwd`；挂载时由一个原生 managed job 持有。 |
| Packet | 一份独立原始输入及其图执行，有自己的结果和终态。 |
| Token | 某个 packet 对某个节点的一次执行。 |
| Node service | 常驻工作池，状态为 `running`、`idle`、`disabled`；不会因一项任务完成而永久 completed。 |
| Artifact | 不透明的 `artifact-<uuid>` 引用；payload 与 checkpoint 分开存储。 |

根 `concurrency` 默认 `4`，节点 `concurrency` 默认 `1`，两者最大均为 `32`，共同限制实际并发。Human 等待不占工作槽，不阻塞其他 packet。Host 常驻期间 job 在 idle、暂停或 Human 等待时仍可保持挂载，由新 packet、决策或控制变更唤醒；不是靠反复调用 `run` 驱动。

## 2. 定义与节点

`auto_workflow_define` 接收完整 `definition` 和独立的 `permissions`。顶层字段：

| 字段 | 用途 |
| --- | --- |
| `apiVersion` | 固定 `2`。 |
| `name`、`entry` | 图名称、起始节点 ID。 |
| `nodes`、`edges` | 节点列表与结果边；边形如 `{ "from": "a", "to": "b", "on": "complete" }`。 |
| `concurrency` | 根并发上限。 |
| `historyLimit` | 热历史环长度，默认 `100`。 |
| `providers` | 可选模型 lane 配置。 |

节点包含 `id`、`type`、可选 `title` / `role` / `concurrency` / `inputs` 及 `config`。边的 `on` 默认 `complete`；有效的业务 outcome 按边前进，不意味着执行器故障。

| type | 核心 config / 行为 |
| --- | --- |
| `agent` | `prompt`、`cwd`、`lane`、`provider` / `model` 或 `models`、`reasoningEffort`、`outcomes`、`timeoutMs`、`maxFailures`。调用模型子任务。 |
| `command` | `command`、可选 `cwd` / `timeoutMs` / `json`；需要命令权限。 |
| `http` | `url`、可选 `method` / `headers` / `body` / `timeoutMs`；需要 HTTP 权限。 |
| `human` | 可选 `title` / `outcomes`，默认 `approve` / `reject`；等待某个 token 的决定。 |
| `fanout` | `items`、`target`，以及 `detached` 或 `join`；每项创建分支。detached 分支不阻挡父 packet 继续。 |
| `join` | `mode: all\|any\|quorum`，quorum 使用 `count`；内部等待，不是 Human 待办。 |
| `gate` | `delayMs` 延迟准入；不是任务超时，也不是隐含审批。 |
| `subworkflow` | 内联串行子图，不含 Human/fanout。 |

可直接阅读唯一主示例的 [完整定义](<examples/development/workflow.json>)，无需另维护一份简化图。执行前应以当前 Host 工具 schema 为准校验参数。

### 输入映射

| 表达式 | 解析来源 |
| --- | --- |
| `$input` | 当前 packet 不变的原始输入。 |
| `$prev` | 当前 packet 的前一节点输出。 |
| `$nodes.<id>.output` | 同一 packet 的指定节点结果。 |
| `$packet.id` | 当前 packet ID。 |
| `$item`、`$index` | fan-out 分支项与序号。 |

省略 `inputs` 会继承前一步的小 envelope；显式 `{}` 是空映射。输入在 token 排队时记录，执行器不会临时重新解析。

**注意两种 `$input` 的上下文不同：** `node.inputs` 中的 `$input` 指 packet 原始输入；`config.cwd` / `config.url` 中的 `$input.*` 则针对该节点**已经映射并记录的输入**解析。动态 worktree `cwd` 因此可以来自上一节点的小 envelope，而不是硬编码项目路径。

### Agent 模型、回退与截止时间

`config.models` 是最多 8 项的有序候选列表：

```json
{
  "models": [
    { "provider": "<configured-provider>", "model": "<primary-model>" },
    { "provider": "<configured-provider>", "model": "<fallback-model>" }
  ]
}
```

候选可各自指定实际模型目录支持的 `reasoningEffort`。示例不固定服务商；未配置时使用 Host 路由。看板只展示当前目录支持的 effort。

只有 provider/model 调用失败（例如网络错误、模型不可用、激活失败）才尝试下一候选。有效的 `fail`、`revise`、`needs_revision`、`reject` 按业务边处理，不换模型；取消、无效模型输出和失败预算耗尽也不触发回退。模型必须给出明确 outcome，不能将无效回复当作批准。

模型/开发任务**默认没有截止时间**。显式正值 `config.timeoutMs` / 插件 `agentTimeoutMs` 是 opt-in，`0` 禁用。command/HTTP 保留操作超时，避免挂起请求无限占用资源。

### JSON command 协议

`config.json: true` 把已解析节点输入作为 JSON 放入环境变量 `DSH_WORKFLOW_INPUT`。脚本应向 stdout 输出一个结果对象：

```json
{
  "outcome": "ready",
  "output": {
    "dataRef": "C:/work/workflow-data/requirements/req-example.json",
    "cwd": "C:/work/workflow-data/worktrees/req-example"
  }
}
```

日志应写入 stderr；如有 stdout 前置日志，最后仍须为可解析的结果 JSON。非零退出码不会丢弃有效的业务 `{outcome, output}`；JSON 缺失或损坏则是执行错误，不能当作业务决定。[示例 driver](<examples/development/driver.mjs>) 更严格，只打印一个 JSON 结果。

## 3. 权限

权限不属于节点图，不能由图自行扩权。使用 command/HTTP 之前，先询问用户批准 `deny`（默认）、受限 `allowlist` 或 `full`，然后与定义一并提交。主示例的受限授权为：

```json
{
  "command": {
    "mode": "allowlist",
    "allow": ["node docs/examples/development/driver.mjs"]
  },
  "http": { "mode": "deny", "allow": [] }
}
```

运行时在调用执行器前检查命令或 HTTP host；未授权返回 `permission_denied`。受限命令授权拒绝 shell 运算符/展开，HTTP 重定向也受授权约束。

这授权的是**可信脚本及其副作用**，不是文件系统沙箱。agent 能使用哪些工具由 Host 的独立权限策略决定；command grant 不会自动限制 agent。示例的 Human merge 门禁也不是外部身份认证或审批服务。

## 4. 工具分工

| Tool | 执行与状态语义 |
| --- | --- |
| `auto_workflow_define` | 校验并保存定义及已批准权限，供新 run 使用。 |
| `auto_workflow_start` | 绑定绝对 `cwd` 和初始输入、静态预检、创建 run；不执行。 |
| `auto_workflow_run` | 挂载/继续当前 run 的原生 job，立即返回回执。 |
| `auto_workflow_enqueue` | 向现有 run 添加新 packet，可指定 `nodeId`；控制允许且没有 job 时可冷启动。 |
| `auto_workflow_decide` | 为一个等待中的 Human `tokenId` 提交声明过的 outcome 和可选 output。 |
| `auto_workflow_control` | `continuous` 暂停/继续；`nodeId` + `enabled` 切换队列；`stop:true` 中断 job。 |
| `auto_workflow_status` | 只读状态、绑定 cwd、job、packet 计数、节点池、Human 待办和看板 URL。 |

入队不是重启；决策不是新 packet；读取 status 不执行也不重试工作。控制和恢复详见 [生命周期](<run-lifecycle.md>)。

## 5. 存储、看板与恢复边界

运行时数据按 DSH session 隔离，位于 `<dataDir>/sessions/<sessionId>`：

```text
workflow.json                  会话定义 + permission grant
control.json                   全局 continuous 与节点开关
runs/<runId>/state.json         packet/token/counts/nodeStats 与执行所有权
runs/<runId>/definition.json    本次 run 的冻结定义
runs/<runId>/artifacts/*.json   payload 与引用 sidecar
runs/<runId>/history.json      有界历史元数据
```

Checkpoint 保存引用，不重复嵌入 payload 或完整对话。Artifact 默认上限 256 KB；大数据应写入业务文件，只返回小 envelope。清理仅删除不可达运行时 artifact，不删除工作流业务文件。业务 `dataRef` 与引擎 artifact ID 是两种不同引用，插件不会自动读取前者。

会话顶部 **工作流** 按钮通过原生 Browser 侧栏打开独立的 token 保护 loopback 看板，路径固定为 `/plugins/dsh-auto-workflow/board`。看板提供节点容量/队列、Human 待办、有序模型选择以及按需加载历史/产物。插件负责监听器，用户无需另开服务器。token 绑定一个 session；主站 API 在 Connection 认证缺失时拒绝访问。看板 URL 含私有访问凭据，不应公开。

**持久化不保证自动恢复副作用。** Host 停止或插件重载后，失去执行所有者的 `running` 工作保留为 interrupted 证据；失败/中断执行不自动重放。Stop 会中止并收束执行，但不回滚已经发生的 Git/HTTP 操作。单 Host 协调、原子文件替换与引用落盘，不等于分布式锁、多文件事务、exactly-once 或掉电耐久性承诺。

回归与真实运行覆盖集中在 [验证说明](<verification.md>)；执行前仍需核对目标仓库、权限、模型工具与具体项目的验证命令。
