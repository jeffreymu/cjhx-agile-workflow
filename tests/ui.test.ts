import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { InMemoryDevOpsAdapter, InMemoryJiraAdapter, ToolBroker } from "../src/adapters.js";
import { CJHXFramework } from "../src/framework.js";
import { createUiServer } from "../src/ui.js";

async function fixture(t: test.TestContext, options: { jira?: InMemoryJiraAdapter; devops?: InMemoryDevOpsAdapter } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-ui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = new CJHXFramework(resolve(root, ".cjhx"), { ...((options.jira || options.devops) ? { tools: new ToolBroker({ ...(options.jira ? { jira: options.jira } : {}), ...(options.devops ? { devops: options.devops } : {}) }) } : {}) }); app.initialize();
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

test("UI API creates, imports, and transitions board tasks", async (t) => {
  const { base, ui } = await fixture(t); const headers = { "content-type": "application/json", "x-cjhx-ui-token": ui.token };
  await fetch(`${base}/api/changes`, { method: "POST", headers, body: JSON.stringify({ id: "PAY-3", title: "任务看板", owner: "product" }) });
  let response = await fetch(`${base}/api/tasks`, { method: "POST", headers, body: JSON.stringify({ changeId: "PAY-3", title: "实现接口", owner: "backend", priority: "P1", riskLevel: "L2", acceptanceCriteria: ["返回逐单结果"] }) });
  assert.equal(response.status, 201); const task = await json(response); assert.equal(task.status, "todo"); assert.equal(task.authority, "local-draft");
  response = await fetch(`${base}/api/tasks/${task.id as string}/transitions`, { method: "POST", headers, body: JSON.stringify({ target: "in_progress", actor: "backend", reason: "started" }) });
  assert.equal(response.status, 200); assert.equal((await json(response)).status, "in_progress");
  await fetch(`${base}/api/skills/install`, { method: "POST", headers, body: JSON.stringify({ packagePath: resolve(process.cwd(), "examples/skills/requirement-decompose") }) });
  response = await fetch(`${base}/api/skills/requirement.decompose/runs`, { method: "POST", headers, body: JSON.stringify({ changeId: "PAY-3", input: { requirement: "实现审计；补充文档" } }) }); const run = await json(response);
  response = await fetch(`${base}/api/runs/${run.id as string}/tasks/import`, { method: "POST", headers, body: JSON.stringify({ changeId: "PAY-3" }) }); assert.equal(response.status, 201); assert.equal((await response.json() as unknown[]).length, 2);
  const snapshot = await json(await fetch(`${base}/api/snapshot`)); assert.equal((snapshot.tasks as unknown[]).length, 3); assert.deepEqual(snapshot.integrations, { jiraConfigured: false, devopsConfigured: false });
});

test("UI API publishes and synchronizes Jira-owned tasks", async (t) => {
  const jira = new InMemoryJiraAdapter(); const { base, ui } = await fixture(t, { jira }); const headers = { "content-type": "application/json", "x-cjhx-ui-token": ui.token };
  await fetch(`${base}/api/changes`, { method: "POST", headers, body: JSON.stringify({ id: "PAY-4", title: "Jira task", owner: "product" }) });
  let response = await fetch(`${base}/api/tasks`, { method: "POST", headers, body: JSON.stringify({ changeId: "PAY-4", title: "发布任务", owner: "backend" }) }); const draft = await json(response);
  response = await fetch(`${base}/api/tasks/${draft.id as string}/jira/publish`, { method: "POST", headers, body: JSON.stringify({ approved: false }) }); assert.equal(response.status, 400);
  response = await fetch(`${base}/api/tasks/${draft.id as string}/jira/publish`, { method: "POST", headers, body: JSON.stringify({ approved: true }) }); assert.equal(response.status, 200); const published = await json(response); assert.equal(published.authority, "jira");
  jira.setStatus(published.jiraIssueKey as string, "Review"); response = await fetch(`${base}/api/tasks/${draft.id as string}/jira/sync`, { method: "POST", headers, body: "{}" }); assert.equal(response.status, 200); assert.equal((await json(response)).status, "review");
  const snapshot = await json(await fetch(`${base}/api/snapshot`)); assert.deepEqual(snapshot.integrations, { jiraConfigured: true, devopsConfigured: false });
});

test("UI API displays and operates DevOps projections with approval", async (t) => {
  const devops = new InMemoryDevOpsAdapter(); devops.pipelines.set("pay-ci", { id: "pay-ci", name: "支付 CI", kind: "ci", changeId: "PAY-5", status: "healthy" }); devops.artifacts.set("artifact-1", { artifactId: "artifact-1", name: "payment-api", version: "1.0.0", changeId: "PAY-5", status: "ready" }); devops.services.set("payment-api", { id: "payment-api", name: "支付服务", environment: "test", changeId: "PAY-5", status: "running" });
  const { base, ui } = await fixture(t, { devops }); const headers = { "content-type": "application/json", "x-cjhx-ui-token": ui.token };
  let response = await fetch(`${base}/api/devops/overview?changeId=PAY-5`); assert.equal(response.status, 200); const overview = await json(response); assert.equal((overview.pipelines as unknown[]).length, 1); assert.equal((overview.artifacts as unknown[]).length, 1);
  response = await fetch(`${base}/api/devops/pipelines/trigger`, { method: "POST", headers, body: JSON.stringify({ pipelineId: "pay-ci", kind: "ci", actor: "owner", reason: "build", approved: false }) }); assert.equal(response.status, 400);
  response = await fetch(`${base}/api/devops/pipelines/trigger`, { method: "POST", headers, body: JSON.stringify({ pipelineId: "pay-ci", kind: "ci", changeId: "PAY-5", actor: "owner", reason: "build", approved: true }) }); assert.equal(response.status, 202); assert.equal((await json(response)).status, "running");
  response = await fetch(`${base}/api/devops/services/control`, { method: "POST", headers, body: JSON.stringify({ serviceId: "payment-api", action: "stop", actor: "operator", reason: "maintenance", approved: true }) }); assert.equal(response.status, 202); assert.equal((await json(response)).status, "stopped");
  const snapshot = await json(await fetch(`${base}/api/snapshot`)); assert.deepEqual(snapshot.integrations, { jiraConfigured: false, devopsConfigured: true });
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
