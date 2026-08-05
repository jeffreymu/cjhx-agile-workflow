import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { AgentService } from "../src/agents.js";
import { ConversationService } from "../src/conversations.js";
import { PolicyDenied } from "../src/errors.js";
import { MemoryService } from "../src/memory.js";
import { Workspace } from "../src/storage.js";
import type { Task } from "../src/tasks.js";

async function waitForTurn(service: ConversationService, sessionId: string, turnId: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const turn = service.getSession(sessionId).turns.find((item) => item.id === turnId);
    if (turn?.status !== "running") return turn;
    await new Promise((accept) => setTimeout(accept, 10));
  }
  throw new Error("turn did not finish");
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-conversations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = resolve(root, "repo"); mkdirSync(repository);
  const script = resolve(root, "agent.mjs");
  writeFileSync(script, `if(process.argv.includes("--version")){console.log("agent 1.0");process.exit(0)}\nconst prompt=process.argv.at(-1)||"";console.log("FINAL RESPONSE: handled "+(prompt.includes("Current-session turn")?"continued":"initial"));`);
  chmodSync(script, 0o700);
  const storage = new Workspace(resolve(root, ".cjhx")); storage.initialize();
  const task: Task = { id: "task-1", changeId: "CHANGE-1", workspaceId: "workspace-1", title: "Build conversation memory", description: "Keep task conversations continuous", owner: "dev", priority: "P1", riskLevel: "L2", status: "in_progress", authority: "local-draft", acceptanceCriteria: ["Resume after restart"], dependencies: [], evidenceRefs: [], history: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const dependencies = { task: () => task, workspace: () => ({ id: "workspace-1", kind: "local" as const, rootPath: repository }) };
  const agents = new AgentService(storage, dependencies);
  const memory = new MemoryService(storage, { task: () => task, change: (id) => ({ id }), workspace: (id) => ({ id }) });
  const conversations = new ConversationService(storage, { task: () => task, agents, memory });
  return { root, repository, script, storage, task, agents, memory, conversations };
}

test("a task session persists and continues with bounded prior turns across agent profiles", async (t) => {
  const { script, storage, task, agents, memory, conversations } = fixture(t);
  for (const id of ["alpha", "beta"]) await agents.save({ id, name: id, kind: "custom", command: process.execPath, arguments: [script, "{prompt}"], versionArguments: [script, "--version"], promptTransport: "argument", timeoutMinutes: 5, environmentKeys: [] }, { approved: true });
  const session = conversations.createSession({ taskId: task.id, title: "Implementation", actor: "owner" });
  const firstPreview = conversations.previewTurn(session.id, { userMessage: "Create the first answer", agentId: "alpha" });
  assert.equal(firstPreview.executionContext.userMessage, "Create the first answer");
  assert.equal(firstPreview.executionContext.task.title, task.title);
  assert.equal(firstPreview.executionContext.agentProfile.id, "alpha");
  assert.equal(firstPreview.executionContext.memorySnapshot.renderedContext, firstPreview.memorySnapshot.renderedContext);
  assert.match(firstPreview.executionContext.renderedPrompt, /Create the first answer/);
  const first = conversations.startTurn(session.id, { userMessage: "Create the first answer", agentId: "alpha", approved: true, approvedContextDigest: firstPreview.executionContext.digest });
  const completedFirst = await waitForTurn(conversations, session.id, first.id);
  assert.equal(completedFirst?.status, "succeeded");
  assert.match(completedFirst?.assistantResponse ?? "", /handled initial/);

  const restoredAgents = new AgentService(storage, { task: () => task, workspace: () => ({ id: "workspace-1", kind: "local", rootPath: resolve(storage.root, "../repo") }) });
  const restoredMemory = new MemoryService(storage, { task: () => task, change: (id) => ({ id }), workspace: (id) => ({ id }) });
  const restored = new ConversationService(storage, { task: () => task, agents: restoredAgents, memory: restoredMemory });
  const secondPreview = restored.previewTurn(session.id, { userMessage: "Continue from the first answer", agentId: "beta" });
  assert.match(secondPreview.memorySnapshot.renderedContext, /Create the first answer/);
  assert.match(secondPreview.memorySnapshot.renderedContext, /handled initial/);
  const second = restored.startTurn(session.id, { userMessage: "Continue from the first answer", agentId: "beta", approved: true, approvedContextDigest: secondPreview.executionContext.digest });
  const completedSecond = await waitForTurn(restored, session.id, second.id);
  assert.equal(completedSecond?.agentId, "beta");
  assert.equal(restored.getSession(session.id).turns.length, 2);
  assert.equal(statSync(resolve(storage.agentSessions, `${session.id}.json`)).mode & 0o777, 0o600);
  assert.equal(statSync(resolve(storage.agentTurns, session.id, "000001.json")).mode & 0o777, 0o600);
});

