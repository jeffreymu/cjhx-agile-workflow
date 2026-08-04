# CJHX Agile Workflow contributor guide

- Keep the core platform-neutral: use `SourceControlAdapter`, never a vendor name in lifecycle contracts.
- Jira owns work-item state; Confluence owns long-form requirements/design; DevOps owns verification, artifacts, and deployment.
- Skills never receive platform credentials. All platform access must pass through `ToolBroker` permissions.
- Every externally supplied skill is untrusted. Preserve digest locking, timeout, minimal environment, and fail-closed behavior.
- Keep the framework, CLI, built-in Skills, and tests TypeScript-first. Use Python only behind the language-neutral external Skill boundary when a required SDK has no TypeScript implementation.
- Add or update Node test coverage for behavior changes.
- Keep `cjhx.harness.json` machine-enforceable: checks must come from the approved catalog, and Prompt instructions must never be represented as executor-enforced controls.
- Run `npm run check` before committing.
