import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { PolicyDenied } from "../src/errors.js";
import { CJHXFramework } from "../src/framework.js";
import type { HarnessRuleBundle, HarnessRuleSource } from "../src/harness.js";

function bundle(overrides: Partial<HarnessRuleBundle> = {}): HarnessRuleBundle {
  return {
    schemaVersion: 1,
    id: "workspace-engineering",
    version: "1.0.0",
    scope: "workspace",
    mode: "enforce",
    rules: [{
      id: "engineering-quality",
      description: "Apply the engineering harness",
      instruction: "Work test-first and report validation.",
      preconditions: ["task.has-acceptance-criteria"],
      requiredChecks: ["npm.typecheck"],
      gates: [{ target: "task.verification", requires: ["check:npm.typecheck"] }],
    }],
    ...overrides,
  };
}

function fixture(t: test.TestContext, rule = bundle(), sources: HarnessRuleSource[] = []) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-harness-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = resolve(root, "repo"); mkdirSync(repository); execFileSync("git", ["init", "-b", "main", repository]); writeFileSync(resolve(repository, "cjhx.harness.json"), `${JSON.stringify(rule, null, 2)}\n`);
  writeFileSync(resolve(repository, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e \"process.exit(0)\"" } }));
  const script = resolve(root, "agent.mjs"); writeFileSync(script, `if(process.argv.includes("--version")){console.log("agent 1.0");process.exit(0)} console.log(process.argv.at(-1));`); chmodSync(script, 0o700);
  const app = new CJHXFramework(resolve(root, ".cjhx"), { harnessRuleSources: sources }); app.initialize();
  const workspace = app.workspaceHub.addLocal({ path: repository }); const change = app.createChange("HARNESS-1", "Harness engineering", "developer", { workspaceId: workspace.id });
  const task = app.createTask({ changeId: change.id, workspaceId: workspace.id, title: "Implement governed change", status: "review", acceptanceCriteria: ["Type checking passes"] });
  return { root, repository, script, app, workspace, change, task };
}

async function configureAgent(app: CJHXFramework, script: string) {
  await app.agents.save({ id: "agent", name: "Agent", kind: "custom", command: process.execPath, arguments: [script, "{prompt}"], versionArguments: [script, "--version"], promptTransport: "argument", timeoutMinutes: 1 }, { approved: true });
}

async function waitForCompliance(app: CJHXFramework, id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) { const run = app.agents.getRun(id); if (run.status !== "running" && run.complianceStatus !== "pending") return run; await new Promise((accept) => setTimeout(accept, 10)); }
  throw new Error("Harness run did not finish");
}

test("Harness compiles enterprise and Workspace rules monotonically into a private snapshot", (t) => {
  const enterprise = bundle({ id: "enterprise", scope: "enterprise", rules: [{ id: "enterprise-safety", description: "Enterprise safety", capabilities: { network: { mode: "none" }, git: { push: false } } }] });
  const source: HarnessRuleSource = { id: "enterprise", load: () => [enterprise] }; const { app, task } = fixture(t, bundle({ rules: [{ id: "workspace-policy", description: "Workspace cannot loosen enterprise policy", capabilities: { network: { mode: "unrestricted" }, git: { push: true } } }] }), [source]);
  const snapshot = app.harness.effectiveForTask(task.id);
  assert.equal(snapshot.effective.capabilities.network.mode, "none"); assert.equal(snapshot.effective.capabilities.git.push, false); assert.equal(snapshot.sources.length, 2); assert.match(snapshot.digest, /^sha256:[a-f0-9]{64}$/);
  const path = resolve(app.workspace.ruleSnapshots, `${snapshot.id}.json`); assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal((JSON.parse(readFileSync(path, "utf8")) as { digest: string }).digest, snapshot.digest);
});

test("Harness binds Agent approval to a rule digest and records successful postflight compliance", async (t) => {
  const { app, script, task } = fixture(t); await configureAgent(app, script); const snapshot = app.harness.effectiveForTask(task.id);
  assert.throws(() => app.startAgentForTask(task.id, { approved: true, approvedRuleDigest: "sha256:stale" }), /rule snapshot/i);
  const started = app.startAgentForTask(task.id, { approved: true, approvedRuleDigest: snapshot.digest }); const completed = await waitForCompliance(app, started.id);
  assert.equal(completed.status, "succeeded"); assert.equal(completed.complianceStatus, "passed"); assert.equal(completed.ruleSnapshotDigest, snapshot.digest); assert.match(completed.stdout, /Work test-first/);
  const report = app.harness.listReports(task.id)[0]!; assert.equal(report.status, "passed"); assert.equal(report.checks[0]?.checkId, "npm.typecheck"); assert.equal(report.checks[0]?.status, "passed"); assert.equal(statSync(resolve(app.workspace.complianceReports, `${report.id}.json`)).mode & 0o777, 0o600);
});

