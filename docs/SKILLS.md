# Developing and installing Skills

## Manifest

Every Skill is a versioned package with `skill.json`:

```json
{
  "id": "requirement.decompose",
  "version": "1.0.0",
  "name": "需求拆解",
  "description": "...",
  "owner": "team-id",
  "source": "internal",
  "riskLevel": "S1",
  "entrypoint": {"type": "process", "target": "main.mjs"},
  "permissions": [],
  "tags": ["requirement"],
  "timeoutSeconds": 30,
  "requiresHumanConfirmation": false
}
```

IDs are lowercase. Versions are immutable: publishing changed bytes under the same ID/version is rejected by digest locking.

## Process protocol

A process Skill reads one JSON object from stdin and returns one JSON object on stdout. It must not print logs to stdout. Write logs to stderr.

```json
{
  "output": {},
  "evidence": [],
  "operations": []
}
```

Skills request tools through `operations`; they do not call authoritative systems directly. Secrets are never included in the Skill payload.

## Risk levels

- S0: transformation/summary
- S1: analysis or draft generation
- S2: draft creation in an authoritative platform
- S3: code changes or test execution
- S4: workflow transitions or test-environment deployment
- S5: merge, production deployment, rollback, migration
- S6: destructive data, permission, or security-policy changes

Default policy allows automatic execution through S3, but any declared write permission still requires explicit approval. S5/S6 should remain human controlled.

## Sources

Default approved sources are `internal` and `approved-external`. External packages must complete license, source, dependency, network, data-egress, permission, and evaluation review before using `approved-external`.

## Local discovery, enablement, and installation

The Skill Library can scan local directories for two extension formats:

- `skill.json`: a CJHX executable Skill package. Enabling installs and digest-locks it in `SkillRegistry`; disabling removes the lock entry but does not delete either the source package or the immutable installed copy.
- `SKILL.md`: an Agent instruction Skill used by tools such as Claude Code, Codex, Qoder, and pi. Enabling records its SHA-256 digest in `.cjhx/local-skills.json` and adds its name, description, and instruction-file path to task Agent prompts. If the file changes it becomes disabled until the user explicitly enables the new content. The Agent reads the file only when relevant to the task.

Default scan roots include user and project Skill directories for pi, Claude, Codex, and Qoder. Add enterprise or custom roots with the platform path delimiter:

```bash
export CJHX_SKILL_PATHS="/opt/company/skills:$HOME/company-skills"
```

Scanning is read-only, does not follow symbolic-link directories, skips `.git`, `.cjhx`, and `node_modules`, limits recursion and entry count, and reports an unavailable or malformed directory as a warning. Local paths are returned only by the token-protected UI API. Enablement never bypasses source, risk, process-execution, permission, or approval policy.

Manual CJHX package installation remains available:

```bash
cjhx skill-install examples/skills/requirement-decompose
cjhx skill-run requirement.decompose \
  --input '{"requirement":"支持批量取消；记录审计日志"}'
```

External process Skills are disabled by default in the TypeScript API. Enable them only with an explicit policy and a hardened execution environment:

```typescript
new CJHXFramework(".cjhx", {
  policy: new Policy({ allowProcessSkills: true }),
});
```

The JSON stdin/stdout protocol is language-neutral. Prefer TypeScript/JavaScript for new Skills. If a required SDK only exists in Python, package the Python capability as a sandboxed process or remote service without adding Python to the framework core.

## Production checklist

- signed package and immutable digest;
- approved source and license;
- input/output schemas;
- regression/evaluation suite;
- least-privilege tool list;
- timeout and cost budget;
- external sandbox for executable extensions;
- no long-lived credentials;
- canary rollout and immediate suspension path;
- owner and support SLO.
