import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { HarnessService } from "../src/harness.js";
import { Workspace } from "../src/storage.js";
import type { Task } from "../src/tasks.js";
import { assertSandboxRuntimeHost, compileSandboxPolicy, sandboxRuntimeVersion } from "../src/sandbox/policy.js";

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "cjhx-sandbox-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = resolve(root, "repo"); const control = resolve(root, "control"); const tools = resolve(root, "tools");
  for (const path of [repo, control, tools]) mkdirSync(path);
  const storage = new Workspace(control); storage.initialize();
  const task: Task = { id: "task-1", changeId: "SB-1", workspaceId: "workspace-1", title: "Sandbox policy", description: "", owner: "owner", status: "todo", authority: "local-draft", priority: "P2", riskLevel: "L1", acceptanceCriteria: [], dependencies: [], evidenceRefs: [], history: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  const harness = new HarnessService(storage, { task: () => task, workspace: () => ({ id: "workspace-1", kind: "local", rootPath: repo }) });
  const snapshot = harness.effectiveForTask(task.id);
  const input = { executionRoot: repo, controlRoot: control, readRoots: [tools], modelHosts: ["api.anthropic.com"] };
  return { root, repo, control, tools, snapshot, input, storage, task, harness };
}

test("Sandbox policy has stable digest and protects control-plane and repository configuration", t => {
  const { input, repo, control, snapshot } = fixture(t);
  const policy = compileSandboxPolicy(input, snapshot, "agent");
  assert.equal(policy.runtimeVersion, sandboxRuntimeVersion);
  assert.deepEqual(policy.allowedHosts, ["api.anthropic.com"]);
  assert.deepEqual(policy.writeRoots, [repo]);
  for (const path of [control, resolve(repo, ".git"), resolve(repo, ".cjhx"), resolve(repo, ".pi"), resolve(repo, ".env"), resolve(repo, ".npmrc")]) assert.ok(policy.deniedPaths.includes(path));
  assert.equal(compileSandboxPolicy(input, snapshot, "agent").digest, policy.digest);
  assert.notEqual(compileSandboxPolicy({ ...input, modelHosts: ["api.openai.com"] }, snapshot, "agent").digest, policy.digest);
  assert.notEqual(compileSandboxPolicy(input, { ...snapshot, digest: "sha256:new" }, "agent").digest, policy.digest);
});

test("Postflight policy never inherits model network permissions", t => {
  const { input, snapshot } = fixture(t);
  const policy = compileSandboxPolicy(input, snapshot, "postflight");
  assert.deepEqual(policy.allowedHosts, []);
  assert.notEqual(policy.digest, compileSandboxPolicy(input, snapshot, "agent").digest);
  snapshot.effective.capabilities.network = { mode: "none", allowedHosts: [] };
  assert.deepEqual(compileSandboxPolicy(input, snapshot, "agent").allowedHosts, []);
  snapshot.effective.capabilities.network = { mode: "allowlist", allowedHosts: ["api.openai.com"] };
  assert.deepEqual(compileSandboxPolicy(input, snapshot, "agent").allowedHosts, []);
});

test("Sandbox rejects ambiguous hosts, overlapping control storage and escaped write roots", t => {
  const { input, snapshot, root } = fixture(t);
  for (const value of ["localhost", "127.0.0.1", "*.example.com", "https://api.example.com", "api.example.com:443", "api.local", " api.example.com"]) assert.throws(() => compileSandboxPolicy({ ...input, modelHosts: [value] }, snapshot, "agent"));
  assert.throws(() => compileSandboxPolicy({ ...input, controlRoot: root }, snapshot, "agent"), /overlaps/);
  snapshot.effective.capabilities.filesystem.writeRoots = [".."];
  assert.throws(() => compileSandboxPolicy(input, snapshot, "agent"), /escapes/);
});

test("Sandbox canonicalizes symlinks and refuses filesystem-wide read grants", t => {
  const { input, snapshot, root, repo } = fixture(t);
  const link = resolve(repo, "escape");
  // Windows symlink privileges differ; a junction does not require Developer Mode.
  symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
  snapshot.effective.capabilities.filesystem.writeRoots = ["escape"];
  assert.throws(() => compileSandboxPolicy(input, snapshot, "agent"), /escapes/);
  snapshot.effective.capabilities.filesystem.writeRoots = null;
  assert.throws(() => compileSandboxPolicy({ ...input, readRoots: [resolve(root, "/")] }, snapshot, "agent"), /whole-filesystem/);
});

test("Sandbox never advertises unsupported Git or tool enforcement", t => {
  const { input, snapshot } = fixture(t);
  snapshot.effective.capabilities.git.push = false;
  assert.throws(() => compileSandboxPolicy(input, snapshot, "agent"), /Git or tool/);
  snapshot.effective.capabilities.git.push = true;
  snapshot.effective.capabilities.tools.denied = ["shell"];
  assert.throws(() => compileSandboxPolicy(input, snapshot, "agent"), /Git or tool/);
});

test("Sandbox Node version check preserves optional host Node 20 support but refuses launching SRT there", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    assert.doesNotThrow(() => assertSandboxRuntimeHost(platform, "22.12.0"));
    assert.doesNotThrow(() => assertSandboxRuntimeHost(platform, "24.0.0"));
    assert.throws(() => assertSandboxRuntimeHost(platform, "22.11.0"), /22.12/);
    assert.throws(() => assertSandboxRuntimeHost(platform, "20.20.0"), /fallback is disabled/);
  }
  assert.throws(() => assertSandboxRuntimeHost("freebsd", "24.0.0"), /platform/);
});
