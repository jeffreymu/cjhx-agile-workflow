import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { CJHXFramework } from "../src/framework.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-goals-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = resolve(root, "repo"); mkdirSync(repo); writeFileSync(resolve(repo, "README.md"), "goal workspace\n");
  execFileSync("git", ["init", "-b", "main", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=CJHX", "-c", "user.email=cjhx@example.com", "commit", "-m", "initial"]);
  const app = new CJHXFramework(resolve(root, ".cjhx")); app.initialize(); const workspace = app.workspaceHub.addLocal({ path: repo, name: "Goal Workspace" }); return { root, app, workspace };
}

const criterion = { name: "发布失败率", type: "metric" as const, status: "on-track" as const, baseline: 12, current: 8, target: 5, unit: "%", direction: "decrease" as const, source: "devops" as const, verificationDescription: "读取最近 30 天生产发布结果" };

test("Goals are private, immutable-snapshotted, and activation-gated", (t) => {
  const { app, workspace } = fixture(t); const goal = app.goals.create({ workspaceId: workspace.id, title: "降低发布失败率", statement: "将生产发布失败率降低到 5% 以下", owner: "platform-team", successCriteria: [] }); assert.equal(goal.status, "draft"); assert.throws(() => app.goals.setStatus(goal.id, "active"), /at least one success criterion/);
  const updated = app.goals.update(goal.id, { workspaceId: workspace.id, title: goal.title, statement: goal.statement, owner: goal.owner, priority: "high", successCriteria: [criterion], inScope: ["生产发布"], outOfScope: ["开发环境"], constraints: ["不得绕过 Harness"] }); assert.notEqual(updated.currentSnapshotDigest, goal.currentSnapshotDigest); const active = app.goals.setStatus(goal.id, "active"); assert.equal(active.status, "active"); assert.match(active.currentSnapshotDigest, /^sha256:/); assert.throws(() => app.goals.update(goal.id, { workspaceId: workspace.id, title: active.title, statement: active.statement, owner: active.owner, successCriteria: [] }), /active Goal update is missing/); assert.throws(() => app.goals.setStatus(goal.id, "achieved"), /every success criterion/); assert.equal(app.goals.snapshots(goal.id).length, 3); assert.equal(statSync(resolve(app.workspace.goalRecords, `${goal.id}.json`)).mode & 0o777, 0o600); assert.equal(statSync(app.workspace.goals).mode & 0o777, 0o700); assert.throws(() => app.goals.remove(goal.id), /only draft/);
});

test("Goal validation rejects invalid calendar dates and criterion directions", (t) => {
  const { app, workspace } = fixture(t); assert.throws(() => app.goals.create({ workspaceId: workspace.id, title: "Bad date", statement: "Reject invalid dates", owner: "owner", targetDate: "2026-02-31", successCriteria: [criterion] }), /valid calendar date/); assert.throws(() => app.goals.create({ workspaceId: workspace.id, title: "Bad direction", statement: "Reject invalid direction", owner: "owner", successCriteria: [{ ...criterion, direction: "sideways" as never }] }), /invalid Goal criterion direction/);
});

test("Goal scope rejects cross-Workspace Changes and health follows deterministic facts", (t) => {
  const { app, workspace } = fixture(t); const otherRoot = mkdtempSync(resolve(tmpdir(), "cjhx-goal-other-")); t.after(() => rmSync(otherRoot, { recursive: true, force: true })); mkdirSync(resolve(otherRoot, "repo")); execFileSync("git", ["init", "-b", "main", resolve(otherRoot, "repo")]); const other = app.workspaceHub.addLocal({ path: resolve(otherRoot, "repo"), name: "Other" }); app.createChange("GOAL-1", "Goal change", "owner", { workspaceId: workspace.id }); app.createChange("GOAL-2", "Other change", "owner", { workspaceId: other.id });
  assert.throws(() => app.goals.create({ workspaceId: workspace.id, title: "Bad scope", statement: "Reject cross scope", owner: "owner", successCriteria: [criterion], linkedChangeIds: ["GOAL-2"] }), /Goal Change must belong/);
  const goal = app.goals.create({ workspaceId: workspace.id, title: "Release health", statement: "Make release health measurable", owner: "owner", successCriteria: [criterion], linkedChangeIds: ["GOAL-1"] }); app.goals.setStatus(goal.id, "active"); assert.equal(app.goals.assess(goal.id).health, "on-track"); app.createTask({ changeId: "GOAL-1", workspaceId: workspace.id, title: "Blocked release task", owner: "owner", status: "blocked", acceptanceCriteria: ["done"] }); const assessment = app.goals.assess(goal.id); assert.equal(assessment.health, "off-track"); assert.equal(assessment.linkedTasks.length, 1); assert.equal(app.goals.portfolio().counts.health["off-track"], 1);
});

test("Dashboard projects Goals, attention, running work, and engineering health without writes", (t) => {
  const { app, workspace } = fixture(t); app.createChange("DASH-1", "Dashboard change", "owner", { workspaceId: workspace.id }); const goal = app.goals.create({ workspaceId: workspace.id, title: "Visible goal", statement: "Expose goal health", owner: "owner", successCriteria: [{ ...criterion, status: "at-risk" }], linkedChangeIds: ["DASH-1"] }); app.goals.setStatus(goal.id, "active"); app.createTask({ changeId: "DASH-1", workspaceId: workspace.id, title: "Blocked dashboard task", owner: "owner", status: "blocked", acceptanceCriteria: ["done"] }); const dashboard = app.dashboard.view(); assert.equal(dashboard.kpis.activeGoals, 1); assert.equal(dashboard.kpis.blockedTasks, 1); assert.ok(dashboard.attention.some((item) => item.kind === "goal")); assert.ok(dashboard.attention.some((item) => item.kind === "task"));
});