test("Harness keeps Agent process success separate from compliance and blocks the Task gate", async (t) => {
  const rule = bundle({ rules: [{ id: "quality", description: "Quality gate", requiredChecks: ["npm.test"], gates: [{ target: "task.verification", requires: ["check:npm.test"] }] }] });
  const { app, repository, script, task } = fixture(t, rule); writeFileSync(resolve(repository, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(7)\"" } })); await configureAgent(app, script);
  let snapshot = app.harness.effectiveForTask(task.id); let run = await waitForCompliance(app, app.startAgentForTask(task.id, { approved: true, approvedRuleDigest: snapshot.digest }).id);
  assert.equal(run.status, "succeeded"); assert.equal(run.complianceStatus, "failed"); assert.throws(() => app.transitionTask(task.id, "verification", { actor: "developer", reason: "ready" }), /Harness gate.*npm\.test/i);
  writeFileSync(resolve(repository, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } })); snapshot = app.harness.effectiveForTask(task.id); run = await waitForCompliance(app, app.startAgentForTask(task.id, { approved: true, approvedRuleDigest: snapshot.digest }).id);
  assert.equal(run.complianceStatus, "passed"); assert.equal(app.transitionTask(task.id, "verification", { actor: "developer", reason: "validated" }).status, "verification");
});

test("Harness invalidates a passed Task gate when the repository changes after postflight", async (t) => {
  const { app, repository, script, task } = fixture(t); await configureAgent(app, script); const snapshot = app.harness.effectiveForTask(task.id); const run = await waitForCompliance(app, app.startAgentForTask(task.id, { approved: true, approvedRuleDigest: snapshot.digest }).id); const report = app.harness.getReport(run.complianceReportId!);
  assert.match(report.repositoryStateDigest, /^sha256:/); writeFileSync(resolve(repository, "after-verification.ts"), "export const changed = true;\n");
  assert.throws(() => app.transitionTask(task.id, "verification", { actor: "developer", reason: "stale verification" }), /repository state|postflight/i);
});

test("Harness refuses enforce-mode capabilities that the local process executor cannot guarantee", async (t) => {
  const rule = bundle({ rules: [{ id: "isolated", description: "Require real isolation", capabilities: { network: { mode: "none" } } }] }); const { app, script, task } = fixture(t, rule); await configureAgent(app, script); const snapshot = app.harness.effectiveForTask(task.id);
  assert.throws(() => app.startAgentForTask(task.id, { approved: true, approvedRuleDigest: snapshot.digest }), PolicyDenied);
  assert.throws(() => app.startAgentForTask(task.id, { approved: true, approvedRuleDigest: snapshot.digest }), /cannot enforce.*network\.none/i);
});

test("Harness rejects unknown gate requirements instead of silently allowing them", () => {
  const value = bundle({ rules: [{ id: "unknown-gate", description: "Must fail closed", gates: [{ target: "task.verification", requires: ["evidence:anything"] }] }] });
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-harness-parse-")); try { const app = new CJHXFramework(resolve(root, ".cjhx")); assert.throws(() => app.harness.validate(value), /unknown Harness gate requirement/i); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Harness never reports compliance passed when the Agent process failed", async (t) => {
  const { app, script, task } = fixture(t); writeFileSync(script, `if(process.argv.includes("--version")){console.log("agent 1.0");process.exit(0)} process.exit(9);`); await configureAgent(app, script); const snapshot = app.harness.effectiveForTask(task.id);
  const run = await waitForCompliance(app, app.startAgentForTask(task.id, { approved: true, approvedRuleDigest: snapshot.digest }).id); const report = app.harness.getReport(run.complianceReportId!);
  assert.equal(run.status, "failed"); assert.equal(run.complianceStatus, "failed"); assert.equal(report.status, "failed"); assert.equal(report.agentRunStatus, "failed"); assert.deepEqual(report.checks, []);
});

test("Harness rejects a project rule file that is a symbolic link", (t) => {
  const { app, repository, task, root } = fixture(t); unlinkSync(resolve(repository, "cjhx.harness.json")); const external = resolve(root, "external-rules.json"); writeFileSync(external, JSON.stringify(bundle())); symlinkSync(external, resolve(repository, "cjhx.harness.json"));
  assert.throws(() => app.harness.effectiveForTask(task.id), /symbolic link/i);
});
