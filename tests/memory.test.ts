import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { MemoryService } from "../src/memory.js";
import { Workspace } from "../src/storage.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new Workspace(resolve(root, ".cjhx"));
  storage.initialize();
  const tasks = new Map([
    ["task-1", { id: "task-1", changeId: "CHANGE-1", workspaceId: "workspace-1", title: "Implement sessions", description: "", acceptanceCriteria: ["History is bounded"] }],
    ["task-2", { id: "task-2", changeId: "CHANGE-2", workspaceId: "workspace-2", title: "Other task", description: "", acceptanceCriteria: [] }],
  ]);
  const service = new MemoryService(storage, {
    task: (id) => {
      const task = tasks.get(id);
      if (!task) throw new Error(`missing task: ${id}`);
      return task;
    },
    change: (id) => ({ id }),
    workspace: (id) => ({ id }),
  });
  return { storage, service };
}

test("memory records are explicit, private, correctable, and forgettable", (t) => {
  const { storage, service } = fixture(t);
  const remembered = service.remember({
    scope: { kind: "task", id: "task-1" },
    kind: "decision",
    content: "Keep conversation history bounded.",
    importance: 5,
    pinned: true,
    sensitivity: "internal",
    sourceRefs: [{ type: "task", id: "task-1" }],
    actor: "owner",
  });
  assert.equal(remembered.origin, "user-confirmed");
  assert.equal(statSync(resolve(storage.memoryRecords, `${remembered.id}.json`)).mode & 0o777, 0o600);

  const corrected = service.supersede(remembered.id, {
    content: "Keep the six most recent conversation turns.",
    actor: "owner",
    sourceRefs: [{ type: "task", id: "task-1" }],
  });
  assert.equal(corrected.supersedesId, remembered.id);
  assert.equal(service.get(remembered.id).status, "superseded");
  assert.deepEqual(service.list({ taskId: "task-1", status: "active" }).map((item) => item.id), [corrected.id]);

  const forgotten = service.forget(corrected.id, { actor: "owner", reason: "No longer applicable" });
  assert.equal(forgotten.status, "forgotten");
  assert.deepEqual(service.list({ taskId: "task-1", status: "active" }), []);
});

test("a rejected correction leaves the active memory unchanged", (t) => {
  const { service } = fixture(t);
  const remembered = service.remember({ scope: { kind: "task", id: "task-1" }, kind: "decision", content: "Keep the compatibility layer.", sourceRefs: [{ type: "task", id: "task-1" }], actor: "owner" });
  assert.throws(() => service.supersede(remembered.id, { content: "", actor: "owner", sourceRefs: [{ type: "task", id: "task-1" }] }), /content is required/);
  assert.equal(service.get(remembered.id).status, "active");
});

test("an interrupted correction is reconciled on restart", (t) => {
  const { storage, service } = fixture(t); const remembered = service.remember({ scope: { kind: "task", id: "task-1" }, kind: "decision", content: "Use the original plan.", sourceRefs: [{ type: "task", id: "task-1" }], actor: "owner" }); const now = new Date().toISOString();
  storage.saveMemoryRecord({ ...remembered, id: "memory-replacement", content: "Use the corrected plan.", supersedesId: remembered.id, createdAt: now, updatedAt: now });
  new MemoryService(storage, { task: (id) => ({ id, changeId: "CHANGE-1", workspaceId: "workspace-1" }), change: (id) => ({ id }), workspace: (id) => ({ id }) });
  assert.equal(storage.getMemoryRecord(remembered.id).status, "superseded"); assert.equal(storage.getMemoryRecord("memory-replacement").status, "active");
});

test("recall is scope-isolated, bounded, and marks history as non-instructional", (t) => {
  const { service } = fixture(t);
  const relevant = service.remember({ scope: { kind: "task", id: "task-1" }, kind: "constraint", content: "Never replay more than six turns.", importance: 5, pinned: true, sensitivity: "internal", sourceRefs: [{ type: "task", id: "task-1" }], actor: "owner" });
  service.remember({ scope: { kind: "task", id: "task-2" }, kind: "constraint", content: "Secret from another workspace.", importance: 5, pinned: true, sensitivity: "confidential", sourceRefs: [{ type: "task", id: "task-2" }], actor: "owner" });

  const snapshot = service.recall({ sessionId: "session-1", taskId: "task-1", query: "conversation turns", recentTurns: [], priorSessionOutcomes: [] });
  assert.deepEqual(snapshot.selectedMemoryIds, [relevant.id]);
  assert.match(snapshot.renderedContext, /untrusted reference data/i);
  assert.match(snapshot.renderedContext, /Never replay more than six turns/);
  assert.doesNotMatch(snapshot.renderedContext, /another workspace/);
  assert.match(snapshot.digest, /^sha256:/);
  assert.ok(snapshot.characterCount <= 6_000);
});
