# Harness Engineering

CJHX Harness Engineering governs task-scoped Agent execution without depending on Harness.io. It separates five concerns that must not be collapsed into a prompt:

1. **Instruction** — guidance included in the Agent prompt.
2. **Preflight** — checks performed before an Agent process starts.
3. **Executor capability** — controls that the selected executor can actually enforce.
4. **Postflight** — approved checks executed after the Agent process exits successfully.
5. **Task gate** — evidence required before a Task can move to a governed status.

An Agent process can succeed while Harness compliance fails. Both statuses are stored and displayed separately.

## Minimal closed loop

```text
cjhx.harness.json
        ↓ strict validation + SHA-256 compilation
immutable RuleSnapshot
        ↓ digest-bound human approval
Agent task execution
        ↓
approved postflight checks
        ↓
ComplianceReport + repository state digest
        ↓
Task transition gate
```

The first usable implementation supports:

- a version-controlled Workspace rule bundle at `<repository>/cjhx.harness.json`;
- optional enterprise rule sources supplied through the TypeScript constructor;
- strict, fail-closed parsing with a versioned JSON Schema;
- monotonic capability merging and unique Rule IDs;
- `audit` and `enforce` modes, which cannot be mixed in one effective snapshot;
- Task acceptance-criteria and local-Workspace preconditions;
- approved `npm.typecheck`, `npm.test`, and `npm.check` postflight checks;
- Task gates backed by those checks;
- immutable private snapshots and compliance reports under `.cjhx/harness/`;
- approval bound to the current rule digest;
- repository state fingerprints, so code changes after checks make the report stale;
- protected UI APIs and Task/Agent Run visualization.

## Create a rule file

Copy the example to the root of a managed local repository:

```bash
cp config/cjhx.harness.example.json cjhx.harness.json
cjhx harness-validate cjhx.harness.json
```

The project file must use `scope: "workspace"`. Enterprise, Change, and Task bundles are supplied through governed `HarnessRuleSource` implementations rather than pretending that a project file has enterprise authority.

A minimal enforce bundle:

```json
{
  "$schema": "./schemas/harness-rule-bundle.schema.json",
  "schemaVersion": 1,
  "id": "typescript-engineering",
  "version": "1.0.0",
  "scope": "workspace",
  "mode": "enforce",
  "rules": [
    {
      "id": "quality",
      "description": "Require the project check before verification",
      "instruction": "Make the smallest safe TypeScript change and summarize validation.",
      "preconditions": [
        "workspace.is-local",
        "task.has-acceptance-criteria"
      ],
      "requiredChecks": ["npm.check"],
      "gates": [
        {
          "target": "task.verification",
          "requires": ["check:npm.check"]
        }
      ]
    }
  ]
}
```

The repository must define the referenced npm script. Checks are selected from a fixed catalog; rule files cannot inject arbitrary shell commands.

## CLI

```bash
# Validate a bundle without installing or enabling it
cjhx harness-validate cjhx.harness.json

# Compile and persist the effective snapshot for a Task
cjhx --workspace .cjhx harness-effective TASK_ID

# Inspect compliance history
cjhx --workspace .cjhx harness-reports --task-id TASK_ID
```

## Agent execution

Before starting an Agent from the UI, CJHX displays:

- effective `audit` or `enforce` mode;
- immutable SHA-256 rule digest;
- preflight outcomes;
- required executor capabilities;
- postflight checks;
- Task gates.

Approval is bound to that digest. If `cjhx.harness.json` changes before launch, the backend rejects the stale approval.

After the Agent exits:

- a failed/timed-out Agent produces failed compliance and does not run quality checks;
- a successful Agent runs each required check with an argument array, no shell, a 120-second timeout, a 256 KB output limit, and a minimal environment;
- results are stored in a private `ComplianceReport`;
- the report records the exact Git HEAD, tracked diff, staged diff, and untracked-file content digest;
- a later repository change invalidates the report for Task gates.

## Executor capability honesty

`LocalProcessExecutor` supports only:

```text
process.arguments
process.timeout
process.output-limit
```

It does **not** enforce network isolation, filesystem write roots, or Git-operation restrictions. An `enforce` rule requiring any of those capabilities is rejected before the process starts:

```text
Agent executor cannot enforce required capability: network.none
```

Such rules become usable only after injecting an executor that truthfully advertises and implements the required capabilities, for example an isolated worktree/container or micro-VM executor. Prompt text is never presented as runtime enforcement.

## Rule composition

Effective rules combine an optional list of governed `HarnessRuleSource` bundles with the Workspace file. Rules tighten monotonically:

- network mode chooses the most restrictive value;
- allowlists and write/tool allowlists use intersection;
- deny lists use union;
- any denied Git capability remains denied;
- preconditions, checks, instructions, and gates use union.

Duplicate Rule IDs and mixed `audit`/`enforce` bundles fail closed. A lower scope cannot silently replace a higher-scope rule.

## Storage and security

```text
.cjhx/harness/
├── snapshots/       # immutable effective rule snapshots (0600)
├── reports/         # Agent/postflight compliance reports (0600)
```

Harness APIs return absolute context and detailed check output, so they require `X-CJHX-UI-Token`. They are not included in the public snapshot. Rule files cannot be symlinks, are limited to 1 MB, and unknown fields/checks/gate requirements are rejected.

The local UI token and `0600` files are suitable only for the local single-user control plane. Shared deployment still requires SSO, RBAC, centralized secrets, signed enterprise bundles, server-side approval identity, and an isolated executor.

## Current phase and next phases

This implementation completes the Phase 1 minimal closed loop and introduces the Phase 2 `AgentExecutor` seam with `LocalProcessExecutor`.

Next steps:

1. implement `IsolatedWorktreeExecutor` and then a container/micro-VM Adapter;
2. move enterprise rules to signed remote bundles and bind approvals to SSO/Jira identities;
3. apply effective tool capabilities at `ToolBroker` and extend governance to Skill Runs;
4. add governed exceptions through Jira approval instead of a local bypass;
5. aggregate Harness compliance into Change-level evidence.
