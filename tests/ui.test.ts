import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { CJHXFramework } from "../src/framework.js";
import { createUiServer } from "../src/ui.js";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-ui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = new CJHXFramework(resolve(root, ".cjhx")); app.initialize();
  const ui = createUiServer(app, { host: "127.0.0.1", port: 0, open: false });
  const address = await ui.listen(); t.after(async () => await ui.close());
  return { app, ui, base: address.url };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test("UI serves the control surface and workspace snapshot", async (t) => {
  const { base } = await fixture(t);
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /CJHX Agile Workflow/);
  const response = await fetch(`${base}/api/snapshot`); assert.equal(response.status, 200);
  const body = await json(response); assert.deepEqual(body.changes, []); assert.deepEqual(body.skills, []); assert.deepEqual(body.runs, []);
});

test("UI rejects non-loopback Host headers", async (t) => {
  const { base } = await fixture(t);
  const result = await new Promise<{ status: number; body: string }>((accept, reject) => {
    const request = httpRequest(`${base}/api/snapshot`, { headers: { host: "attacker.example" } }, (response) => { let body = ""; response.setEncoding("utf8"); response.on("data", (part: string) => { body += part; }); response.on("end", () => accept({ status: response.statusCode ?? 0, body })); });
    request.on("error", reject); request.end();
  });
  assert.equal(result.status, 403); assert.match(String((JSON.parse(result.body) as { error: string }).error), /host/i);
});

test("UI API requires its session token for mutations", async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/changes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "PAY-1", title: "Pay", owner: "team" }) });
  assert.equal(response.status, 403); assert.match(String((await json(response)).error), /token/i);
});

test("UI API creates changes and drives evidence-gated transitions", async (t) => {
  const { base, ui } = await fixture(t); const headers = { "content-type": "application/json", "x-cjhx-ui-token": ui.token };
  let response = await fetch(`${base}/api/changes`, { method: "POST", headers, body: JSON.stringify({ id: "PAY-1", title: "批量取消", owner: "product", riskLevel: "L2" }) });
  assert.equal(response.status, 201); assert.equal((await json(response)).state, "intent_draft");
  response = await fetch(`${base}/api/changes/PAY-1/transitions`, { method: "POST", headers, body: JSON.stringify({ target: "intent_confirmed", actor: "owner", reason: "confirmed" }) });
  assert.equal(response.status, 400); assert.match(String((await json(response)).error), /intent-approval/);
  response = await fetch(`${base}/api/changes/PAY-1/evidence`, { method: "POST", headers, body: JSON.stringify({ kind: "intent-approval", source: "jira", status: "approved", subjectRef: "jira://PAY-1" }) });
  assert.equal(response.status, 201);
  response = await fetch(`${base}/api/changes/PAY-1/transitions`, { method: "POST", headers, body: JSON.stringify({ target: "intent_confirmed", actor: "owner", reason: "confirmed" }) });
  assert.equal(response.status, 200); assert.equal((await json(response)).state, "intent_confirmed");
  const snapshot = await json(await fetch(`${base}/api/snapshot`)); const changes = snapshot.changes as Array<Record<string, unknown>>;
  assert.equal(changes.length, 1); assert.deepEqual(changes[0]?.nextTransitions, [{ target: "requirement_ready", missingEvidence: ["requirement-spec"] }, { target: "intent_draft", missingEvidence: [] }]);
});

test("UI API installs and runs a Skill against a change", async (t) => {
  const { base, ui } = await fixture(t); const headers = { "content-type": "application/json", "x-cjhx-ui-token": ui.token };
  await fetch(`${base}/api/changes`, { method: "POST", headers, body: JSON.stringify({ id: "PAY-2", title: "需求", owner: "product" }) });
  let response = await fetch(`${base}/api/skills/install`, { method: "POST", headers, body: JSON.stringify({ packagePath: resolve(process.cwd(), "examples/skills/requirement-decompose") }) });
  assert.equal(response.status, 201); assert.equal(((await json(response)).manifest as Record<string, unknown>).id, "requirement.decompose");
  response = await fetch(`${base}/api/skills/requirement.decompose/runs`, { method: "POST", headers, body: JSON.stringify({ changeId: "PAY-2", input: { requirement: "支持批量取消；保留审计日志" } }) });
  assert.equal(response.status, 201); assert.equal((await json(response)).status, "succeeded");
  const snapshot = await json(await fetch(`${base}/api/snapshot`)); assert.equal((snapshot.runs as unknown[]).length, 1); assert.equal((snapshot.skills as unknown[]).length, 1);
});

test("UI API runs a declarative Workflow", async (t) => {
  const { base, ui } = await fixture(t); const headers = { "content-type": "application/json", "x-cjhx-ui-token": ui.token };
  for (const name of ["requirement-decompose", "test-case-generate"]) await fetch(`${base}/api/skills/install`, { method: "POST", headers, body: JSON.stringify({ packagePath: resolve(process.cwd(), `examples/skills/${name}`) }) });
  const definition = { id: "ui-workflow", version: "1.0.0", name: "UI Workflow", steps: [{ id: "decompose", skill: "requirement.decompose", input: { requirement: { $ref: "input.requirement" } } }, { id: "tests", skill: "test.case.generate", input: { feature: "批量取消", acceptanceCriteria: ["返回结果"], tasks: { $ref: "steps.decompose.output.tasks" } } }] };
  const response = await fetch(`${base}/api/workflows/runs`, { method: "POST", headers, body: JSON.stringify({ definition, input: { requirement: "支持批量取消；记录审计日志" } }) });
  assert.equal(response.status, 201); const run = await json(response); assert.equal(run.status, "succeeded"); assert.equal(run.workflowId, "ui-workflow");
});

test("UI refuses non-loopback binding", () => {
  const app = new CJHXFramework(".cjhx-test-ui");
  assert.throws(() => createUiServer(app, { host: "0.0.0.0", port: 0, open: false }), /loopback/);
});
