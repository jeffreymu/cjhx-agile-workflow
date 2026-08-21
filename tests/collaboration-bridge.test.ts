import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { CollaborationBridge, CollaborationMessageService } from "../src/collaboration-bridge.js";
import type { AgentAssignment, Collaboration } from "../src/collaboration.js";
import { PolicyDenied } from "../src/errors.js";
import { Workspace } from "../src/storage.js";

const now = "2026-08-21T00:00:00.000Z";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-collaboration-bridge-")); t.after(() => rmSync(root, { recursive: true, force: true })); const storage = new Workspace(resolve(root, ".cjhx"));
  const collaboration: Collaboration = { schemaVersion: 1, id: "collaboration-1", workspaceId: "workspace-1", changeId: "CHANGE-1", taskId: "task-1", title: "Agent collaboration", objective: "Coordinate work", status: "running", limits: { maxAssignments: 8, maxDepth: 2, maxParallel: 3, maxMessages: 5, timeoutMinutes: 60 }, usage: { assignments: 2, runningAssignments: 2, messages: 0, tokens: 0 }, createdBy: "owner", createdAt: now, updatedAt: now };
  const sender: AgentAssignment = { schemaVersion: 1, id: "assignment-sender", collaborationId: collaboration.id, depth: 0, workspaceId: collaboration.workspaceId, changeId: collaboration.changeId, taskId: collaboration.taskId, agentId: "pi", role: "implementer", objective: "Implement", acceptanceCriteria: ["Implementation complete"], mode: "write", dependencyIds: [], status: "running", agentRunId: "agent-run-sender", proposedBy: { kind: "human", actor: "owner" }, createdAt: now, startedAt: now };
  const receiver: AgentAssignment = { schemaVersion: 1, id: "assignment-receiver", collaborationId: collaboration.id, depth: 0, workspaceId: collaboration.workspaceId, changeId: collaboration.changeId, taskId: collaboration.taskId, agentId: "reviewer", role: "coordinator", objective: "Review", acceptanceCriteria: ["Review complete"], mode: "read-only", dependencyIds: [], status: "running", agentRunId: "agent-run-receiver", proposedBy: { kind: "human", actor: "owner" }, createdAt: now, startedAt: now };
  storage.saveCollaboration(collaboration); storage.saveAgentAssignment(sender); storage.saveAgentAssignment(receiver); const service = new CollaborationMessageService(storage); return { storage, service, sender, receiver };
}

function auth(token: string): Record<string, string> { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }

test("Assignment capabilities exchange immutable scoped Agent messages", (t) => {
  const { storage, service, sender, receiver } = fixture(t); const senderCapability = service.issueCapability({ assignmentId: sender.id, runId: sender.agentRunId!, permissions: ["message.send", "message.read-own"] }); const receiverCapability = service.issueCapability({ assignmentId: receiver.id, runId: receiver.agentRunId!, permissions: ["message.send", "message.read-own"] });
  const sent = service.send(senderCapability.token, { recipient: { kind: "assignment", id: receiver.id }, type: "request", subject: "Review implementation", body: "api_key=secret-value Please inspect the patch" }); assert.equal(sent.body, "api_key=[REDACTED] Please inspect the patch"); assert.equal(service.inbox(senderCapability.token).length, 0); const inbox = service.inbox(receiverCapability.token); assert.equal(inbox.length, 1); assert.equal(inbox[0]?.status, "delivered"); const consumed = service.consume(receiverCapability.token, sent.id); assert.equal(consumed.status, "consumed"); assert.ok(consumed.consumedAt); assert.throws(() => service.consume(senderCapability.token, sent.id), PolicyDenied); assert.equal(storage.getAgentMessage(sent.id).digest, sent.digest); assert.equal(storage.getCollaboration(sender.collaborationId).usage.messages, 1);
  service.revoke(receiverCapability.id); assert.throws(() => service.inbox(receiverCapability.token), /expired, revoked, or insufficient/);
});

test("Collaboration Bridge is loopback-only and capability protected", async (t) => {
  const { service, sender, receiver } = fixture(t); const senderCapability = service.issueCapability({ assignmentId: sender.id, runId: sender.agentRunId!, permissions: ["message.send", "message.read-own"] }); const receiverCapability = service.issueCapability({ assignmentId: receiver.id, runId: receiver.agentRunId!, permissions: ["message.read-own"] }); const bridge = new CollaborationBridge(service); const address = await bridge.listen(); t.after(() => bridge.close()); assert.equal(address.host, "127.0.0.1");
  let response = await fetch(`${address.url}/v1/messages`, { method: "POST", headers: auth(senderCapability.token), body: JSON.stringify({ recipient: { kind: "assignment", id: receiver.id }, type: "handoff", subject: "Handoff", body: "Ready for review" }) }); assert.equal(response.status, 201); const message = await response.json() as { id: string };
  response = await fetch(`${address.url}/v1/inbox`, { headers: { authorization: `Bearer ${receiverCapability.token}` } }); assert.equal(response.status, 200); assert.equal((await response.json() as unknown[]).length, 1);
  response = await fetch(`${address.url}/v1/messages/${message.id}/consume`, { method: "POST", headers: auth(receiverCapability.token), body: "{}" }); assert.equal(response.status, 200);
  response = await fetch(`${address.url}/v1/inbox`); assert.equal(response.status, 403);
});

test("messages cannot cross Collaboration scope or outlive an active Assignment", (t) => {
  const { service, sender } = fixture(t); const capability = service.issueCapability({ assignmentId: sender.id, runId: sender.agentRunId!, permissions: ["message.send", "message.read-own"] }); assert.throws(() => service.send(capability.token, { recipient: { kind: "assignment", id: "assignment-outside" }, type: "inform", subject: "Cross scope", body: "No" }), /outside the Collaboration/); sender.status = "succeeded"; service.storage.saveAgentAssignment(sender); assert.throws(() => service.inbox(capability.token), /no longer matches an active Assignment/);
});
