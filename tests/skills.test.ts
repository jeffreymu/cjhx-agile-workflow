import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { InMemoryConfluenceAdapter, InMemoryDevOpsAdapter, ToolBroker } from "../src/adapters.js";
import { PolicyDenied, SkillError } from "../src/errors.js";
import { CJHXFramework } from "../src/framework.js";
import { Policy } from "../src/policy.js";

const root = process.cwd();
const examples = resolve(root, "examples/skills");
function fixture() {
  const temporary = mkdtempSync(resolve(tmpdir(), "cjhx-skill-"));
  const confluence = new InMemoryConfluenceAdapter(); const devops = new InMemoryDevOpsAdapter();
  const app = new CJHXFramework(resolve(temporary, ".cjhx"), { tools: new ToolBroker({ confluence, devops }) });
  return { temporary, app, confluence, devops };
}

test("installs, locks, and runs a builtin skill", async (t) => {
  const { temporary, app } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const installed = app.installSkill(resolve(examples, "requirement-decompose"));
  assert.match(installed.digest, /^sha256:/);
  const run = await app.runSkill("requirement.decompose", { requirement: "支持批量取消订单；记录审计日志" }, { changeId: "PAY-128" });
  assert.equal(run.status, "succeeded"); assert.equal((run.output.tasks as unknown[]).length, 2);
  const lock = JSON.parse(readFileSync(resolve(temporary, ".cjhx/skills-lock.json"), "utf8")) as { skills: Record<string, { version: string }> };
  assert.equal(lock.skills["requirement.decompose"]?.version, "1.0.0");
});

test("write skill requires approval and uses ToolBroker", async (t) => {
  const { temporary, app } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  app.installSkill(resolve(examples, "jira-confluence-sync")); const payload = { issue: { key: "PAY-128", summary: "批量取消", description: "需求" } };
  await assert.rejects(app.runSkill("sync.jira-requirement-to-confluence", payload), PolicyDenied);
  const run = await app.runSkill("sync.jira-requirement-to-confluence", payload, { approved: true });
  const result = (run.output.toolResults as { result: { changeId: string; status: string } }[])[0]?.result;
  assert.equal(result?.changeId, "PAY-128"); assert.equal(result?.status, "draft");
});

test("external process skill is disabled by default and can be explicitly enabled", async (t) => {
  const { temporary, app } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  assert.throws(() => app.installSkill(resolve(examples, "api-test-generate")), PolicyDenied);
  const enabled = new CJHXFramework(resolve(temporary, ".external"), { policy: new Policy({ allowProcessSkills: true }) });
  enabled.installSkill(resolve(examples, "api-test-generate"));
  const run = await enabled.runSkill("api-test.generate", { operation: { method: "POST", path: "/orders/cancel" } });
  assert.equal((run.output.cases as unknown[]).length, 3);
});

test("code review returns structured findings", async (t) => {
  const { temporary, app } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  app.installSkill(resolve(examples, "code-review")); const run = await app.runSkill("review.code.basic", { changedFiles: [{ path: "app.ts", content: "password = 'secret'" }] });
  assert.equal(run.output.decision, "request-changes");
});

test("API test skill triggers validation through DevOps adapter", async (t) => {
  const { temporary, app } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  app.installSkill(resolve(examples, "api-test-execute")); const run = await app.runSkill("api-test.execute", { changeId: "PAY-128", suiteRef: "artifact://tests/api", environment: "test" }, { approved: true });
  const result = (run.output.toolResults as { result: { validationType: string; status: string } }[])[0]?.result;
  assert.equal(result?.validationType, "api"); assert.equal(result?.status, "requested");
});

test("installed skill package tampering is detected", async (t) => {
  const { temporary, app } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const installed = app.installSkill(resolve(examples, "test-case-generate")); writeFileSync(resolve(installed.path, "tampered.txt"), "bad");
  await assert.rejects(app.runSkill("test.case.generate", { feature: "登录" }), SkillError);
});

test("credentials are redacted from audit record", async (t) => {
  const { temporary, app } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  app.installSkill(resolve(examples, "requirement-decompose")); const run = await app.runSkill("requirement.decompose", { requirement: "测试", apiToken: "do-not-persist" });
  const persisted = JSON.parse(readFileSync(resolve(temporary, `.cjhx/runs/${run.id}.json`), "utf8")) as { input: { apiToken: string } };
  assert.equal(persisted.input.apiToken, "[REDACTED]");
});

test("skill packages with symbolic links are rejected", (t) => {
  const { temporary, app } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const packagePath = resolve(temporary, "linked-skill"); cpSync(resolve(examples, "requirement-decompose"), packagePath, { recursive: true }); symlinkSync("/etc/passwd", resolve(packagePath, "escape"));
  assert.throws(() => app.installSkill(packagePath), SkillError);
});
