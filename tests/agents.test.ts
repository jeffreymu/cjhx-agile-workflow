import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { AgentService, normalizeAgentResponse, parseAgentUsage } from "../src/agents.js";
import { PolicyDenied } from "../src/errors.js";
import { Workspace } from "../src/storage.js";
import type { Task } from "../src/tasks.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-agents-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = resolve(root, "repo"); mkdirSync(repository); const state = new Workspace(resolve(root, ".cjhx")); state.initialize();
  const script = resolve(root, "fake-agent.mjs");
  writeFileSync(script, `if (process.argv.includes("--version")) { console.log("fake-agent 1.2.3"); process.exit(0); }\nlet input=""; for await (const chunk of process.stdin) input += chunk; console.log(JSON.stringify({cwd:process.cwd(),prompt:process.argv.at(-1),stdin:input}));\n`);
  chmodSync(script, 0o700); const tasks: Task[] = [{ id: "task-1", changeId: "CHANGE-1", workspaceId: "workspace-1", title: "Implement agent support", description: "Add configuration and execution", owner: "dev", priority: "P1", riskLevel: "L2", status: "in_progress", authority: "local-draft", acceptanceCriteria: ["Agent run is recorded"], dependencies: [], evidenceRefs: [], history: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }];
  const service = new AgentService(state, { task: (id) => { const task = tasks.find((item) => item.id === id); if (!task) throw new Error("missing task"); return task; }, workspace: () => ({ id: "workspace-1", kind: "local", rootPath: repository }) });
  return { root, repository, script, state, service };
}

async function waitForRun(service: AgentService, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) { const run = service.getRun(id); if (run.status !== "running") return run; await new Promise((accept) => setTimeout(accept, 10)); }
  throw new Error("agent run did not finish");
}

test("agent profiles test executables, persist privately, and restore the default", async (t) => {
  const { script, state, service } = fixture(t);
  const profile = await service.save({ id: "claude", name: "Claude Code", kind: "claude-code", command: process.execPath, arguments: [script, "{prompt}"], versionArguments: [script, "--version"], promptTransport: "argument", timeoutMinutes: 5, environmentKeys: [] }, { approved: true });
  assert.equal(profile.version, "fake-agent 1.2.3"); assert.equal(profile.default, true); assert.equal(statSync(resolve(state.agents, "config.json")).mode & 0o777, 0o600);
  const restored = new AgentService(state, { task: () => { throw new Error("unused"); }, workspace: () => { throw new Error("unused"); } });
  assert.equal(restored.summary().defaultAgentId, "claude"); assert.equal(restored.summary().profiles[0]?.command, process.execPath);
});

test("agent task execution requires approval and records output in the local workspace", async (t) => {
  const { repository, script, service } = fixture(t);
  await service.save({ id: "codex", name: "Codex", kind: "codex", command: process.execPath, arguments: [script, "{prompt}"], versionArguments: [script, "--version"], promptTransport: "argument", timeoutMinutes: 5, environmentKeys: [] }, { approved: true });
  assert.throws(() => service.startTask("task-1", { approved: false }), PolicyDenied);
  const started = service.startTask("task-1", { approved: true, instructions: "Work test-first" }); const completed = await waitForRun(service, started.id);
  assert.equal(completed.status, "succeeded"); assert.equal(completed.taskId, "task-1"); assert.equal(completed.workspaceId, "workspace-1"); assert.equal(completed.agentId, "codex");
  assert.equal(statSync(resolve(service.storage.agentRuns, `${completed.id}.json`)).mode & 0o777, 0o600); const output = JSON.parse(completed.stdout.trim()) as { cwd: string; prompt: string }; assert.equal(realpathSync(output.cwd), realpathSync(repository)); assert.match(output.prompt, /Implement agent support/); assert.match(output.prompt, /Work test-first/);
});

test("Agent final responses are extracted conservatively and redacted", () => {
  assert.equal(normalizeAgentResponse("progress only", "custom"), undefined);
  assert.equal(normalizeAgentResponse("FINAL RESPONSE: token=abc /Users/name/repo", "custom"), "token=[REDACTED] [LOCAL_PATH]");
  assert.equal(normalizeAgentResponse("native final output", "codex"), "native final output");
});

test("Agent usage accepts strict structured events and rejects unsafe values", () => {
  const usage = parseAgentUsage('CJHX_USAGE:{"source":"provider-reported","inputTokens":120,"outputTokens":30,"cacheReadTokens":10}', "codex"); assert.equal(usage?.source, "provider-reported"); assert.equal(usage?.inputTokens, 120); assert.equal(usage?.outputTokens, 30); assert.equal(usage?.cacheReadTokens, 10); assert.equal(usage?.totalTokens, 150); assert.match(usage?.observedAt ?? "", /^\d{4}-/);
  assert.equal(parseAgentUsage('CJHX_USAGE:{"source":"provider-reported","inputTokens":1,"outputTokens":1}')?.source, "driver-reported");
  assert.throws(() => parseAgentUsage('CJHX_USAGE:{"source":"driver-reported","inputTokens":-1}'), /usage field/);
  assert.throws(() => parseAgentUsage('CJHX_USAGE:{"source":"driver-reported","inputTokens":1,"secret":"x"}'), /unknown fields/);
  assert.throws(() => parseAgentUsage('CJHX_USAGE:{"source":"driver-reported","inputTokens":1,"outputTokens":1,"totalTokens":3}'), /must equal/);
});

test("Agent runs estimate tokens when a provider does not report usage and aggregate by Task", async (t) => {
  const { script, service } = fixture(t); await service.save({ id: "codex", name: "Codex", kind: "codex", command: process.execPath, arguments: [script, "{prompt}"], versionArguments: [script, "--version"], promptTransport: "argument", timeoutMinutes: 5, environmentKeys: [] }, { approved: true }); const completed = await waitForRun(service, service.startTask("task-1", { approved: true }).id); assert.equal(completed.usage?.source, "estimated"); assert.ok((completed.usage?.inputTokens ?? 0) > 0); const summary = service.usageSummary({ kind: "task", id: "task-1" }); assert.equal(summary.runs, 1); assert.ok(summary.estimatedTokens > 0); assert.equal(summary.measuredTokens, 0);
});

test("agent execution rejects virtual workspaces", async (t) => {
  const { script, state } = fixture(t); const task = { id: "task-remote", changeId: "CHANGE-1", workspaceId: "remote", title: "Remote", description: "", owner: "dev", priority: "P2", riskLevel: "L1", status: "todo", authority: "local-draft", acceptanceCriteria: [], dependencies: [], evidenceRefs: [], history: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } as Task;
  const service = new AgentService(state, { task: () => task, workspace: () => ({ id: "remote", kind: "virtual" }) });
  await service.save({ id: "qoder", name: "Qoder", kind: "qoder", command: process.execPath, arguments: [script, "{prompt}"], versionArguments: [script, "--version"], promptTransport: "argument", timeoutMinutes: 5, environmentKeys: [] }, { approved: true });
  assert.throws(() => service.startTask(task.id, { approved: true }), /local Workspace/);
});
