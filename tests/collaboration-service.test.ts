import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { CollaborationService } from "../src/collaboration-service.js";
import type { CollaborationCapability } from "../src/collaboration.js";
import { PolicyDenied } from "../src/errors.js";
import { Workspace } from "../src/storage.js";
import type { Task } from "../src/tasks.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-collaboration-service-")); t.after(() => rmSync(root, { recursive: true, force: true })); const storage = new Workspace(resolve(root, ".cjhx")); const task: Task = { id: "task-1", workspaceId: "workspace-1", changeId: "CHANGE-1", title: "Collaborate", description: "", owner: "owner", priority: "P1", riskLevel: "L2", status: "in_progress", authority: "local-draft", acceptanceCriteria: ["Done"], dependencies: [], evidenceRefs: [], history: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }; let harnessDigest = "sha256:rules"; const service = new CollaborationService(storage, { task: () => task, workspace: () => ({ id: "workspace-1", kind: "local", rootPath: root }), agentIds: () => ["pi", "reviewer", "tester"], harnessSnapshotDigest: () => harnessDigest, resolveBaseCommit: () => "a".repeat(40) }); return { storage, service, setHarnessDigest: (value: string) => { harnessDigest = value; } };
}

function running(t: test.TestContext, options: { allowedAgents?: string[]; allowedRoles?: ("coordinator" | "implementer" | "reviewer" | "tester")[]; allowAgentDelegation?: boolean; limits?: { maxAssignments?: number; maxDepth?: number } } = {}) {
  const result = fixture(t); const collaboration = result.service.create({ taskId: "task-1", title: "Parallel delivery", objective: "Implement and review", createdBy: "owner", limits: { maxAssignments: options.limits?.maxAssignments ?? 8, maxDepth: options.limits?.maxDepth ?? 2 } }); const plan = result.service.previewPlan(collaboration.id, { allowedAgentIds: options.allowedAgents ?? ["pi", "reviewer"], allowedRoles: options.allowedRoles ?? ["coordinator", "implementer", "reviewer"], allowAgentDelegation: options.allowAgentDelegation ?? true }); result.service.start(collaboration.id, { approved: true, approvedPlanDigest: plan.digest }); return { ...result, collaboration, plan };
}

test("approved Collaboration plans create bounded human Assignments", (t) => {
  const { service, collaboration, plan } = running(t); assert.match(plan.digest, /^sha256:/); const assignment = service.addAssignment(collaboration.id, { agentId: "pi", role: "implementer", mode: "write", objective: "Implement feature", acceptanceCriteria: ["Tests pass"], actor: "owner" }); assert.equal(assignment.status, "ready"); assert.equal(service.detail(collaboration.id).collaboration.rootAssignmentId, assignment.id); assert.throws(() => service.addAssignment(collaboration.id, { agentId: "tester", role: "tester", mode: "read-only", objective: "Test", acceptanceCriteria: ["Report"], actor: "owner" }), /exceeds approved/);
});

test("human Assignments cannot exceed the approved count", (t) => {
  const { service, collaboration } = running(t, { limits: { maxAssignments: 1 } }); service.addAssignment(collaboration.id, { agentId: "pi", role: "implementer", mode: "write", objective: "Implement", acceptanceCriteria: ["Done"], actor: "owner" }); assert.throws(() => service.addAssignment(collaboration.id, { agentId: "reviewer", role: "reviewer", mode: "read-only", objective: "Review", acceptanceCriteria: ["Reviewed"], actor: "owner" }), /Assignment limit/);
});

test("cancelled Assignments still consume the approved count", (t) => {
  const { storage, service, collaboration } = running(t, { limits: { maxAssignments: 1 } }); const assignment = service.addAssignment(collaboration.id, { agentId: "pi", role: "implementer", mode: "write", objective: "Implement", acceptanceCriteria: ["Done"], actor: "owner" }); assignment.status = "cancelled"; storage.saveAgentAssignment(assignment); assert.throws(() => service.addAssignment(collaboration.id, { agentId: "reviewer", role: "reviewer", mode: "read-only", objective: "Review", acceptanceCriteria: ["Reviewed"], actor: "owner" }), /Assignment limit/);
});

