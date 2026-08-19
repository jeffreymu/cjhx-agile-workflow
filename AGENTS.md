# CJHX Agile Workflow contributor guide

- Keep the core platform-neutral: use `SourceControlAdapter`, never a vendor name in lifecycle contracts.
- Jira owns work-item state; Confluence owns long-form requirements/design; DevOps owns verification, artifacts, and deployment.
- Skills never receive platform credentials. All platform access must pass through `ToolBroker` permissions.
- Every externally supplied skill is untrusted. Preserve digest locking, timeout, minimal environment, and fail-closed behavior.
- Keep the framework, CLI, built-in Skills, and tests TypeScript-first. Use Python only behind the language-neutral external Skill boundary when a required SDK has no TypeScript implementation.
- Add or update Node test coverage for behavior changes.
- Keep `cjhx.harness.json` machine-enforceable: checks must come from the approved catalog, and Prompt instructions must never be represented as executor-enforced controls.
- Run `npm run check` before committing.

---

# Project knowledge base

CJHX Agile Workflow is a TypeScript-first, skill-driven Agentic SDLC control plane. It orchestrates Jira / Confluence / a configurable source-control platform / a DevOps platform without replacing them. Node.js 20+, zero runtime dependencies (dev-only: typescript, @types/node). Authoritative docs: `README.md` and `docs/{ARCHITECTURE,SKILLS,HARNESS_ENGINEERING,MEMORY,UI,INTEGRATIONS}.md` — update docs when behavior changes.

## Commands

- `npm run build` — custom `scripts/build.mjs` compiles `src/`, `tests/`, and `ui/` into `dist/`.
- `npm test` — build first, then Node native test runner over `dist/tests/*.test.js`.
- `npm run typecheck` — strict `tsc --noEmit` plus `tsconfig.ui.json` for the UI.
- `npm run check` — typecheck + tests; required before committing.
- `npm run ui` / `cjhx --workspace .cjhx ui` — local control surface on `http://127.0.0.1:4317`.
- If `NODE_ENV=production`, use `npm install --include=dev`.

## Source map (`src/`)

- `framework.ts` — `CJHXFramework` facade wiring every service; public API entry (`index.ts` re-exports).
- `models.ts` — core types: `Change`, `Evidence`, `SkillManifest`, `SkillRun`, `LifecycleState`, `RiskLevel`.
- `lifecycle.ts` — 12-state Change state machine with typed-evidence gates: `intent_draft → intent_confirmed → requirement_ready → design_approved → implementing → reviewing → verified → accepted → release_approved → deploying → operating → outcome_validated`.
- `adapters.ts` — `JiraAdapter`, `ConfluenceAdapter`, `SourceControlAdapter`, `DevOpsAdapter`, `ObservabilityAdapter` (reserved), `ToolBroker` permission checks, in-memory test adapters.
- `skills.ts` / `builtin-skills.ts` / `local-skills.ts` — digest-locked `SkillRegistry`, `SkillRuntime`, and `SKILL.md`/`skill.json` local discovery. Process Skills are fail-closed by default.
- `workflows.ts` — declarative multi-Skill workflows with `$ref` data passing.
- `tasks.ts` — local draft task state machine; publishing hands authority to Jira.
- `policy.ts` — risk levels (S0–S6), source allowlist, approval policy.
- `harness.ts` — Harness Engineering: immutable rule snapshots from `cjhx.harness.json`, digest-bound approval, preflight, executor-capability honesty, postflight checks, Task gates.
- `agents.ts` — `AgentService` + `AgentExecutor` seam (`LocalProcessExecutor` is MVP-only, not a sandbox); supported kinds: `pi` (default preset), `claude-code`, `codex`, `qoder`, `custom`.
- `agent-terminal.ts` — approval-gated local terminal verification: builds a single-quote-escaped version-test + interactive-session script (mode `0700`, temp dir) and opens it with the platform terminal via argument arrays, never a shell.
- `conversations.ts` / `memory.ts` — task-scoped Sessions/Turns, explicit durable memory, immutable `MemorySnapshot` / `ExecutionContextSnapshot`; history is non-instructional data.
- `goals.ts` / `dashboard.ts` — `Goal → Change → Task` contracts with immutable `GoalSnapshot`; dashboard is read-only aggregation.
- `workspace-hub.ts` — local/virtual Workspace projections, unified seven-state board, Git via `execFileSync` argument arrays (never shell).
- `automations.ts` — read-only built-in `daily-repository-review` with deterministic findings.
- `devops.ts`, `{jira,gitlab,github,source-control,devops}-config.ts` — integration config with non-echoed credentials.
- `ui.ts`, `cli.ts`, `ui/` — loopback-only token-protected Web UI (no parallel state) and the `cjhx` CLI.
- `storage.ts` — `.cjhx/` file workspace, atomic writes, `0600` for private records.

## Invariants to preserve

- One state machine: UI and CLI operate the same `CJHXFramework` + `.cjhx` workspace; never create parallel stores or skip evidence gates.
- Everything write-side is approval- and digest-bound: Skill enablement, Agent turns, Harness rules, Git mutations, DevOps actions.
- Snapshots (Goal, Harness rule, Memory, ExecutionContext, Signal) are immutable and SHA-256 identified; post-check repo changes make reports stale.
- All subprocess/Git invocations use argument arrays with `shell: false`; cap output, timeout, and environment.
- Durable memory, automation, and dashboards are read-only or explicit-user-action only; they can never satisfy lifecycle/Harness gates.
- `.cjhx` stores control-plane facts only; platform business data is read live via adapters and never copied.

## Testing layout

`tests/*.test.ts` mirror `src/` modules one-to-one (e.g. `tests/harness.test.ts`, `tests/workspace-hub.test.ts`); add or update the matching test file for any behavior change.
