import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { AgentService } from "../src/agents.js";
import { CJHXFramework } from "../src/framework.js";
import { HarnessService } from "../src/harness.js";
import { Workspace } from "../src/storage.js";
import type { Task } from "../src/tasks.js";
import { SandboxExecutor } from "../src/sandbox/executor.js";
import { validateSandboxConfig, sandboxBinding } from "../src/sandbox/config.js";

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "cjhx-srt-test-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = resolve(root, "repo"); mkdirSync(repo);
  const entry = resolve(root, "pi.mjs"); writeFileSync(entry, "console.log('mock Pi');");
  const config = validateSandboxConfig({ schemaVersion: 1, piEntry: entry, model: "anthropic/test", credentialKeys: ["ANTHROPIC_API_KEY"], readRoots: [root], modelHosts: ["api.anthropic.com"] });
  const storage = new Workspace(resolve(root, "state")); storage.initialize();
  const task: Task = { id: "task-1", changeId: "change-1", workspaceId: "ws-1", title: "Sandbox", description: "", owner: "owner", status: "todo", authority: "local-draft", priority: "P2", riskLevel: "L1", acceptanceCriteria: [], dependencies: [], evidenceRefs: [], history: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  const dependencies = { task: () => task, workspace: () => ({ id: "ws-1", kind: "local" as const, rootPath: repo }) };
  const harness = new HarnessService(storage, dependencies);
  const executor = new SandboxExecutor(config, storage.root);
  storage.saveAgentConfig({ schemaVersion: 1, defaultAgentId: "pi", profiles: [{ id: "pi", name: "Pi", kind: "pi", command: process.execPath, arguments: [], versionArguments: ["--version"], promptTransport: "stdin", timeoutMinutes: 1, environmentKeys: ["ANTHROPIC_API_KEY"], default: true, testedAt: "2026-01-01" }] });
  const agents = new AgentService(storage, { ...dependencies, harness, executor });
  return { root, repo, config, entry, storage, executor, harness, agents };
}

test("Sandbox approval binds both policies, profile, model and Pi entry bytes before any launch", t => {
  const { agents, config, entry } = fixture(t);
  const preview = agents.harnessPreview("task-1");
  assert.ok(preview.sandbox); assert.deepEqual(preview.sandbox.postflight.allowedHosts, []);
  assert.throws(() => agents.startTask("task-1", { approved: true }), /approval.*missing or stale/);
  const before = preview.sandbox.approvalDigest;
  assert.notEqual(sandboxBinding({ ...config, model: "anthropic/other" }, [preview.sandbox.agent, preview.sandbox.postflight], "profile"), before);
  writeFileSync(entry, "console.log('changed');");
  assert.notEqual(agents.harnessPreview("task-1").sandbox!.approvalDigest, before);
  assert.throws(() => agents.startTask("task-1", { approved: true, approvedSandboxDigest: before }), /stale/);
  assert.equal(agents.listRuns().length, 0);
});

test("Sandbox pairing, terminal exclusion and configuration validation fail closed", t => {
  const { agents, storage, executor, config } = fixture(t);
  assert.throws(() => agents.openTerminal("pi", { approved: true }), /terminals/);
  assert.throws(() => new CJHXFramework(storage.root, { agentExecutor: executor }), /paired/);
  assert.throws(() => new CJHXFramework(storage.root, { sandbox: config, harnessCheckExecutor: executor }), /paired/);
  assert.throws(() => validateSandboxConfig({ ...config, credentialKeys: ["SSH_AUTH_SOCK"] }), /credential/);
  assert.throws(() => validateSandboxConfig({ ...config, bypass: true }), /fields/);
});

test("Sandbox refuses Worktree grants, local-process capabilities and arbitrary check commands", async t => {
  const { executor, harness, repo } = fixture(t);
  assert.equal(executor.capabilities().has("git.restricted"), false);
  assert.equal(executor.capabilities().has("filesystem.read-only"), false);
  assert.throws(() => executor.start({ command: "ignored", arguments: [], cwd: repo, environment: {}, executionMode: "read-only", ruleSnapshot: harness.effectiveForTask("task-1") }), /single Workspace/);
  await assert.rejects(executor.execute({ checkId: "npm.test", command: "sh", arguments: ["-c", "touch HOST-FALLBACK"], cwd: repo, timeoutMs: 100, outputLimit: 1024, ruleSnapshot: harness.effectiveForTask("task-1") }), /fixed npm catalog/);
});