test("approved plan content is digest-verified and snapshots cannot be overwritten", (t) => {
  const { storage, service, collaboration, plan } = running(t); assert.equal(plan.worktreePolicy.baseCommit, "a".repeat(40)); assert.throws(() => storage.saveCollaborationPlanSnapshot(plan), /already exists/); const path = resolve(storage.collaborationPlanSnapshots, `${plan.id}.json`); const tampered = { ...plan, allowedAgentIds: ["tester"] }; writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 }); assert.throws(() => service.addAssignment(collaboration.id, { agentId: "pi", role: "implementer", mode: "write", objective: "Implement", acceptanceCriteria: ["Done"], actor: "owner" }), /digest no longer matches/);
});


test("Agents autonomously delegate only within the approved plan", (t) => {
  const { storage, service, collaboration } = running(t); const parent = service.addAssignment(collaboration.id, { agentId: "pi", role: "implementer", mode: "write", objective: "Implement", acceptanceCriteria: ["Done"], actor: "owner" }); parent.status = "running"; parent.agentRunId = "agent-run-parent"; storage.saveAgentAssignment(parent); const capability: CollaborationCapability = { schemaVersion: 1, id: "capability-1", tokenDigest: "sha256:x", collaborationId: collaboration.id, assignmentId: parent.id, agentId: parent.agentId, runId: parent.agentRunId, permissions: ["assignment.delegate"], expiresAt: "2099-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" };
  const delegated = service.delegate({ capability, assignment: parent }, { agentId: "reviewer", role: "reviewer", mode: "read-only", objective: "Review implementation", acceptanceCriteria: ["Report blocking findings"], dependencyIds: [parent.id] }); assert.equal(delegated.status, "ready"); assert.equal(delegated.parentAssignmentId, parent.id); assert.equal(delegated.depth, 1);
  const outOfPlan = service.delegate({ capability, assignment: parent }, { agentId: "tester", role: "tester", mode: "read-only", objective: "Test implementation", acceptanceCriteria: ["Report results"] }); assert.equal(outOfPlan.status, "awaiting_approval"); assert.match(outOfPlan.policyViolations?.join(" ") ?? "", /not allowed/); assert.throws(() => service.approveAssignment(outOfPlan.id, { approved: true, actor: "owner" }), /revised Collaboration plan/); assert.equal(service.approveAssignment(outOfPlan.id, { approved: false, actor: "owner" }).status, "cancelled");
});

test("delegation fails closed on depth, count, scope, criteria, and stale Harness approval", (t) => {
  const { storage, service, collaboration, setHarnessDigest } = running(t, { limits: { maxAssignments: 3, maxDepth: 1 } }); const parent = service.addAssignment(collaboration.id, { agentId: "pi", role: "implementer", mode: "write", objective: "Implement", acceptanceCriteria: ["Done"], actor: "owner" }); parent.status = "running"; parent.agentRunId = "agent-run-parent"; storage.saveAgentAssignment(parent); const capability: CollaborationCapability = { schemaVersion: 1, id: "capability-1", tokenDigest: "sha256:x", collaborationId: collaboration.id, assignmentId: parent.id, agentId: parent.agentId, runId: parent.agentRunId, permissions: ["assignment.delegate"], expiresAt: "2099-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" };
  assert.throws(() => service.delegate({ capability, assignment: parent }, { agentId: "reviewer", role: "reviewer", mode: "read-only", objective: "Review", acceptanceCriteria: [] }), /acceptance criteria/); const child = service.delegate({ capability, assignment: parent }, { agentId: "reviewer", role: "reviewer", mode: "read-only", objective: "Review", acceptanceCriteria: ["Report"] }); child.status = "running"; child.agentRunId = "agent-run-child"; storage.saveAgentAssignment(child); const childCapability = { ...capability, assignmentId: child.id, agentId: child.agentId, runId: child.agentRunId };
  assert.throws(() => service.delegate({ capability: childCapability, assignment: child }, { agentId: "pi", role: "implementer", mode: "write", objective: "Nested", acceptanceCriteria: ["Done"] }), /depth limit/); assert.throws(() => service.delegate({ capability, assignment: parent }, { agentId: "reviewer", role: "reviewer", mode: "read-only", objective: "Outside dependency", acceptanceCriteria: ["Report"], dependencyIds: ["assignment-outside"] }), /outside the Collaboration/);
  setHarnessDigest("sha256:changed"); assert.throws(() => service.delegate({ capability, assignment: parent }, { agentId: "reviewer", role: "reviewer", mode: "read-only", objective: "Stale plan", acceptanceCriteria: ["Report"] }), PolicyDenied);
});
