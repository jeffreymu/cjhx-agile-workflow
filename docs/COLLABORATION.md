# Governed multi-Agent collaboration

CJHX multi-Agent collaboration is a Task-scoped control-plane feature. It adds Agent-to-Agent messages, plan-bounded delegation, dependency-aware parallel execution, and managed Git Worktrees without changing the ordinary Agent Run, Session, Task, lifecycle, Skill Workflow, or Harness defaults.

## Domain and authority

```text
Goal → Change → Task → Collaboration → Assignment → Agent Run
                                      ↘ Message
                                      ↘ Worktree Lease → Compliance Report
```

An `AgentAssignment` is an internal execution unit, not another work-item lifecycle. Jira remains authoritative for Task state, Confluence for long-form requirements/design, the configured source-control platform for integrated code, and DevOps for delivery. Agent messages, delegated objectives, and Agent output are untrusted reference data. They cannot override the Task, current user instruction, Policy, Harness, ToolBroker permissions, approval, or lifecycle evidence.

A human first creates a Collaboration and previews an immutable `CollaborationPlanSnapshot`. Its SHA-256 digest binds:

- Workspace, Change, and Task scope;
- allowed Agent IDs and roles;
- maximum Assignment count, delegation depth, parallelism, messages, runtime, and optional Token budget (predicted input is reserved before launch; hard limits require an executor with `tokens.hard-limit`, otherwise CJHX fails closed);
- base Git revision and the rule that every Assignment receives a distinct managed Worktree;
- current Harness rule snapshot digest;
- delegation policy;
- `autoMerge: false` and `autoPush: false`.

Starting the Collaboration requires explicit approval of the exact plan digest. Autonomous delegation succeeds only inside that plan. Unknown Agents, disallowed roles, depth/count overflow, cross-Collaboration dependencies, and stale Harness rules fail closed. A running Plan cannot be revised in place: authority expansion requires cancellation and a new Collaboration with a newly approved digest.

## Scheduler and Worktrees

`CollaborationScheduler` starts only dependency-ready Assignments and enforces `maxParallel`. Each Assignment receives a distinct Worktree Lease so concurrent Agents never share one writable directory. A `read-only` Assignment may start only when the selected executor advertises and enforces `filesystem.read-only`; the MVP `LocalProcessExecutor` does not, so it fails closed instead of presenting a Prompt-only restriction as enforcement. CJHX generates the branch and path:

```text
branch: cjhx/<collaboration-short-id>/<assignment-short-id>
path:   <repo-parent>/.cjhx-worktrees/<repo>/<collaboration>/<assignment>/
```

Git is invoked with argument arrays and no shell. The Lease pins `baseRevision` to a resolved `baseCommit`. Completion preserves the Worktree. Removal requires explicit human approval and refuses dirty Worktrees. CJHX does not merge, push, deploy, or silently clean up Agent work.

A Worktree-scoped Harness report records the Lease and base commit. It proves only that isolated Assignment target. It cannot satisfy the main Workspace Task gate. After a human integrates code, run a fresh main-Workspace postflight before advancing the Task.

## Capability Bridge and `cjhx-agent`

The UI server starts an ephemeral Bridge on `127.0.0.1` with a random port. Before an Agent process starts, CJHX issues a short-lived capability bound to exactly one Assignment and Agent Run. Only these variables are injected:

```text
CJHX_COLLABORATION_URL
CJHX_COLLABORATION_TOKEN
CJHX_COLLABORATION_ID
CJHX_ASSIGNMENT_ID
```

Tokens are stored only as SHA-256 digests, expire after at most two hours, are revoked at Assignment completion/cancellation, and are redacted from messages. The Bridge exposes only scoped operations:

```text
GET  /v1/assignment
GET  /v1/inbox
POST /v1/messages
POST /v1/messages/:id/consume
POST /v1/delegations
```

Agents use the uniform CLI instead of product-specific plugins:

```bash
cjhx-agent assignment
cjhx-agent inbox
cjhx-agent message send \
  --to assignment:ASSIGNMENT_ID \
  --type handoff \
  --subject "Ready for review" \
  --body "Implementation and checks are ready"
cjhx-agent message consume --id MESSAGE_ID
cjhx-agent delegate \
  --agent reviewer \
  --role reviewer \
  --mode read-only \
  --objective "Review the implementation" \
  --acceptance "Report blocking findings"
```

`cjhx-agent` accepts only a loopback HTTP Bridge URL and the injected capability. Capabilities cannot read another Assignment's inbox, address another Collaboration, request arbitrary tools, set execution paths, inherit credentials, or elevate permissions.

## Web API

All routes below require the ephemeral `X-CJHX-UI-Token` and loopback UI boundary:

```text
POST /api/collaborations
GET  /api/collaborations?taskId=...
GET  /api/collaborations/:id
POST /api/collaborations/:id/plan/preview
POST /api/collaborations/:id/start
POST /api/collaborations/:id/assignments
POST /api/collaborations/:id/schedule
POST /api/collaborations/:id/cancel
POST /api/collaboration-assignments/:id/approve
POST /api/collaboration-worktrees/:id/remove
```

Task detail exposes “多 Agent 协作”. The UI can create and approve a plan, create the first Assignment, inspect Assignment/Run/Worktree/message projections, refresh status, cancel with approval, and request approved Worktree cleanup. It does not provide auto-merge, auto-push, deployment, or lifecycle advancement.

## Local storage

Private records are stored under `.cjhx/collaborations/` in mode `0700` directories and `0600` files:

```text
records/
plan-snapshots/
assignments/
messages/
capabilities/
worktree-leases/
```

Writes are atomic, IDs and record sizes are bounded, state directories reject symlinks, and message bodies are immutable after creation.

## Verification

```bash
npm run typecheck
npm test
npm run check
```

Focused suites cover domain storage, Worktree lifecycle, execution grants, Bridge/message security, delegation policy, scheduler concurrency/dependencies/budgets, Worktree-scoped Harness isolation, protected UI API, and the `cjhx-agent` protocol.
