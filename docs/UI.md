# CJHX visual control surface

The CJHX Web UI visualizes and operates the same control plane exposed by `CJHXFramework` and the CLI. It does not create a second source of truth: lifecycle state, evidence, installed Skills, and execution traces remain in the configured `.cjhx` workspace.

## Start

```bash
cjhx --workspace .cjhx ui
```

Options:

```text
--host 127.0.0.1   Loopback host; non-loopback binding is rejected
--port 4317        HTTP port; use 0 through the TypeScript API for a random port
--no-open          Do not open the default browser
```

From a source checkout:

```bash
npm install --include=dev
npm run ui
```

## Information architecture

The layout follows the quiet, content-first principles used by agent orchestration tools such as Orca:

- compact left navigation led by Dashboard and first-class 目标, followed by Workspaces, delivery flow, Automation, integrations, Agents, Skills, and runs; the `>>` control collapses it to a persistent icon rail, and `<<` restores the full menu;
- persistent work-item switching and search;
- a central lifecycle canvas that makes the current stage and full delivery path visible;
- contextual evidence, gate, transition, and Agentic Action panels;
- neutral chrome, with color reserved for selection, success, warning, and failure state;
- responsive light and dark themes.

The UI supports:

1. opening Dashboard as the default read-only control view for Goal health, attention, running work, engineering health, and recent activity;
2. creating, editing, activating, and confirming Workspace-bound Goals from the first-class “目标” entry;
3. defining structured success criteria, current/baseline/target values, authoritative source references, scope, exclusions, constraints, linked Changes, target dates, and review cadence;
4. inspecting deterministic Goal health, linked Change/Task execution mapping, Automation Findings, and immutable GoalSnapshot digests;
5. creating and searching changes;
6. viewing all 12 lifecycle stages;
7. adding typed evidence;
8. advancing or returning lifecycle state through enforced gates;
9. scanning local pi, Claude, Codex, Qoder, enterprise, and project Skill directories for `SKILL.md` or `skill.json`, then enabling or disabling discovered Skills without deleting their sources;
10. installing immutable Skill packages manually and running enabled CJHX Skills with JSON input and explicit approval;
11. running declarative Workflows with `$ref` data flow;
12. viewing Skill and Workflow execution records and errors;
13. importing requirement-decomposition output as idempotent local task drafts;
14. viewing CJHX drafts, Jira projections, GitHub/GitLab issues, and PR/MR on one seven-column board with Workspace, source, kind, Change, Owner, risk, and status filters;
15. inspecting acceptance criteria, dependencies, evidence references, source runs, and history;
16. transitioning local tasks through a guarded task state machine;
17. publishing approved drafts to Jira and synchronizing Jira-owned task projections when a Jira Adapter is configured;
18. viewing DevOps pipelines, recent CI/CD runs, artifacts, and service state;
19. triggering approved CI/CD runs and approved service start, stop, or restart actions through `DevOpsAdapter`;
20. testing, saving, updating, and removing standard HTTP Jira and DevOps Gateway configurations without exposing stored credentials;
21. reviewing configured integrations and their redacted connection summaries from a dedicated Integration Settings page;
22. configuring GitLab and GitHub independently, and selecting which saved provider currently supplies the platform-neutral `SourceControlAdapter`;
23. importing local Git repositories as managed Workspaces and switching among Workspace-scoped Overview, Kanban, Sessions, Team, and Codebase views; Workspace Kanban reuses the global board component with the current Workspace scope locked;
24. browsing local directory trees and UTF-8 files, searching filenames/content, listing worktrees and refs, and inspecting commits;
25. creating/removing local worktrees, branches, and tags with explicit human approval;
26. importing configured GitLab/GitHub repositories as virtual Workspaces without cloning them;
27. browsing remote directory trees, files, refs, commits, issue, PR/MR, and comments as live Provider projections;
28. configuring multiple Claude Code, Codex, Qoder, or custom non-interactive Agent CLI profiles, testing their executables with approval, and choosing a default Agent;
29. previewing the effective Harness rule digest, preflight checks, executor capabilities, postflight checks, and Task gates before approving task-scoped Agent execution;
30. launching approved task development in the task's local Workspace and inspecting Agent process status separately from Harness compliance, including immutable rule digest and per-check results;
31. creating Task-bound Agent Sessions, continuing multi-turn conversations across configured Agents, and inspecting each Turn's immutable MemorySnapshot;
32. explicitly remembering, correcting, forgetting, pinning, and tracing Task/Change/Workspace memory without treating it as authoritative evidence;
33. creating, editing, enabling, disabling, and immediately running the built-in daily repository review from the first-class “自动化” navigation entry;
34. switching between “自动化任务” and “审计报告”, viewing deterministic findings, stale state, release readiness/prediction, blocked-task summaries, source completeness, and Automation Run token totals;
35. viewing a compact top-right Token meter for the active or most recent Task, with separate provider/driver-reported, estimated, unavailable, cache, and reasoning counters.

