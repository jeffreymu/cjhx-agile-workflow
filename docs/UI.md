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

- compact left navigation for changes, Skills, and runs;
- persistent work-item switching and search;
- a central lifecycle canvas that makes the current stage and full delivery path visible;
- contextual evidence, gate, transition, and Agentic Action panels;
- neutral chrome, with color reserved for selection, success, warning, and failure state;
- responsive light and dark themes.

The UI supports:

1. creating and searching changes;
2. viewing all 12 lifecycle stages;
3. adding typed evidence;
4. advancing or returning lifecycle state through enforced gates;
5. installing immutable Skill packages;
6. running Skills with JSON input and explicit approval;
7. running declarative Workflows with `$ref` data flow;
8. viewing Skill and Workflow execution records and errors;
9. importing requirement-decomposition output as idempotent local task drafts;
10. viewing tasks on a seven-column board with Change, Owner, risk, and status filters;
11. inspecting acceptance criteria, dependencies, evidence references, source runs, and history;
12. transitioning local tasks through a guarded task state machine;
13. publishing approved drafts to Jira and synchronizing Jira-owned task projections when a Jira Adapter is configured;
14. viewing DevOps pipelines, recent CI/CD runs, artifacts, and service state;
15. triggering approved CI/CD runs and approved service start, stop, or restart actions through `DevOpsAdapter`;
16. testing, saving, updating, and removing standard HTTP Jira and DevOps Gateway configurations without exposing stored credentials;
17. reviewing configured integrations and their redacted connection summaries from a dedicated Integration Settings page;
18. configuring GitLab and GitHub independently, and selecting which saved provider currently supplies the platform-neutral `SourceControlAdapter`;
19. importing local Git repositories as managed Workspaces and switching among Workspace-scoped Overview, Kanban, Sessions, Team, and Codebase views;
20. browsing local directory trees and UTF-8 files, searching filenames/content, listing worktrees and refs, and inspecting commits;
21. creating/removing local worktrees, branches, and tags with explicit human approval;
22. importing configured GitLab/GitHub repositories as virtual Workspaces without cloning them;
23. browsing remote directory trees, files, refs, commits, issue, PR/MR, and comments as live Provider projections.

## Security boundary

The built-in UI is a local SDK/MVP control surface, not an internet-facing enterprise gateway.

- The server only accepts `127.0.0.1`, `::1`, or `localhost` bindings and rejects non-loopback `Host` headers to prevent DNS rebinding.
- A random per-process token is embedded in the initial HTML and required in `X-CJHX-UI-Token` for every mutation and every repository/issue/PR browsing endpoint.
- Responses use a restrictive Content Security Policy, deny framing, disable caching for state, and set `X-Content-Type-Options: nosniff`.
- Request bodies are limited to 1 MB.
- Local file browsing is confined to the canonical Git root, rejects symlinks that escape it, excludes `.git`, dependencies/build output from search, limits previews to 1 MB, and never exposes the active `.cjhx` state directory or Adapter credentials.
- Worktree and Git-ref mutations require explicit human approval; commands use `execFile` argument arrays rather than a shell.
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
