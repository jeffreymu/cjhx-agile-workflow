# v0.18.0 — Experimental Sandbox (Pre-release)

This is a GitHub **pre-release**, not a production-ready isolation release.
Package version: `0.18.0`. No npm registry publication is implied.

## Changes

- Optional pinned Anthropic sandbox-runtime 0.0.80 integration with a separate IPC Runner.
- Paired Pi Agent and Harness Postflight execution; failures never fall back to host execution.
- Literal filesystem policies, private HOME/temp, explicit model hosts and credential-variable allowlist; network-free Postflight.
- Approval binding for effective policies, administrator configuration, Pi entry bytes, profile, Node and platform.
- Existing UI shows backend limitations, permission approval and trusted Runner/cleanup status.
- Injectable Harness check executor with bounded outputs and sanitized errors.
- Configuration and real OS probe instructions in [SANDBOX.md](SANDBOX.md).

## Known limitations

- Actual macOS/Linux isolation is **not acceptance validated**. The current execution environment blocks Runner proxy initialization.
- Windows execution is explicitly blocked pending process-tree cleanup verification.
- Custom provider `huaAI/gpt-6.1-sol` is not yet usable through private Runner provider configuration; global Pi configuration is deliberately not inherited.
- Administrator JSON is manual; there is no UI policy editor or enable/disable switch.
- Interactive terminals, Worktree delegation, arbitrary MCP and global/project extensions are excluded.
- Transitive node-forge dependency has a high-severity audit advisory; this is not an audit-clean release.

## Validation

`npm run check` was executed before release preparation:

- TypeScript checks and build passed.
- 165 tests: 130 passed, 34 failed, 1 skipped.
- All 34 failures report `listen EPERM` on local loopback in the current parent sandbox.
- The real OS test is opt-in and skipped in the standard suite. An explicit prior invocation failed closed at `runtime-initialize`.
- Focused Agent/Harness/Sandbox unit suite: 33 passed; OS probe skipped.

These results do not constitute a full passing suite or real OS isolation certification.
Local administrator configuration, credentials, generated logs and `.pi/` files are excluded from source publication.
