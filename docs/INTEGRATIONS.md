# Integration contracts

## Jira

Implement `JiraAdapter` for issue reads, draft creation, field updates, and transitions. Jira remains authoritative for status and approval. Validate webhook signatures and use idempotency keys.

The task board keeps requirement-decomposition output as `local-draft` tasks until a human-approved publish operation calls `jira.issue.create`. After publication, the task authority becomes `jira`; board status is a synchronized projection from `jira.issue.read`, and status changes call `jira.issue.transition` only with explicit approval. Configure enterprise field mappings for parent key, summary, description, assignee, priority, acceptance criteria, dependencies, and workflow statuses.

## Confluence

Implement `ConfluenceAdapter` for page reads and draft writes. Requirements, use cases, designs, ADRs, and release documents remain authoritative in Confluence. Publishing approved pages should be a separate high-risk operation.

## Source control

Implement the product-neutral `SourceControlAdapter`. The core only depends on repository, branch, commit status, code change request, and review concepts. Product-specific features are optional adapter extensions.

## BoCloud DevOps

Implement `DevOpsAdapter` against the installed BoCloud product/version. Map validation, test result, immutable artifact, environment, deployment, and rollback capabilities. The exact API and webhook surface must be discovered from the deployed edition.

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
