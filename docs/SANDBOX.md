# Optional Pi Sandbox (experimental)

This opt-in integration uses `@anthropic-ai/sandbox-runtime@0.0.80` in a separate
Runner for every Agent and Postflight execution. It is **not yet OS-acceptance
validated**. Existing local execution is unchanged unless `--sandbox-config` is
provided at service startup. Failure never retries on the host.

## Requirements and limits

- Node >=22.12 for SRT; installed Pi may require a newer Node (current Pi: >=22.19).
  Non-sandbox CJHX still supports Node 20.
- macOS: upstream Seatbelt dependencies, including `rg` on service PATH.
- Linux: upstream bubblewrap, socat and ripgrep prerequisites.
- Windows: **blocked** pending independently verified Runner process-tree cleanup.
  A published upstream Windows backend is not proof this integration is ready.
- Single Pi Agent, stdin profile only. No interactive terminals, arbitrary MCP,
  global/project extensions, discovered skills, project config, Worktree delegation,
  or automations. Only one running Agent is permitted.
- The product installation and Pi installation must be outside the target repo.
  Do not dogfood writes against the running control-plane source installation.
- All existing explicit Git/tool restrictions are rejected: filesystem isolation
  is not a Git command broker. No promise that a permissive Harness rule prevents
  all Git operations. `.git` itself is protected.
- SRT brings optional transitive dependencies. At implementation time `npm audit`
  reports a high node-forge advisory affecting RSA signature verification. TLS
  termination is not enabled here; do not interpret this as an audit clean bill.
- A process with the same host user, or an adversarial native process using OS
  capabilities outside this threat model, may need stronger VM/container isolation.

## Configure and start

Install development dependencies explicitly if NODE_ENV=production:

```sh
npm install --include=dev
npm run build
```

Create an administrator-owned config **outside the Agent execution repository**:

```json
{
  "schemaVersion": 1,
  "readRoots": [
    "/usr", "/bin", "/sbin", "/System", "/Library", "/private/etc", "/dev",
    "/opt/homebrew",
    "/ABSOLUTE/PI/INSTALLATION"
  ],
  "modelHosts": ["api.anthropic.com"],
  "piEntry": "/ABSOLUTE/PI/INSTALLATION/dist/cli.js",
  "model": "anthropic/REPLACE_WITH_INSTALLED_MODEL_ID",
  "credentialKeys": ["ANTHROPIC_API_KEY"]
}
```

Every readRoot must exist. Adjust for actual Node/Pi/toolchain locations. Do not
allow `/`, HOME, `/Users`, or your entire development directory. A read grant
exposes everything beneath it (except more-specific denied paths), not only
executables. The system examples are deliberately explicit, not auto-discovered.
The dedicated private HOME/temp are added by Runner; shared `/tmp/claude` is denied.
Model hosts must be explicit DNS names (no local hosts, URLs, IPs, ports or wildcards).
Only approved model credential keys are forwarded; Postflight receives none.
The Agent can read passed API keys: use a dedicated low-privilege key.

From a **system terminal**, export the model key without putting it into the JSON
or CLI arguments, then start:

```sh
node dist/src/cli.js --workspace .cjhx --sandbox-config /ABSOLUTE/sandbox-admin.json ui
```

Open http://127.0.0.1:4317. In 智能体配置, select/create a Pi profile with stdin prompt
transport and environmentKeys containing the approved credential key. The saved
profile command is used for its separate executable-version test, **not** the
sandbox task launch: task execution always uses Node + administrator `piEntry`
and fixed hardening flags. Profile arguments are not used in sandbox mode.

## UI verification

1. Confirm the configuration page shows `anthropic-srt-0.0.80` and an explicit
   unverified/blocked platform notice. It must not claim OS validation passed.
2. Add a separate disposable local Git repository as Workspace. Associate a Task.
3. Use existing `cjhx.harness.json` rules for `npm.typecheck` / `npm.test` as needed.
   Pre-install dependencies on the host; Postflight will not download anything.
4. Open the Task's one-shot Agent approval. Review effective Agent read/write/deny
   paths, model hosts, Postflight's empty network list, and approval digest.
5. Start an approved run. Run details show the IPC-derived Runner state, digest,
   and cleanup. `ready` means the wrapper was launched, **not** OS acceptance passed.
6. After completion, distinguish Agent success, cleanup completion and Harness
   compliance. All must pass; Agent-written success text proves none of these.
7. Change admin configuration and restart service, or change the Agent profile.
   Reusing the previous approval digest must be rejected. The digest also includes
   Pi entry bytes, both effective policies, platform and Node version.
8. An unavailable SDK, unsupported platform, denied proxy initialization, or stale
   approval must fail closed. Do not remove `--sandbox-config` to retry the same
   approved execution; local execution is a separate mode/approval.

## Deterministic real OS probe (no model/API key)

First run the unit suite:

```sh
npm run build
node --test dist/tests/sandbox*.test.js dist/tests/harness.test.js dist/tests/agents.test.js
```

The OS test is **skipped unless explicitly enabled**. On macOS, in a system terminal:

```sh
CJHX_SANDBOX_OS_TEST=1 \
CJHX_SANDBOX_TEST_READ_ROOTS=/usr:/bin:/sbin:/System:/Library:/private/etc:/dev:/opt/homebrew \
node --test dist/tests/sandbox-os.test.js
```

Remove nonexistent paths and add only the specific Node toolchain directory if
needed. Do not add the probe's temporary parent or HOME. The probe verifies:

- allowed repository write succeeds;
- sibling probe file read and write are denied and its contents stay unchanged;
- raw public TCP and HTTP to a non-allowlisted host through the proxy are denied;
- trusted Runner completion and cleanup are reported.

A timeout alone is not complete network-enforcement evidence; the proxy 403 check
is required too. This probe does not verify permitted model egress, every OS escape,
Windows enforcement, or cancellation under all workloads. Test those separately
before a production claim. No credentials or real personal files are used.

## Current evidence

Unit coverage checks stale approval, pairing, terminal/delegation exclusion,
configuration validation, fixed checks, policy compilation, malformed execution
results, and no host fallback. The current Pi parent sandbox denies localhost
listening, so the opt-in real probe fails at `runtime-initialize` here; **there is no
passing real-isolation claim**. Full UI/network tests likewise require local binding.
Runner errors expose only fixed stage names, not arbitrary exception text.
