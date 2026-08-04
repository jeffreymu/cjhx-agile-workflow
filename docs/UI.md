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
8. viewing Skill and Workflow execution records and errors.

## Security boundary

The built-in UI is a local SDK/MVP control surface, not an internet-facing enterprise gateway.

- The server only accepts `127.0.0.1`, `::1`, or `localhost` bindings and rejects non-loopback `Host` headers to prevent DNS rebinding.
- A random per-process token is embedded in the initial HTML and required in `X-CJHX-UI-Token` for every mutation.
- Responses use a restrictive Content Security Policy, deny framing, disable caching for state, and set `X-Content-Type-Options: nosniff`.
- Request bodies are limited to 1 MB.
- The UI cannot skip lifecycle evidence gates.
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
