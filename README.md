# dsh-auto-workflow

**Persistent, concurrent node-graph workflows for DeepSeek Harness.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/lyingloong/dsh-auto-workflow/actions/workflows/test.yml/badge.svg)](https://github.com/lyingloong/dsh-auto-workflow/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A workflow is a graph of nodes and edges. One run stays mounted while packets move through it, so model work, shell commands, HTTP calls and human decisions can share a single long-lived pipeline. A packet waiting for a human does not stop other packets; new work can arrive at any time.

**"Auto" means continuous scheduling of an already-authorized graph, not skipping approvals.** While the host is up, an idle or waiting run stays mounted and state is persisted. After a host stop, plugin reload or interrupted execution, uncertain work is never replayed automatically, and there is no promise of exactly-once Git/HTTP transactions.

Project page: <https://lyingloong.github.io/dsh-auto-workflow/>

## Highlights

- **Durable run, concurrent packets.** Start once, enqueue new work later; a Human wait, a slow model or a failing packet does not tear down the run.
- **Node types for real automation.** `agent`, `command`, `http`, `human`, `fanout`, `join`, `gate` and `subworkflow` cover model calls, scripts, remote APIs, approvals and scheduling boundaries.
- **Explicit control plane.** Ordered model fallback, per-node concurrency, opt-in deadlines, pause/resume, queue switches, `recover:true` and Stop are engine features rather than prompt conventions.
- **Artifacts, not inline blobs.** Large inputs and outputs are stored as references; checkpoints stay bounded.
- **Live board.** Inspect node capacity, queues, Human decisions, run history and artifacts from a private loopback UI.
- **A worked example.** A GitHub-clone development workflow with per-requirement branches/worktrees/PRs, GitHub requirement approval and GitHub-native PR merge decisions.

## Requirements

- Node.js **22.5+**
- DeepSeek Harness **0.2.2-rc.2+** (verified on 0.2.2-rc.5)
- For the development example: Git, `gh` authentication and a model route usable by subagents

## Installation

Pin a release instead of tracking the development branch:

```bash
dsh plugin --profile desktop add github:lyingloong/dsh-auto-workflow#v1.2.0
```

You can also install the release `.tgz` or a local checkout:

```bash
dsh plugin --profile desktop add /absolute/path/dsh-auto-workflow-1.2.0.tgz
dsh plugin --profile desktop add /absolute/path/dsh-auto-workflow
```

Restart the DSH host and refresh the Web GUI after installation. Installing the plugin **does not** copy the example scripts into your repository and **does not** start any workflow.

## Examples

- **[GitHub project development workflow](docs/examples/development/README.md)** — clone a GitHub repository, keep one branch, worktree and PR per requirement, and move requirement approval and PR merge decisions to GitHub. The example ships the full graph, driver, store, PR protocol and operational guide.

Examples live in [`docs/examples/`](docs/examples/development/README.md); more will be added over time. Business guarantees: [Workflow summary](docs/examples/development/workflow-summary.md).

## The seven tools

| Tool | Purpose |
| --- | --- |
| `auto_workflow_define` | Validate and store the node graph plus the user-approved permission grant. |
| `auto_workflow_start` | Bind an immutable repository `cwd`, preflight and create one persistent run; does not execute nodes. |
| `auto_workflow_run` | Mount or continue the session-owned long-lived job and return immediately. |
| `auto_workflow_enqueue` | Add independent work to the existing run; new work never needs a restart. |
| `auto_workflow_decide` | Resolve one specific Human token without affecting other approvals. |
| `auto_workflow_control` | Pause/resume, switch one node queue, recover a parked live run with `recover:true`, or Stop. |
| `auto_workflow_status` | Read-only view of queues, capacity, Human items and the private board URL. |

Node types are `agent`, `command`, `http`, `human`, `fanout`, `join`, `gate` and `subworkflow`. See the [plugin reference](docs/plugin-summary.md) for fields and protocols. Do not poll `auto_workflow_run`.

## Permissions

Command and HTTP access is **deny by default**. Before defining a graph with privileged nodes, decide on full access or an allowlist and pass it to `auto_workflow_define`:

```json
{ "command": { "mode": "allowlist", "allow": ["node", "pnpm"] }, "http": { "mode": "allowlist", "allow": ["api.github.com"] } }
```

The runtime enforces the grant; the graph cannot widen it silently. A command allowlist is not a filesystem sandbox and does not replace the host's agent tool policy.

## Board

- **Human details:** inspect a waiting token's input JSON and record its outcome in one place.
- **Graph modes:** “Simplified” hides `busy-*` retry gates; “Minimal” keeps only agent and key gate nodes, compressing hidden paths; “Full” shows every edge.
- **Node tiles:** idle, running, waiting, error and closed states are visually distinct; click a tile for packets and history.

## Design boundaries

- The plugin owns generic scheduling and references; requirement priority, Git worktrees, review policy and merge policy belong to the example.
- A pause or a disabled node does not cancel in-flight work; Stop is not a rollback. Inspect side effects before recovering or starting a new run.
- Failed/interrupted attempts remain evidence, and failed tokens are archived from live scheduler state. `recover:true` clears stale pause/error state without replaying work.
- Single host, local file locks. Not a distributed queue, an external approval service, or exactly-once Git/HTTP transactions. The example pushes its own requirement branches and merges its own PRs under `mergePolicy`, but does not rewrite other people's PRs or deploy anything.

## Development

```bash
git clone https://github.com/lyingloong/dsh-auto-workflow.git
cd dsh-auto-workflow
npm test            # full regression suite
npm run verify:release
```

Repository conventions live in [AGENTS.md](https://github.com/lyingloong/dsh-auto-workflow/blob/main/AGENTS.md). Bug reports and pull requests are welcome; please include a minimal reproduction and keep tests deterministic and offline.

## Versioning

Package `1.2.0`, graph `apiVersion: 2`, run state `version: 3` and the example business store `version: 4` are separate contracts. The example's v3 store must be upgraded explicitly with `driver migrate`; it is never migrated in place. See [CHANGELOG.md](CHANGELOG.md) for the release history.

## Documentation

- [Documentation map](docs/README.md)
- [Run lifecycle and troubleshooting](docs/run-lifecycle.md)
- [Workflow guarantees](docs/examples/development/workflow-summary.md)
- [Development example](docs/examples/development/README.md)
- [Release notes: v1.2.0](docs/releases/v1.2.0.md) · [v1.0.0](docs/releases/v1.0.0.md)

## License

[MIT](LICENSE)