test("restart fails closed an in-flight Turn even when the orphan process is still alive", async (t) => {
  const { root, storage, task, agents, memory, conversations } = fixture(t); const slow = resolve(root, "slow-agent.mjs"); writeFileSync(slow, `if(process.argv.includes("--version")){console.log("agent 1.0");process.exit(0)} setTimeout(()=>console.log("FINAL RESPONSE: too late"),350);`); chmodSync(slow, 0o700);
  await agents.save({ id: "slow", name: "slow", kind: "custom", command: process.execPath, arguments: [slow, "{prompt}"], versionArguments: [slow, "--version"], promptTransport: "argument", timeoutMinutes: 5, environmentKeys: [] }, { approved: true });
  const session = conversations.createSession({ taskId: task.id, title: "Recovery", actor: "owner" }); const preview = conversations.previewTurn(session.id, { userMessage: "Start slow work", agentId: "slow" }); const running = conversations.startTurn(session.id, { userMessage: "Start slow work", agentId: "slow", approved: true, approvedContextDigest: preview.executionContext.digest }); assert.equal(running.status, "running");
  const restoredAgents = new AgentService(storage, { task: () => task, workspace: () => ({ id: "workspace-1", kind: "local", rootPath: resolve(storage.root, "../repo") }) }); const restored = new ConversationService(storage, { task: () => task, agents: restoredAgents, memory });
  assert.equal(restored.getSession(session.id).turns[0]?.status, "failed"); assert.doesNotThrow(() => restored.previewTurn(session.id, { userMessage: "Continue safely", agentId: "slow" }));
  await new Promise((accept) => setTimeout(accept, 450)); assert.equal(restored.getSession(session.id).turns[0]?.status, "failed"); assert.equal(restoredAgents.getRun(running.agentRunId!).status, "failed");
});

test("turn approval is invalidated when recalled memory changes", async (t) => {
  const { script, task, agents, memory, conversations } = fixture(t);
  await agents.save({ id: "alpha", name: "alpha", kind: "custom", command: process.execPath, arguments: [script, "{prompt}"], versionArguments: [script, "--version"], promptTransport: "argument", timeoutMinutes: 5, environmentKeys: [] }, { approved: true });
  const session = conversations.createSession({ taskId: task.id, title: "Approval", actor: "owner" });
  const preview = conversations.previewTurn(session.id, { userMessage: "Implement it", agentId: "alpha" });
  memory.remember({ scope: { kind: "task", id: task.id }, kind: "constraint", content: "Use a different approach.", importance: 5, pinned: true, sensitivity: "internal", sourceRefs: [{ type: "task", id: task.id }], actor: "owner" });
  assert.throws(() => conversations.startTurn(session.id, { userMessage: "Implement it", agentId: "alpha", approved: true, approvedContextDigest: preview.executionContext.digest }), PolicyDenied);
});

test("sessions reject cross-task scope changes and unapproved execution", async (t) => {
  const { script, task, agents, conversations } = fixture(t);
  await agents.save({ id: "alpha", name: "alpha", kind: "custom", command: process.execPath, arguments: [script, "{prompt}"], versionArguments: [script, "--version"], promptTransport: "argument", timeoutMinutes: 5, environmentKeys: [] }, { approved: true });
  const session = conversations.createSession({ taskId: task.id, title: "Guardrails", actor: "owner" });
  const preview = conversations.previewTurn(session.id, { userMessage: "Run", agentId: "alpha" });
  assert.throws(() => conversations.startTurn(session.id, { userMessage: "Run", agentId: "alpha", approved: false, approvedContextDigest: preview.executionContext.digest }), PolicyDenied);
});