## Security boundary

The built-in UI is a local SDK/MVP control surface, not an internet-facing enterprise gateway.

- The server only accepts `127.0.0.1`, `::1`, or `localhost` bindings and rejects non-loopback `Host` headers to prevent DNS rebinding.
- A random per-process token is embedded in the initial HTML and required in `X-CJHX-UI-Token` for every mutation and every repository/issue/PR browsing endpoint.
- Responses use a restrictive Content Security Policy, deny framing, disable caching for state, and set `X-Content-Type-Options: nosniff`.
- Request bodies are limited to 1 MB.
- Local file browsing is confined to the canonical Git root, rejects symlinks that escape it, excludes `.git`, dependencies/build output from search, limits previews to 1 MB, and never exposes the active `.cjhx` state directory or Adapter credentials.
- Worktree and Git-ref mutations require explicit human approval; commands use `execFile` argument arrays rather than a shell.
- Agent executable tests and task development runs require explicit human approval. Agent commands use argument arrays with `shell: false`, run only from a task-associated local Workspace root, inherit only baseline process variables plus explicitly configured keys, have 1–120 minute timeouts, and cap stdout/stderr at 1 MB each.
- Harness previews, reports, and effective Task rules require the UI token. One-shot Agent approval is bound to the current SHA-256 rule digest. Session Turn approval is bound to a complete execution-context digest covering Task content, Agent profile, Harness rules, recalled memory, current input, additional instructions, enabled Skill context, and the fully rendered Prompt. Postflight checks use a fixed command catalog rather than rule-provided shell strings, and passed reports are bound to the repository state so later code changes require re-verification.
- Dashboard, Goal, GoalSnapshot, Session, Turn, memory, MemorySnapshot, execution-context, Automation, Finding, Report, and Token Usage APIs require the UI token. Goal records and snapshots use mode `0600`; Goal activation fails closed when success criteria are missing, and cross-Workspace Change links are rejected. Their private files use mode `0600`, and historical content is marked as non-instructional reference data before Prompt assembly.
- Automation is read-only in the MVP: it cannot update Jira, Task status, Owner, DevOps, deployment state, source-control state, or durable Memory. Definitions select only the approved built-in check catalog; arbitrary Shell, JavaScript, and free-form workflows are rejected. The UI server scheduler is a local convenience, not a reliable enterprise scheduler.
- Token usage accepts only structured Driver/Provider events. Local estimates remain labeled `estimated`, missing usage remains `unavailable`, and the first version does not display cost.
- The unauthenticated snapshot exposes only Agent profile/run metadata. Full commands, arguments, stdout, and stderr require the ephemeral UI session token. Agent config and run files use mode `0600`.
- Local Skill scanning and enable/disable APIs require the UI token because scan results contain absolute local paths. Agent instruction enablement is stored in `.cjhx/local-skills.json` with mode `0600`; scanning does not follow symlink directories or modify discovered files.
- A local Agent CLI shares the operating-system user's privileges and is not a sandbox. The prompt forbids push, publish, deploy, and destructive Git operations, but local enforcement cannot guarantee compliance. Enterprise use must execute Agents in isolated worktrees plus containers, gVisor/Kata, or micro-VMs with egress and credential policy.
- The unified board does not copy remote work items. GitHub/GitLab issue and PR/MR cards are live, read-only Adapter projections; CJHX/Jira task cards keep their existing authority and approval rules.
- Virtual Workspace data is read live through the saved Provider Adapter. It is not persisted as a second issue, PR, comment, or repository truth.
- The UI cannot skip lifecycle evidence gates.
- Local task drafts use a controlled transition graph. Once published, Jira is authoritative and Jira transitions require explicit approval.
- DevOps reads are live Adapter projections. Pipeline triggers and service controls require explicit approval, actor, and reason; an unconfigured Adapter leaves these actions unavailable.
- Skill policy, approval requirements, digest checks, ToolBroker permissions, and audit redaction remain enforced by the framework.
- Process Skills remain disabled unless the server is started with the CLI's global `--allow-process-skills` option.

For a shared or production deployment, place a separately implemented gateway in front of the framework with enterprise identity, authorization, CSRF controls, TLS, session expiry, rate limits, database storage, and distributed workflow infrastructure. Do not expose this local server through a reverse proxy.

## TypeScript API

```typescript
import { CJHXFramework, createUiServer } from "cjhx-agile-workflow";

const app = new CJHXFramework(".cjhx");
const ui = createUiServer(app, { host: "127.0.0.1", port: 4317, open: true });
const address = await ui.listen();
console.log(address.url);
```
