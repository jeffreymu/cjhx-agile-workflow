# Conversation and memory

CJHX provides governed, task-scoped conversation continuity for local development Agents.

## Domain boundaries

The implementation keeps three facts separate:

1. `AgentSession` and `AgentTurn` record the conversation timeline.
2. `MemoryRecord` stores explicit reusable knowledge confirmed by a user.
3. `MemorySnapshot` and `ExecutionContextSnapshot` record the exact context approved for one execution.

Memory is historical reference data. It is not an authority for work-item status, requirements, verification, deployment, Policy, Harness rules, or Skill permissions. It cannot satisfy lifecycle or Harness evidence gates.

## Conversation flow

```text
Task
  → AgentSession
  → preview Turn
  → bounded recall
  → immutable MemorySnapshot
  → immutable ExecutionContextSnapshot
  → human approval
  → AgentRun
  → AgentTurn result
  → continue with any configured Agent
```

A Session is fixed to one Workspace, Change, and Task, but not to one Agent product. CJHX can therefore continue the same conversation using another configured Agent.

Each Turn stores:

- the user message;
- the selected Agent profile;
- the linked AgentRun;
- a bounded normalized final response when one can be identified safely;
- the MemorySnapshot and execution-context digests;
- independent process status.

AgentRun remains authoritative for process output, exit status, Harness compliance, and compliance reports.

## Recall policy

Every preview applies scope filtering before ranking. Legal durable-memory scopes are:

```text
current Task
current Change
current Workspace
```

No cross-Workspace recall is allowed.

Default limits:

```text
recent current-session Turns: 6
prior Sessions for the same Task: 3
recalled Memory Records: 8
characters per Memory Record: 1000
rendered historical context: 6000
```

Ranking combines scope, importance, pinning, lexical overlap, and freshness. The baseline requires no model or vector database and supports ordinary word tokens plus CJK character bigrams.

Historical context is rendered with an explicit boundary stating that it is untrusted reference data and not an instruction source. Policy, Harness, current authoritative task facts, enabled Skills, and the current user request take precedence.

## Durable memory

MVP memory kinds are:

```text
decision
constraint
preference
lesson
open-question
```

Only an explicit user-confirmed action creates an active record. The supported lifecycle is:

```text
remember
correct → previous record becomes superseded
forget → record exits recall but remains auditable
pin / unpin
```

Every record requires source references. A correction creates a new record and retains the old version. Forgotten and superseded records are excluded from recall.

## Approval integrity

A Turn preview creates an immutable `ExecutionContextSnapshot` whose digest covers:

- Task identity and current Task content;
- selected Agent profile;
- Harness RuleSnapshot;
- MemorySnapshot;
- additional instructions;
- current user message;
- the fully rendered Agent Prompt.

The snapshot stores both the digests and the bounded values that were actually approved: Task facts, the selected Agent profile, Harness RuleSnapshot when enabled, the complete MemorySnapshot, current input, additional instructions, and the fully rendered Prompt. Starting the Turn recompiles the context. If memory, Task content, Harness rules, Agent configuration, enabled Skill context, or rendered Prompt changed after preview, the old approval is rejected.

## Private storage

```text
.cjhx/
└── memory/
    ├── sessions/
    ├── turns/
    │   └── <session-id>/
    ├── records/
    ├── snapshots/
    └── execution-contexts/
```

All files use atomic writes and mode `0600`. New Turn sequence files use an atomic exclusive create so concurrent CJHX instances cannot silently overwrite the same Turn. Corrected memories are recoverable if the process stops between writing the replacement and marking the prior record superseded. On restart, Agent runs owned by another CJHX process instance fail closed and interrupted Sessions are unblocked; an orphan process cannot later overwrite the recovered failed state. Workspace code browsing cannot enter `.cjhx`. Token-protected APIs are required to read conversation history, memory records, and snapshots.

## CLI

```bash
cjhx session-start --task TASK_ID --actor OWNER --title "Implementation"
cjhx session-list --task TASK_ID
cjhx session-show SESSION_ID

cjhx session-preview SESSION_ID \
  --message "Continue the implementation" \
  --agent-id codex

cjhx session-continue SESSION_ID \
  --message "Continue the implementation" \
  --agent-id codex \
  --context-digest sha256:... \
  --approved

cjhx memory-list --task TASK_ID

cjhx memory-remember \
  --scope task \
  --scope-id TASK_ID \
  --kind decision \
  --content "Keep the compatibility facade." \
  --actor OWNER \
  --source-type task \
  --source-id TASK_ID \
  --importance 4 \
  --pinned

cjhx memory-correct MEMORY_ID \
  --content "Keep the facade until the next major release." \
  --actor OWNER \
  --source-type task \
  --source-id TASK_ID

cjhx memory-forget MEMORY_ID --actor OWNER --reason "No longer applicable"
```

## Local Web API

All endpoints below require `X-CJHX-UI-Token`.

```text
POST /api/agent-sessions
GET  /api/agent-sessions?workspaceId=&changeId=&taskId=
GET  /api/agent-sessions/:id
POST /api/agent-sessions/:id/archive
POST /api/agent-sessions/:id/turns/preview
POST /api/agent-sessions/:id/turns

GET  /api/memories?workspaceId=&changeId=&taskId=
POST /api/memories
POST /api/memories/:id/supersede
POST /api/memories/:id/forget
POST /api/memories/:id/pin

GET  /api/memory-snapshots/:id
GET  /api/execution-contexts/:id
```

## Current boundary

The MVP does not automatically generate durable memory, use embeddings, infer personas, share memory across Workspaces, or treat provider-native session state as canonical. Those capabilities can be added behind the current service interfaces without changing the governance model.
