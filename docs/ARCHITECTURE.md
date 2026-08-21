# CJHX Agile Workflow architecture

## Purpose

CJHX Agile Workflow is a TypeScript-first, platform-neutral, skill-driven Agentic SDLC control plane. It coordinates authoritative platforms rather than replacing them.

## Authoritative systems

| Concern | Authority |
|---|---|
| Work items, status, owner, approval | Jira |
| Requirements, use cases, design, ADR, strategy | Confluence |
| Repositories, commits, change requests, code review | Configurable source-control platform |
| Build, verification, quality gates, artifacts, deployment | DevOps platform |
| Skill versions and execution traces | CJHX workspace/registry |
| Goal contracts, Goal Snapshots, and Goal-to-Change links | CJHX workspace |
| Unpublished decomposed task drafts | CJHX workspace |
| Published task status and assignment | Jira; CJHX stores a synchronized projection |
| Production telemetry | Reserved `ObservabilityAdapter` |

## Runtime boundaries

```text
Experience: Jira / Confluence / IDE / CLI / CJHX Web UI
                 |
Control plane: Goal + lifecycle + workflow + policy + context
                 |
Dashboard: read-only Goal / Task / Agent / Automation projection
                 |
Skill plane: registry + lockfile + runtime + evidence
                 |
Conversation: Session + Turn + MemorySnapshot + execution-context approval
                 |
Automation: Definition + Signal snapshot + deterministic findings + immutable report
                 |
Collaboration: approved plan + bounded Assignments + scoped messages + Worktree leases
                 |
Harness: rule snapshot + preflight + executor capability + postflight + Task gate
                 |
ToolBroker: permission-checked operations
                 |
Adapters: Jira / Confluence / source control / DevOps / observability
```

The framework never gives platform credentials to a Skill. A Skill emits requested `operations`; `ToolBroker` verifies each operation against the immutable manifest permission list and invokes a configured adapter.

`GoalService` owns Workspace-bound outcome contracts above Change and Task. It validates that linked Changes remain in the Goal Workspace, persists private mutable Goal records plus immutable SHA-256 `GoalSnapshot` history, gates activation on verifiable success criteria, and derives health from explicit criterion status, linked blocked Tasks, target date, and Automation Findings. Goal does not replace Jira, Confluence, Policy, Harness, or current user instructions and cannot grant Agent capabilities. `DashboardService` is a read-only aggregation seam over Goal, Change, Task, Agent, Harness, and Automation projections; it performs no writes or approvals.

The Web UI is an experience adapter over the same `CJHXFramework` facade and `.cjhx` workspace. It does not maintain a parallel lifecycle or evidence store. Its local HTTP server is loopback-only and requires an ephemeral per-process token for mutations.

DevOps pipeline, run, artifact, and service data is read as a live projection through `DevOpsService` and is not copied into `.cjhx`. Pipeline and service commands pass through the framework and `ToolBroker`; all such writes require explicit human approval, actor, and reason before the Adapter is invoked.

The Workspace Hub stores only repository references and display metadata under `.cjhx/workspaces/`. A local Workspace reads its canonical Git root and filesystem in real time. A virtual Workspace calls a configured GitLab or GitHub browser extension in real time and does not clone or persist repository trees, issues, change requests, or comments. Workspace-scoped views are projections: Overview summarizes repository health, Kanban invokes the same unified board projection as the global task-board entry with the current Workspace scope locked, Sessions projects Skill/Workflow runs, Team aggregates declared owners/assignees, and Codebase provides repository browsing.

Harness Engineering is a governance module over task-scoped Agent execution. It compiles governed sources and the repository's `cjhx.harness.json` into a private immutable snapshot, binds human approval to its SHA-256 digest, evaluates preflight rules, verifies that the selected `AgentExecutor` can truthfully enforce requested controls, runs a fixed catalog of postflight checks, and emits a code-state-bound `ComplianceReport`. Agent process success, Harness compliance, and Task gate eligibility are separate facts. A repository change after postflight makes the report stale. The project file is Workspace-scoped; enterprise authority must come from an injected governed rule source.

`ConversationService` owns task-bound Session and Turn lifecycles. `MemoryService` owns explicit durable records, scope filtering, lexical ranking, context budgets, correction, forgetting, and immutable MemorySnapshots. Session history, durable memory, and execution snapshots are separate facts. Historical context is always rendered as non-instructional data and cannot override Policy, Harness, authoritative task facts, or enabled Skills. A full execution-context digest covers Task content, Agent profile, Harness snapshot, recalled memory, current request, additional instructions, and the rendered Prompt; any change after preview invalidates approval.

