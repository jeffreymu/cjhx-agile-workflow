import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { InMemoryJiraAdapter, ToolBroker } from "../src/adapters.js";
import { PolicyDenied, ValidationError } from "../src/errors.js";
import { CJHXFramework } from "../src/framework.js";

function fixture(t: test.TestContext, withJira = false) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-tasks-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const jira = withJira ? new InMemoryJiraAdapter() : undefined;
  const app = new CJHXFramework(resolve(root, ".cjhx"), { ...(jira ? { tools: new ToolBroker({ jira }) } : {}) });
  app.createChange("PAY-1", "批量取消", "product"); return { app, jira };
}

test("imports requirement decomposition tasks idempotently", async (t) => {
  const { app } = fixture(t); app.installSkill(resolve(process.cwd(), "examples/skills/requirement-decompose"));
  const run = await app.runSkill("requirement.decompose", { requirement: "支持批量取消；记录审计日志" }, { changeId: "PAY-1" });
  app.createChange("OTHER", "其他需求", "product"); assert.throws(() => app.importTasksFromRun(run.id, "OTHER"), /does not match/);
  const first = app.importTasksFromRun(run.id, "PAY-1"); const second = app.importTasksFromRun(run.id, "PAY-1");
  assert.equal(first.length, 2); assert.equal(second.length, 2); assert.equal(app.listTasks().length, 2);
  assert.equal(first[0]?.sourceRunId, run.id); assert.deepEqual(first[0]?.acceptanceCriteria, ["已验证：支持批量取消"]);
});

test("task Workspace inherits from its Change and rejects cross-Workspace scope", (t) => {
  const { app } = fixture(t); const repository = mkdtempSync(resolve(tmpdir(), "cjhx-task-workspace-")); t.after(() => rmSync(repository, { recursive: true, force: true })); const otherRepository = mkdtempSync(resolve(tmpdir(), "cjhx-task-workspace-other-")); t.after(() => rmSync(otherRepository, { recursive: true, force: true }));
  for (const path of [repository, otherRepository]) execFileSync("git", ["init", "-b", "main", path]); const workspace = app.workspaceHub.addLocal({ path: repository }); const other = app.workspaceHub.addLocal({ path: otherRepository }); app.createChange("WS-1", "Scoped change", "owner", { workspaceId: workspace.id });
  const inherited = app.createTask({ changeId: "WS-1", title: "Inherited scope" }); assert.equal(inherited.workspaceId, workspace.id);
  assert.throws(() => app.createTask({ changeId: "WS-1", workspaceId: other.id, title: "Wrong scope" }), /must match/);
});

test("local draft task follows the board state machine", (t) => {
  const { app } = fixture(t); const task = app.createTask({ changeId: "PAY-1", title: "实现取消接口", owner: "backend", priority: "P1", riskLevel: "L2", acceptanceCriteria: ["接口返回逐单结果"] });
  assert.equal(task.status, "todo"); assert.equal(task.authority, "local-draft");
  assert.equal(app.transitionTask(task.id, "in_progress", { actor: "backend", reason: "started" }).status, "in_progress");
  assert.throws(() => app.transitionTask(task.id, "done", { actor: "backend", reason: "skip" }), ValidationError);
});

test("publishing and transitioning a Jira task require approval", async (t) => {
  const { app, jira } = fixture(t, true); const task = app.createTask({ changeId: "PAY-1", title: "实现取消接口", owner: "backend" });
  await assert.rejects(app.publishTaskToJira(task.id, { approved: false }), PolicyDenied);
  const published = await app.publishTaskToJira(task.id, { approved: true }); assert.equal(published.authority, "jira"); assert.match(published.jiraIssueKey ?? "", /^TASK-/);
  await assert.rejects(app.transitionTaskInAuthority(task.id, "in_progress", { actor: "backend", reason: "started", approved: false }), PolicyDenied);
  const moved = await app.transitionTaskInAuthority(task.id, "in_progress", { actor: "backend", reason: "started", approved: true }); assert.equal(moved.status, "in_progress");
  assert.equal(jira?.transitions.length, 1);
});

test("sync refreshes a Jira-owned task projection", async (t) => {
  const { app, jira } = fixture(t, true); const task = app.createTask({ changeId: "PAY-1", title: "实现取消接口", owner: "backend" });
  const published = await app.publishTaskToJira(task.id, { approved: true }); jira?.setStatus(published.jiraIssueKey!, "Review");
  const synced = await app.syncTaskFromJira(task.id); assert.equal(synced.status, "review"); assert.equal(synced.jiraStatus, "Review");
});
