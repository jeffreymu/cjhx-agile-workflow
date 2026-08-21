import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { AgentAssignment, AgentMessage, Collaboration, CollaborationPlanSnapshot, WorktreeLease } from "../src/collaboration.js";
import { ValidationError } from "../src/errors.js";
import { Workspace } from "../src/storage.js";

const now = "2026-08-21T00:00:00.000Z";
function fixture(t: test.TestContext): Workspace { const root = mkdtempSync(resolve(tmpdir(), "cjhx-collaboration-")); t.after(() => rmSync(root, { recursive: true, force: true })); return new Workspace(resolve(root, ".cjhx")); }
function collaboration(): Collaboration { return { schemaVersion: 1, id: "collaboration-1", workspaceId: "workspace-1", changeId: "CHANGE-1", taskId: "task-1", title: "Parallel review", objective: "Implement and review", status: "draft", limits: { maxAssignments: 8, maxDepth: 2, maxParallel: 3, maxMessages: 100, timeoutMinutes: 60 }, usage: { assignments: 0, runningAssignments: 0, messages: 0, tokens: 0 }, createdBy: "owner", createdAt: now, updatedAt: now }; }
function assignment(): AgentAssignment { return { schemaVersion: 1, id: "assignment-1", collaborationId: "collaboration-1", depth: 0, workspaceId: "workspace-1", changeId: "CHANGE-1", taskId: "task-1", agentId: "pi", role: "implementer", objective: "Implement", acceptanceCriteria: ["Tests pass"], mode: "write", dependencyIds: [], status: "proposed", proposedBy: { kind: "human", actor: "owner" }, createdAt: now }; }
function message(): AgentMessage { return { schemaVersion: 1, id: "message-1", collaborationId: "collaboration-1", workspaceId: "workspace-1", changeId: "CHANGE-1", taskId: "task-1", senderAssignmentId: "assignment-1", senderAgentId: "pi", senderRunId: "agent-run-1", recipient: { kind: "coordinator" }, type: "inform", subject: "Ready", body: "Implementation is ready", artifactRefs: [], status: "pending", digest: "sha256:message", createdAt: now }; }

test("collaboration records use private atomic storage", (t) => {
  const storage = fixture(t); storage.initialize(); const record = collaboration(); storage.saveCollaboration(record); assert.deepEqual(storage.getCollaboration(record.id), record); assert.equal(storage.listCollaborations().length, 1);
  const plan: CollaborationPlanSnapshot = { schemaVersion: 1, id: "collaboration-plan-1", digest: "sha256:plan", collaborationId: record.id, workspaceId: record.workspaceId, changeId: record.changeId, taskId: record.taskId, allowedAgentIds: ["pi"], allowedRoles: ["implementer"], limits: record.limits, worktreePolicy: { writersRequireIsolatedWorktree: true, allowReadOnlySharedSnapshot: true, baseRevision: "HEAD", baseCommit: "a".repeat(40), autoMerge: false, autoPush: false }, delegationPolicy: { mode: "plan-bounded", allowAgentDelegation: true, requireAcceptanceCriteria: true, requireKnownAgent: true }, harnessRuleSnapshotDigest: "sha256:rules", createdAt: now }; storage.saveCollaborationPlanSnapshot(plan); assert.deepEqual(storage.getCollaborationPlanSnapshot(plan.id), plan);
  const item = assignment(); storage.saveAgentAssignment(item); assert.deepEqual(storage.getAgentAssignment(item.id), item);
  const lease: WorktreeLease = { schemaVersion: 1, id: "worktree-lease-1", collaborationId: record.id, assignmentId: item.id, workspaceId: record.workspaceId, repositoryRoot: "/repo", path: "/worktree", branch: "cjhx/c1/a1", baseRevision: "HEAD", baseCommit: "abc", status: "active", createdAt: now }; storage.saveWorktreeLease(lease); assert.deepEqual(storage.getWorktreeLease(lease.id), lease);
  for (const directory of [storage.collaborations, storage.collaborationRecords, storage.collaborationPlanSnapshots, storage.collaborationAssignments, storage.collaborationMessages, storage.collaborationCapabilities, storage.collaborationWorktreeLeases]) assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  for (const path of [resolve(storage.collaborationRecords, `${record.id}.json`), resolve(storage.collaborationAssignments, `${item.id}.json`), resolve(storage.collaborationWorktreeLeases, `${lease.id}.json`)]) assert.equal(lstatSync(path).mode & 0o777, 0o600);
});

test("agent messages are immutable-created without lost duplicate writes", (t) => {
  const storage = fixture(t); const value = message(); storage.createAgentMessage(value); assert.deepEqual(storage.getAgentMessage(value.id), value); assert.throws(() => storage.createAgentMessage({ ...value, body: "overwrite" }), /already exists/); assert.throws(() => storage.saveAgentMessage({ ...value, body: "overwrite" }), /immutable content/); storage.saveAgentMessage({ ...value, status: "delivered" }); assert.equal(storage.getAgentMessage(value.id).status, "delivered"); assert.equal(storage.listAgentMessages()[0]?.body, value.body); assert.equal(lstatSync(resolve(storage.collaborationMessages, `${value.id}.json`)).mode & 0o777, 0o600);
});

test("collaboration storage rejects unsafe ids and symbolic-link state directories", (t) => {
  const storage = fixture(t); assert.throws(() => storage.saveCollaboration({ ...collaboration(), id: "../escape" }), ValidationError); storage.initialize(); const target = resolve(storage.root, "outside"); rmSync(storage.collaborationMessages, { recursive: true }); symlinkSync(target, storage.collaborationMessages); assert.throws(() => storage.listAgentMessages(), /symbolic link/); chmodSync(storage.root, 0o700);
});