`AutomationService` is a read-only engineering review module, not a generic workflow engine. Its only MVP kind is `daily-repository-review`, with a fixed catalog of dependency, test-failure, change-risk, release-health, and blocked-task checks. Each run acquires an atomic local claim, freezes a Definition Snapshot, reads the current Git/Task/DevOps/Harness signals, persists an immutable Signal Snapshot, derives stable-fingerprint Findings, and emits a repository-state-bound Report. Facts, hypotheses, and recommendations remain distinct. Missing adapters make collection `partial`; insufficient release history returns an `unknown` prediction. The loopback UI server can check due definitions once per minute and perform at most one catch-up run after restart, while enterprise scheduling belongs outside CJHX through the CLI.

Token usage is authoritative at `AgentRun` granularity and is never duplicated into Session, Task, Workspace, or Automation records. `AgentUsageCollector` implementations accept only structured `CJHX_USAGE:` JSON events; custom Agents cannot claim provider-reported precision. When structured usage is unavailable, CJHX stores a clearly labeled local estimate or unavailable state. Aggregates are computed dynamically for Run, Session, Task, Workspace, Automation Definition, and Automation Run scopes.

`CollaborationService`, `CollaborationScheduler`, `CollaborationBridge`, and `WorktreeLeaseService` form a separate Task-scoped multi-Agent control plane. A human-approved immutable plan binds allowed Agents/roles, current Harness digest, Git base revision, and Assignment/depth/parallel/message/time/Token limits. Delegation outside the plan fails closed; authority expansion requires cancelling the run and creating a new human-approved Collaboration Plan. Every Assignment receives a CJHX-generated Worktree; capability tokens are loopback-only, short-lived, bound to one Agent Run, stored only as digests, and revoked at completion or cancellation. Agent messages and outputs are untrusted data and cannot grant authority. Worktree Compliance Reports cannot satisfy the main Workspace Task gate; integration requires a fresh main-Workspace postflight. There is no automatic merge, push, deployment, lifecycle transition, or Worktree deletion.

Configured development Agents form a task-execution plane beside (not inside) the platform Adapter plane. `AgentService` stores private CLI profiles under `.cjhx/agents/`, selects one default Agent, binds every execution to a concrete Task and local Workspace, builds the prompt from task context and acceptance criteria, and records private Agent Runs under `.cjhx/agent-runs/`. `LocalSkillService` discovers both CJHX `skill.json` packages and Agent `SKILL.md` instructions in bounded, non-symlink local roots. CJHX packages are enabled through the existing digest-locked registry; enabled Agent instructions are stored privately in `.cjhx/local-skills.json` and supplied as explicit instruction-file references in task prompts. Pi, Claude Code, Codex, Qoder, DeepSeek Harness, and custom CLI names are edge configuration; lifecycle and Task contracts remain Agent-product neutral. Executable tests and runs require explicit approval and never use a shell. The local process runner is an MVP seam, not a sandbox; production deployments must replace it with an isolated worktree/container/micro-VM executor.

The domain hierarchy is `Goal → Change → Task`. MVP Goals bind one Workspace and may link multiple Changes in that Workspace; Tasks support Goals through their Change rather than through unconstrained direct many-to-many links. Requirement decomposition output may be promoted into local task drafts under `.cjhx/tasks/`. Changes, tasks, and execution runs can carry `workspaceId` so Team, Kanban, and Sessions are explicitly scoped. `WorkspaceHub.board()` normalizes CJHX drafts, Jira-owned task projections, GitHub/GitLab issues, and change requests into one seven-state `BoardItem` contract. Drafts have a CJHX-owned task state machine. Publishing a draft through `JiraAdapter` transfers task authority to Jira; Jira status writes require explicit approval through `ToolBroker`. Remote issue and PR/MR items remain live read-only projections and are never copied into `.cjhx/tasks/`.

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
- Replace `LocalProcessExecutor` behind the `AgentExecutor` seam with isolated worktrees and a container, gVisor/Kata, or micro-VM runner with egress, credential, CPU, memory, and filesystem policy.
- Implement `ObservabilityAdapter` later without changing the lifecycle contract.
- Extend platform-neutral read adapters with changed-file, review, deployment, rollback, and task-history signals before treating enterprise automation reports as complete.
