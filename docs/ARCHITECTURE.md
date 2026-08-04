# CJHX Agile Workflow architecture

## Purpose

CJHX Agile Workflow is a TypeScript-first, platform-neutral, skill-driven Agentic SDLC control plane. It coordinates authoritative platforms rather than replacing them.

## Authoritative systems

| Concern | Authority |
|---|---|
| Work items, status, owner, approval | Jira |
| Requirements, use cases, design, ADR, strategy | Confluence |
| Repositories, commits, change requests, code review | Configurable source-control platform |
| Build, verification, quality gates, artifacts, deployment | BoCloud DevOps |
| Skill versions and execution traces | CJHX workspace/registry |
| Unpublished decomposed task drafts | CJHX workspace |
| Published task status and assignment | Jira; CJHX stores a synchronized projection |
| Production telemetry | Reserved `ObservabilityAdapter` |

## Runtime boundaries

```text
Experience: Jira / Confluence / IDE / CLI / CJHX Web UI
                 |
Control plane: lifecycle + workflow + policy + context
                 |
Skill plane: registry + lockfile + runtime + evidence
                 |
ToolBroker: permission-checked operations
                 |
Adapters: Jira / Confluence / source control / DevOps / observability
```

The framework never gives platform credentials to a Skill. A Skill emits requested `operations`; `ToolBroker` verifies each operation against the immutable manifest permission list and invokes a configured adapter.

The Web UI is an experience adapter over the same `CJHXFramework` facade and `.cjhx` workspace. It does not maintain a parallel lifecycle or evidence store. Its local HTTP server is loopback-only and requires an ephemeral per-process token for mutations.

DevOps pipeline, run, artifact, and service data is read as a live projection through `DevOpsService` and is not copied into `.cjhx`. Pipeline and service commands pass through the framework and `ToolBroker`; all such writes require explicit human approval, actor, and reason before the Adapter is invoked.

The Workspace Hub stores only repository references and display metadata under `.cjhx/workspaces/`. A local Workspace reads its canonical Git root and filesystem in real time. A virtual Workspace calls a configured GitLab or GitHub browser extension in real time and does not clone or persist repository trees, issues, change requests, or comments. Workspace-scoped views are projections: Overview summarizes repository health, Kanban invokes the same unified board projection as the global task-board entry with the current Workspace scope locked, Sessions projects Skill/Workflow runs, Team aggregates declared owners/assignees, and Codebase provides repository browsing.

Requirement decomposition output may be promoted into local task drafts under `.cjhx/tasks/`. Changes, tasks, and execution runs can carry `workspaceId` so Team, Kanban, and Sessions are explicitly scoped. `WorkspaceHub.board()` normalizes CJHX drafts, Jira-owned task projections, GitHub/GitLab issues, and change requests into one seven-state `BoardItem` contract. Drafts have a CJHX-owned task state machine. Publishing a draft through `JiraAdapter` transfers task authority to Jira; Jira status writes require explicit approval through `ToolBroker`. Remote issue and PR/MR items remain live read-only projections and are never copied into `.cjhx/tasks/`.

## Change lifecycle

```text
intent_draft -> intent_confirmed -> requirement_ready -> design_approved
-> implementing -> reviewing -> verified -> accepted -> release_approved
-> deploying -> operating -> outcome_validated
```

Transitions are state-machine controlled. Important forward transitions require typed evidence. Feedback transitions return a change to an earlier state without deleting history.

## Skill packages

A package contains at least `skill.json`. Entrypoints are:

- `builtin`: trusted handlers shipped with the framework;
- `process`: an approved external process that reads JSON on stdin and writes JSON on stdout.

Process Skills are disabled by default. Production deployments should execute them in an external hardened sandbox; the local process runtime is an SDK/MVP seam, not a VM security boundary.

### Skill response

```json
{
  "output": {"domainResult": "..."},
  "evidence": [{"type": "report", "uri": "artifact://..."}],
  "operations": [
    {"tool": "jira.issue.update", "arguments": {"key": "PAY-128", "fields": {}}}
  ]
}
```

## Local repository safety

`WorkspaceHub` invokes Git with `execFileSync` and argument arrays, never shell interpolation. Reads are constrained to the canonical repository root, reject escaping symlinks and binary/oversize previews, and exclude the active `.cjhx` state directory. Local worktree and ref mutations require an explicit approval flag. Removing a Workspace deletes only its CJHX reference, never the repository.

## Platform neutrality

Core workflow contracts use `SourceControlAdapter`; product-specific implementations live outside the core. Test execution belongs to the DevOps/quality plane and can invoke any approved test tool.

## Extension seams

- Implement TypeScript interfaces in `src/adapters.ts` for production platforms.
- Package domain and project Skills with manifests and evaluation cases.
- Implement a remote sandbox executor behind `SkillRuntime` for untrusted extensions.
- Implement `ObservabilityAdapter` later without changing the lifecycle contract.
