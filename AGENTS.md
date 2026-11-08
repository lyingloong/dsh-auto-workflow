# dsh-auto-workflow repository development rules

## Release and tag authority

**Never create, move, or delete a Git tag or GitHub Release without explicit user authorization for that exact action in the current conversation.** This includes draft releases, release-body edits, asset uploads, `--cleanup-tag`, and tag-ref writes through `gh api`. A request to implement, test, review, commit, or push is not release authorization; neither is a green CI run, a version bump, or a documentation change. If a release is needed, report the proposed tag, target commit, assets, and checksums, then wait for explicit approval.

## One current architecture, explicit version boundaries

`dsh-auto-workflow` 1.0.0 is the first curated public release.
Earlier experimental release/tag names were withdrawn by the maintainer; their
commits remain in Git history. Package SemVer, graph apiVersion, run-state version
and the example's business-store version are separate contracts.

Do not add speculative compatibility layers, migrations, aliases, dual code paths
or "keep both" switches for the replaced stage engine. Replace obsolete code and
tests when an architecture change is explicitly authorized. Document breaking
boundaries and reject unsupported persisted states rather than silently migrating
or replaying uncertain effects. This preserves the maintainer's clean-model
policy chosen on 2026-11-04; a release number is not permission to rewrite user data.

## Permissions for workflow nodes

A workflow node may request host capabilities such as executing a command or
making an HTTP request.

- The session must ask the user before granting full node permissions.
- The default is deny.
- If the user does not grant full access, the session defines a restricted
  workflow: an allowlist of commands/hosts, or no privileged nodes at all.
- The runtime enforces the grant; a definition cannot silently widen it.

## Architecture direction

Workflows are node graphs: nodes have types and input/output contracts, edges
carry outcomes/conditions, and artifacts flow between nodes. The engine is the
control plane (scheduling, leases, retries, permissions); node executors are the
execution plane (agent, command, HTTP, human, fan-out/join, sub-workflow).
