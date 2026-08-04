import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ValidationError } from "../src/errors.js";
import { CJHXFramework } from "../src/framework.js";
import { loadWorkflow } from "../src/workflows.js";

const root = process.cwd();
function fixture() {
  const temporary = mkdtempSync(resolve(tmpdir(), "cjhx-workflow-"));
  const app = new CJHXFramework(resolve(temporary, ".cjhx"));
  app.installSkill(resolve(root, "examples/skills/requirement-decompose"));
  app.installSkill(resolve(root, "examples/skills/test-case-generate"));
  return { app, temporary };
}

test("workflow composes installed skills and resolves references", async (t) => {
  const { app, temporary } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const run = await app.runWorkflow(loadWorkflow(resolve(root, "examples/requirement-to-tests.workflow.json")), { requirement: "支持批量取消；记录审计日志", feature: "批量取消订单", acceptanceCriteria: ["返回每个订单的处理结果"] }, { changeId: "PAY-128" });
  assert.equal(run.status, "succeeded");
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[1]?.output && (run.steps[1].output as { feature: string }).feature, "批量取消订单");
});

test("missing workflow reference fails closed", async (t) => {
  const { app, temporary } = fixture(); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  await assert.rejects(app.runWorkflow(loadWorkflow(resolve(root, "examples/requirement-to-tests.workflow.json")), { requirement: "only" }), ValidationError);
});
