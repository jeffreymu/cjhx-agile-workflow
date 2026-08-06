import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CJHXFramework } from "../src/framework.js";
import test from "node:test";

const projectRoot = process.cwd();
const compiledCli = resolve(projectRoot, "dist/src/cli.js");

test("CLI executes when launched through a package-manager style symlink", (t) => {
  const temporary = mkdtempSync(resolve(tmpdir(), "cjhx-cli-")); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bin = resolve(temporary, "cjhx"); const workspace = resolve(temporary, "workspace");
  symlinkSync(compiledCli, bin);
  const result = spawnSync(process.execPath, [bin, "--workspace", workspace, "init"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status": "initialized"/);
  assert.equal(existsSync(resolve(workspace, "skills-lock.json")), true);
});

test("CLI creates and runs repository review automations and reports token usage", async (t) => {
  const temporary = mkdtempSync(resolve(tmpdir(), "cjhx-cli-automation-")); t.after(() => rmSync(temporary, { recursive: true, force: true })); const repo = resolve(temporary, "repo"); const workspacePath = resolve(temporary, ".cjhx"); mkdirSync(repo); writeFileSync(resolve(repo, "package.json"), JSON.stringify({ name: "cli" })); execFileSync("git", ["init", "-b", "main", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=CJHX", "-c", "user.email=cjhx@example.com", "commit", "-m", "initial"]); const app = new CJHXFramework(workspacePath); app.initialize(); const workspace = app.workspaceHub.addLocal({ path: repo });
  let result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "automation-create", "--name", "Daily", "--workspace-id", workspace.id, "--disabled"], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); const definition = JSON.parse(result.stdout) as { id: string }; result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "automation-show", definition.id], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"name": "Daily"/); result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "automation-run", definition.id], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"status": "partial"/); result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "automation-findings", "--automation-id", definition.id], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"category": "data-quality"|"category": "release"/); result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "agent-usage"], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"totalTokens": 0/);
});

test("CLI creates, activates, and inspects Goals and Dashboard", (t) => {
  const temporary = mkdtempSync(resolve(tmpdir(), "cjhx-cli-goal-")); t.after(() => rmSync(temporary, { recursive: true, force: true })); const repo = resolve(temporary, "repo"); const workspacePath = resolve(temporary, ".cjhx"); mkdirSync(repo); writeFileSync(resolve(repo, "README.md"), "goal CLI\n"); execFileSync("git", ["init", "-b", "main", repo]); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=CJHX", "-c", "user.email=cjhx@example.com", "commit", "-m", "initial"]); const app = new CJHXFramework(workspacePath); app.initialize(); const workspace = app.workspaceHub.addLocal({ path: repo }); app.createChange("GOAL-CLI", "Goal CLI change", "owner", { workspaceId: workspace.id }); const payload = resolve(temporary, "goal.json"); writeFileSync(payload, JSON.stringify({ workspaceId: workspace.id, title: "CLI Goal", statement: "Expose verified Goal operations", owner: "owner", linkedChangeIds: ["GOAL-CLI"], successCriteria: [{ name: "Goal API", type: "milestone", status: "on-track", source: "manual-evidence", verificationDescription: "CLI output is inspectable" }] }));
  let result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "goal-create", "--input", `@${payload}`], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); const goal = JSON.parse(result.stdout) as { id: string }; result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "goal-status", goal.id, "active"], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"status": "active"/); result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "goal-show", goal.id], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"health": "on-track"/); result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "goal-snapshots", goal.id], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /goal-snapshot-/); result = spawnSync(process.execPath, [compiledCli, "--workspace", workspacePath, "dashboard"], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"activeGoals": 1/);
});

test("CLI validates Harness engineering rule bundles fail closed", (t) => {
  const temporary = mkdtempSync(resolve(tmpdir(), "cjhx-cli-harness-")); t.after(() => rmSync(temporary, { recursive: true, force: true })); const valid = resolve(temporary, "valid.json"); const invalid = resolve(temporary, "invalid.json");
  writeFileSync(valid, JSON.stringify({ schemaVersion: 1, id: "engineering", version: "1.0.0", scope: "workspace", mode: "enforce", rules: [{ id: "quality", description: "Run checks", requiredChecks: ["npm.check"] }] })); writeFileSync(invalid, JSON.stringify({ schemaVersion: 1, id: "engineering", version: "1.0.0", scope: "workspace", mode: "enforce", rules: [{ id: "quality", description: "Run checks", requiredChecks: ["shell.anything"] }] }));
  const accepted = spawnSync(process.execPath, [compiledCli, "harness-validate", valid], { encoding: "utf8" }); assert.equal(accepted.status, 0, accepted.stderr); assert.match(accepted.stdout, /"valid": true/);
  const rejected = spawnSync(process.execPath, [compiledCli, "harness-validate", invalid], { encoding: "utf8" }); assert.equal(rejected.status, 2); assert.match(rejected.stderr, /unknown Harness check/i);
});
