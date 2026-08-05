# Integration contracts

## Jira

Implement `JiraAdapter` for issue reads, draft creation, field updates, and transitions. Jira remains authoritative for status and approval. Validate webhook signatures and use idempotency keys.

The task board keeps requirement-decomposition output as `local-draft` tasks until a human-approved publish operation calls `jira.issue.create`. After publication, the task authority becomes `jira`; board status is a synchronized projection from `jira.issue.read`, and status changes call `jira.issue.transition` only with explicit approval. Configure enterprise field mappings for parent key, summary, description, assignee, priority, acceptance criteria, dependencies, and workflow statuses.

### UI-configurable Jira HTTP Gateway

The local UI can test, save, update, and remove a Jira Gateway configuration without restarting CJHX. The standard Gateway contract is:

```text
GET   /health
GET   /issues/{key}
POST  /issues
PATCH /issues/{key}
POST  /issues/{key}/transitions
```

Endpoints return JSON objects. Issue creation receives configured `projectKey` and `issueType` defaults in addition to CJHX task fields. Authentication supports Bearer, Basic (a pre-encoded Base64 credential), a configurable API-key header, or no authentication for an already protected internal Gateway.

The workspace stores configuration at `.cjhx/integrations/jira.json` with mode `0600`. Credentials are never returned by UI APIs. Production URLs require HTTPS, redirects are rejected, timeouts are bounded to 1–60 seconds, and responses are capped at 1 MB. A saved configuration dynamically replaces the current Jira Adapter, so task publication and status synchronization use it immediately.

## Confluence

Implement `ConfluenceAdapter` for page reads and draft writes. Requirements, use cases, designs, ADRs, and release documents remain authoritative in Confluence. Publishing approved pages should be a separate high-risk operation.

## Source control

Implement the product-neutral `SourceControlAdapter`. The core only depends on repository, branch, commit status, code change request, and review concepts. Product-specific features are optional adapter extensions.

### UI-configurable GitLab and GitHub Adapters

The local Integration Settings page can independently save GitLab and GitHub configurations. Both may coexist, but exactly one workspace-backed provider is active at a time and supplies the framework's platform-neutral `SourceControlAdapter`. Saving a provider makes it active; a separately saved provider can later be activated without entering its credential again. The active provider is recorded in `.cjhx/integrations/source-control.json`.

GitLab configuration supports:

- Base URL and API path (`/api/v4` by default);
- Private Token, Bearer Token, Job Token, or no authentication;
- an optional default project ID;
- repository reads, branch creation, Merge Request creation, and commit status publication.

GitHub configuration supports:

- GitHub.com or GitHub Enterprise Base URL and API path;
- Bearer, Token, or no authentication;
- an optional default `owner/repository`;
- configurable GitHub API version;
- repository reads, branch creation, Pull Request creation, and commit status publication.

The same saved providers supply virtual Workspace browsing extensions. GitLab maps projects, repository tree/files, branches/tags, commits/statuses/diffs, issues, Merge Requests, and notes. GitHub maps repositories, contents, branches/tags, commits/statuses, issues, Pull Requests, general comments, and review comments. Importing a virtual Workspace stores only provider/repository/ref metadata under `.cjhx/workspaces/`; browse results remain live projections and are not persisted.

Credentials are stored separately at `.cjhx/integrations/gitlab.json` and `.cjhx/integrations/github.json` with mode `0600`; UI responses expose only `credentialConfigured`. Production URLs require HTTPS, redirects are rejected, timeouts are bounded to 1–60 seconds, and responses are capped at 1 MB. Product names remain confined to these Adapter implementations and UI configuration; lifecycle and Skill contracts continue to use `SourceControlAdapter` and `scm.*` tools.

## DevOps platform

Implement `DevOpsAdapter` against the installed enterprise product/version. Map validation, test result, immutable artifact, environment, deployment, and rollback capabilities. The exact API and webhook surface must be discovered from the deployed edition.

The local control surface exposes a platform-neutral DevOps projection for:

- pipeline definitions and current health;
- recent CI/CD runs and status;
- immutable artifacts and versions;
- deployed services, environments, versions, and running state.

It can trigger CI/CD pipelines and start, stop, or restart services. Every write requires an explicit approval flag plus actor and reason; `DevOpsService` rejects unapproved writes before invoking `ToolBroker`. When no Adapter is configured, the UI shows the capability as unavailable and never simulates success. Read data is refreshed from the configured DevOps platform and is not persisted as a second source of truth.

Production Adapter implementations must map `listPipelines`, `listPipelineRuns`, `listArtifacts`, `listServices`, `triggerPipeline`, and `controlService` to the installed DevOps edition. Restrict pipeline, environment, and service access by enterprise identity and policy in addition to the local confirmation gate.

### UI-configurable HTTP Gateway

The local UI can configure a standard HTTP Gateway without restarting CJHX. The Gateway must expose:

```text
GET  /health
GET  /pipelines?changeId=...
GET  /pipeline-runs?changeId=...
GET  /artifacts?changeId=...
GET  /services?changeId=...
POST /pipelines/{pipelineId}/runs
POST /services/{serviceId}/actions
POST /validations
GET  /validations/{runId}
POST /artifacts/build
POST /deployments
GET  /deployments/{deploymentId}
```

List endpoints return JSON arrays; all other endpoints return JSON objects. The optional project and tenant values are sent as `X-CJHX-Project-ID` and `X-CJHX-Tenant-ID`. Authentication can use a Bearer token, a configurable API-key header, or no authentication for an already protected internal Gateway.

The workspace stores this configuration at `.cjhx/integrations/devops.json` with mode `0600`. Credentials are never returned by UI APIs; summaries expose only `credentialConfigured`. Production URLs require HTTPS, redirects are rejected, request timeouts are bounded to 1–60 seconds, and responses are capped at 1 MB. Use an enterprise secret manager instead of file-backed credentials for shared deployments.

## Observability

`ObservabilityAdapter` is reserved. Until configured, deployment observation is a Jira-owned manual task. Later implementations can provide deployment health and related incidents without changing the lifecycle state machine.

## Event envelope

All adapters should emit/consume an envelope like:

```json
{
  "eventId": "evt-123",
  "eventType": "devops.validation.completed",
  "source": "devops",
  "changeId": "PAY-128",
  "correlationId": "corr-456",
  "occurredAt": "2025-03-08T10:00:00Z",
  "payloadRef": "artifact://events/evt-123"
}
```

Use `eventId` and `correlationId` to deduplicate updates and prevent Jira/Confluence synchronization loops.
