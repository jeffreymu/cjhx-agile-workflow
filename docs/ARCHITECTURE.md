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
| Production telemetry | Reserved `ObservabilityAdapter` |

## Runtime boundaries

```text
Experience: Jira / Confluence / IDE / CLI
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

## Platform neutrality

Core workflow contracts use `SourceControlAdapter`; product-specific implementations live outside the core. Test execution belongs to the DevOps/quality plane and can invoke any approved test tool.

## Extension seams

- Implement TypeScript interfaces in `src/adapters.ts` for production platforms.
- Package domain and project Skills with manifests and evaluation cases.
- Implement a remote sandbox executor behind `SkillRuntime` for untrusted extensions.
- Implement `ObservabilityAdapter` later without changing the lifecycle contract.
