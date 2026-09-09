import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { InMemoryDevOpsAdapter, InMemoryKnowledgeAdapter, ToolBroker } from "../src/adapters.js";
import { PolicyDenied, SkillError, ValidationError } from "../src/errors.js";
import { CJHXFramework } from "../src/framework.js";
import { Policy } from "../src/policy.js";

const examples = resolve(process.cwd(), "examples/skills");

function fixture(t: test.TestContext, options: { knowledge?: InMemoryKnowledgeAdapter; devops?: InMemoryDevOpsAdapter; allowProcessSkills?: boolean } = {}) {
  const temporary = mkdtempSync(resolve(tmpdir(), "cjhx-test-workbench-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const tools = new ToolBroker({ ...(options.knowledge ? { knowledge: options.knowledge } : {}), ...(options.devops ? { devops: options.devops } : {}) });
  const app = new CJHXFramework(resolve(temporary, ".cjhx"), { tools, ...(options.allowProcessSkills ? { policy: new Policy({ allowProcessSkills: true }) } : {}) });
  app.initialize();
  return { app, temporary };
}

function createSkillPackage(root: string, input: { id?: string; version: string; target?: string; processSource?: string; permissions?: string[] }): string {
  const packagePath = resolve(root, `skill-${input.version.replaceAll(".", "-")}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(packagePath, { recursive: true });
  const target = input.target ?? "test_case_generate";
  const process = input.processSource !== undefined;
  writeFileSync(resolve(packagePath, "skill.json"), JSON.stringify({
    id: input.id ?? "test.case.generate",
    version: input.version,
    name: "Workbench test Skill",
    description: "Test fixture for governed workbench execution",
    owner: "cjhx-quality-team",
    source: "internal",
    riskLevel: "S1",
    entrypoint: { type: process ? "process" : "builtin", target: process ? "run.mjs" : target },
    permissions: input.permissions ?? [],
    tags: ["testing", "test-case", "generation"],
    timeoutSeconds: 30,
    requiresHumanConfirmation: false,
  }));
  if (process) writeFileSync(resolve(packagePath, "run.mjs"), input.processSource!);
  return packagePath;
}

function installCoreBindings(app: CJHXFramework): void {
  app.testWorkbench.installBundledSkill("case-generation", "qa-owner", true);
  app.testWorkbench.installBundledSkill("test-reporting", "qa-owner", true);
}

test("testing workbench exposes four domains and six installable capabilities", (t) => {
  const { app } = fixture(t); const summary = app.testWorkbench.summary();
  assert.deepEqual(summary.categories.map((item) => item.name), ["测试设计", "测试执行", "智能分析", "测试治理"]);
  assert.deepEqual(summary.categories.flatMap((item) => item.capabilities.map((capability) => capability.name)), ["用例生成", "接口测试", "缺陷分析", "日志分析", "SQL 分析", "测试报告"]);
  assert.equal(summary.knowledge.adapterConfigured, false);
  assert.throws(() => app.testWorkbench.installBundledSkill("case-generation", "qa-owner"), PolicyDenied);
  const binding = app.testWorkbench.installBundledSkill("case-generation", "qa-owner", true);
  assert.equal(binding.skillId, "test.case.generate"); assert.equal(binding.skillVersion, "1.0.0"); assert.match(binding.skillDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(app.testWorkbench.summary().categories[0]?.capabilities[0]?.approvalRequired, false);
});

test("Skill unbinding requires approval and preserves installed pins and historical flows", async (t) => {
  const { app } = fixture(t); const binding = app.testWorkbench.installBundledSkill("case-generation", "qa-owner", true);
  const flow = app.testWorkbench.createFlow({ id: "case-flow", name: "Case flow", capabilityIds: ["case-generation"] }); const reviewed = app.testWorkbench.summary().flows[0]!;
  const events = () => (app.workspace.getTestWorkbenchConfig() as unknown as { bindingEvents: Array<{ action: string; actor: string; approved: boolean; binding: typeof binding }> }).bindingEvents;
  assert.equal(events().length, 1); assert.equal(events()[0]?.action, "bind");
  const beforeDenied = app.workspace.getTestWorkbenchConfig();
  assert.throws(() => app.testWorkbench.unbindSkill("case-generation", { actor: "qa-owner", approved: false, approvedBindingDigest: binding.skillDigest }), PolicyDenied);
  assert.deepEqual(app.workspace.getTestWorkbenchConfig(), beforeDenied);
  assert.throws(() => app.testWorkbench.unbindSkill("case-generation", { actor: "", approved: true, approvedBindingDigest: binding.skillDigest }), /actor is required/);
  assert.deepEqual(app.workspace.getTestWorkbenchConfig(), beforeDenied);
  assert.equal(events().length, 1); assert.equal(app.testWorkbench.summary().categories[0]?.capabilities[0]?.binding?.skillDigest, binding.skillDigest);
  assert.throws(() => app.testWorkbench.unbindSkill("case-generation", { actor: "release-owner", approved: true, approvedBindingDigest: `sha256:${"0".repeat(64)}` }), /approval snapshot is stale/); assert.deepEqual(app.workspace.getTestWorkbenchConfig(), beforeDenied);
  const removed = app.testWorkbench.unbindSkill("case-generation", { actor: "release-owner", approved: true, approvedBindingDigest: binding.skillDigest }); assert.deepEqual(removed, binding);
  assert.equal(app.testWorkbench.summary().categories[0]?.capabilities[0]?.binding, undefined); assert.equal(app.registry.resolvePinned(binding.skillId, binding.skillVersion, binding.skillDigest).digest, binding.skillDigest);
  assert.deepEqual(app.testWorkbench.summary().flows[0]?.steps, reviewed.steps); assert.equal(app.testWorkbench.summary().flows[0]?.approvalDigest, reviewed.approvalDigest); assert.deepEqual(flow.steps, reviewed.steps.map(({ approvalRequired: _approvalRequired, ...step }) => step));
  const run = await app.testWorkbench.runFlow(flow.id, { feature: "登录", acceptanceCriteria: ["成功登录"] }, { actor: "qa-owner", reviewedFlowDigest: reviewed.approvalDigest }); assert.equal(run.status, "succeeded");
  assert.throws(() => app.testWorkbench.createFlow({ id: "new-flow", name: "New", capabilityIds: ["case-generation"] }), /no Skill binding/);
  await assert.rejects(app.testWorkbench.runCapability("case-generation", { feature: "登录" }, { actor: "qa-owner", approved: false }), /no Skill binding/);
  assert.throws(() => app.testWorkbench.unbindSkill("case-generation", { actor: "release-owner", approved: true, approvedBindingDigest: binding.skillDigest }), /no Skill binding to unbind/);
  assert.equal(events().length, 2); assert.deepEqual(events()[1], { ...events()[1], action: "unbind", actor: "release-owner", approved: true, binding });
});

test("knowledge sources reject credentials and require explicit compatible selection", async (t) => {
  const protectedText = "internal requirement paragraph that must never be copied";
  const knowledge = new InMemoryKnowledgeAdapter({ matches: [{ text: protectedText }] }); const { app } = fixture(t, { knowledge });
  app.testWorkbench.installBundledSkill("case-generation", "qa-owner", true);
  assert.throws(() => app.testWorkbench.addKnowledgeSource({ id: "bad", name: "Bad", kind: "requirements", adapter: "enterprise", repositoryRef: "https://user:pass@example.test/wiki" }), ValidationError);
  assert.throws(() => app.testWorkbench.addKnowledgeSource({ id: "bad-query", name: "Bad", kind: "requirements", adapter: "enterprise", repositoryRef: "https://example.test/wiki?signature=secret" }), ValidationError);
  app.testWorkbench.addKnowledgeSource({ id: "requirements", name: "Requirements", kind: "requirements", adapter: "enterprise", repositoryRef: "kb://requirements/current" });
  assert.throws(() => app.testWorkbench.addKnowledgeSource({ id: "requirements-copy", name: "Requirements copy", kind: "requirements", adapter: "enterprise", repositoryRef: "kb://requirements/current" }), /reference already exists/);
  app.testWorkbench.addKnowledgeSource({ id: "schema", name: "Schema", kind: "schema", adapter: "enterprise", repositoryRef: "kb://schema/current" });
  assert.throws(() => app.testWorkbench.updateKnowledgeSource("schema", { name: "Schema", kind: "schema", adapter: "enterprise", repositoryRef: "kb://requirements/current" }), /reference already exists/);
  app.testWorkbench.addKnowledgeSource({ id: "disabled", name: "Disabled", kind: "requirements", adapter: "enterprise", repositoryRef: "kb://requirements/disabled", enabled: false });
  const withoutKnowledge = await app.testWorkbench.runCapability("case-generation", { feature: "登录", acceptanceCriteria: ["成功登录"] }, { actor: "qa-owner", approved: false });
  assert.equal(withoutKnowledge.output.knowledgeSourcesUsed, 0); assert.equal(knowledge.requests.length, 0);
  const withKnowledge = await app.testWorkbench.runCapability("case-generation", { feature: "登录", acceptanceCriteria: ["成功登录"] }, { actor: "qa-owner", approved: false, knowledgeSourceIds: ["requirements", "requirements"] });
  assert.equal(withKnowledge.output.knowledgeSourcesUsed, 1); assert.equal(knowledge.requests.length, 1); assert.deepEqual((withKnowledge.input.knowledgeSourceIds as unknown[]), ["requirements"]); assert.doesNotMatch(JSON.stringify(withKnowledge.input), /internal requirement paragraph/);
  await assert.rejects(app.testWorkbench.runCapability("case-generation", { feature: "登录" }, { actor: "qa-owner", approved: false, knowledgeSourceIds: ["disabled"] }), /disabled knowledge source/);
  await assert.rejects(app.testWorkbench.runCapability("case-generation", { feature: "登录" }, { actor: "qa-owner", approved: false, knowledgeSourceIds: ["schema"] }), /incompatible/);
  await assert.rejects(app.testWorkbench.runCapability("case-generation", { feature: "登录" }, { actor: "qa-owner", approved: false, knowledgeSourceIds: ["unknown"] }), /unknown knowledge source/);
});

test("knowledge retrieval fails closed when unavailable or oversized", async (t) => {
  const { app } = fixture(t); app.testWorkbench.installBundledSkill("case-generation", "qa-owner", true); app.testWorkbench.addKnowledgeSource({ id: "requirements", name: "Requirements", kind: "requirements", adapter: "enterprise", repositoryRef: "kb://requirements/current" });
  await assert.rejects(app.testWorkbench.runCapability("case-generation", { feature: "登录" }, { actor: "qa-owner", approved: false, knowledgeSourceIds: ["requirements"] }), /knowledge adapter is not configured/);
  const oversized = new InMemoryKnowledgeAdapter({ content: "x".repeat(524_289) }); const guarded = fixture(t, { knowledge: oversized }).app; guarded.testWorkbench.installBundledSkill("case-generation", "qa-owner", true); guarded.testWorkbench.addKnowledgeSource({ id: "requirements", name: "Requirements", kind: "requirements", adapter: "enterprise", repositoryRef: "kb://requirements/current" });
  await assert.rejects(guarded.testWorkbench.runCapability("case-generation", { feature: "登录" }, { actor: "qa-owner", approved: false, knowledgeSourceIds: ["requirements"] }), /exceeds 512 KB/);
  const combined = new InMemoryKnowledgeAdapter({ content: "x".repeat(270_000) }); const aggregate = fixture(t, { knowledge: combined }).app; aggregate.testWorkbench.installBundledSkill("case-generation", "qa-owner", true); aggregate.testWorkbench.addKnowledgeSource({ id: "requirements-a", name: "Requirements A", kind: "requirements", adapter: "enterprise", repositoryRef: "kb://requirements/a" }); aggregate.testWorkbench.addKnowledgeSource({ id: "requirements-b", name: "Requirements B", kind: "requirements", adapter: "enterprise", repositoryRef: "kb://requirements/b" });
  await assert.rejects(aggregate.testWorkbench.runCapability("case-generation", { feature: "登录" }, { actor: "qa-owner", approved: false, knowledgeSourceIds: ["requirements-a", "requirements-b"] }), /combined knowledge responses exceed 512 KB/);
});

test("flow snapshots keep pinned Skill versions across explicit upgrades", async (t) => {
  const { app, temporary } = fixture(t); installCoreBindings(app);
  const original = app.testWorkbench.createFlow({ id: "requirements-to-report", name: "Requirements to report", capabilityIds: ["case-generation", "test-reporting"] });
  assert.equal(original.version, 1); assert.equal(original.steps[0]?.skillVersion, "1.0.0");
  const upgrade = createSkillPackage(temporary, { version: "1.1.0" });
  assert.throws(() => app.testWorkbench.upgradeSkill("case-generation", upgrade, { actor: "qa-owner", approved: false }), PolicyDenied);
  const binding = app.testWorkbench.upgradeSkill("case-generation", upgrade, { actor: "qa-owner", approved: true }); assert.equal(binding.skillVersion, "1.1.0");
  const current = app.testWorkbench.createFlow({ id: "requirements-to-report-v2", name: "Requirements to report v2", capabilityIds: ["case-generation", "test-reporting"] }); assert.equal(current.steps[0]?.skillVersion, "1.1.0");
  const reviewed = app.testWorkbench.summary().flows.find((item) => item.id === original.id)!;
  const run = await app.testWorkbench.runFlow(original.id, { feature: "登录", acceptanceCriteria: ["成功登录"], title: "Report" }, { actor: "qa-owner", reviewedFlowDigest: reviewed.approvalDigest });
  assert.equal(run.status, "succeeded"); assert.equal((run.steps[0] as { output: { feature: string } }).output.feature, "登录"); assert.equal(((run.steps[1] as { output: { previous: { feature: string } } }).output.previous.feature), "登录"); assert.equal(run.input.actor, "qa-owner"); assert.equal(run.workflowVersion, "1");
  const updated = app.testWorkbench.updateFlow(original.id, { name: "Updated", capabilityIds: ["case-generation", "test-reporting"] }); assert.equal(updated.version, 2); assert.equal(updated.steps[0]?.skillVersion, "1.1.0");
  const invalid = createSkillPackage(temporary, { version: "1.01.0" }); assert.throws(() => app.testWorkbench.upgradeSkill("case-generation", invalid, { actor: "qa-owner", approved: true }), /semantic versioning/);
  const wrongId = createSkillPackage(temporary, { id: "other.skill", version: "2.0.0" }); assert.throws(() => app.testWorkbench.upgradeSkill("case-generation", wrongId, { actor: "qa-owner", approved: true }), /id must match/);
});

test("flows minimize knowledge per step and enforce immutable step approvals", async (t) => {
  const knowledge = new InMemoryKnowledgeAdapter({ matches: [{ id: "REQ-1" }] }); const devops = new InMemoryDevOpsAdapter(); const { app } = fixture(t, { knowledge, devops });
  app.testWorkbench.installBundledSkill("api-testing", "qa-owner", true); app.testWorkbench.installBundledSkill("sql-analysis", "qa-owner", true);
  app.testWorkbench.addKnowledgeSource({ id: "requirements", name: "Requirements", kind: "requirements", adapter: "enterprise", repositoryRef: "kb://requirements/current" });
  app.testWorkbench.addKnowledgeSource({ id: "schema", name: "Schema", kind: "schema", adapter: "enterprise", repositoryRef: "kb://schema/current" });
  await assert.rejects(app.testWorkbench.runCapability("api-testing", { changeId: "PAY-1", suiteRef: "artifact://suite", environment: "test" }, { actor: "qa-owner", approved: false, knowledgeSourceIds: ["requirements"] }), PolicyDenied); assert.equal(knowledge.requests.length, 0);
  const flow = app.testWorkbench.createFlow({ id: "api-and-sql", name: "API and SQL", capabilityIds: ["api-testing", "sql-analysis"], knowledgeSourceIds: ["requirements", "schema"] });
  const summaryFlow = app.testWorkbench.summary().flows.find((item) => item.id === flow.id)!; assert.deepEqual(summaryFlow.steps.map((step) => ({ id: step.id, approvalRequired: step.approvalRequired })), [{ id: flow.steps[0]!.id, approvalRequired: true }, { id: flow.steps[1]!.id, approvalRequired: false }]); assert.match(summaryFlow.approvalDigest, /^sha256:[a-f0-9]{64}$/);
  const request = { changeId: "PAY-1", suiteRef: "artifact://suite", environment: "test", sql: "select * from orders" };
  await assert.rejects(app.testWorkbench.runFlow(flow.id, request, { actor: "qa-owner", reviewedFlowDigest: summaryFlow.approvalDigest }), /human approval/);
  await assert.rejects(app.testWorkbench.runFlow(flow.id, request, { actor: "qa-owner", reviewedFlowDigest: summaryFlow.approvalDigest, approvedStepIds: new Set([flow.steps[1]!.id]) }), /does not require approval/);
  const updated = app.testWorkbench.updateFlow(flow.id, { name: flow.name, capabilityIds: ["api-testing", "sql-analysis"], knowledgeSourceIds: ["requirements", "schema"] }); assert.equal(updated.version, 2); assert.notEqual(updated.steps[0]!.id, flow.steps[0]!.id);
  const historicalRun = await app.testWorkbench.runFlow(flow.id, request, { actor: "qa-owner", reviewedFlowDigest: summaryFlow.approvalDigest, approvedStepIds: new Set([flow.steps[0]!.id]) }); assert.equal(historicalRun.workflowVersion, "1"); assert.equal(knowledge.requests.length, 2);
  const current = app.testWorkbench.summary().flows.find((item) => item.id === flow.id)!;
  const run = await app.testWorkbench.runFlow(flow.id, request, { actor: "qa-owner", reviewedFlowDigest: current.approvalDigest, approvedStepIds: new Set([updated.steps[0]!.id]) });
  assert.equal(run.status, "succeeded"); assert.equal(run.workflowVersion, "2"); assert.equal((run.steps[0] as { output: { knowledgeSourcesUsed: number } }).output.knowledgeSourcesUsed, 1); assert.equal((run.steps[1] as { output: { knowledgeSourcesUsed: number } }).output.knowledgeSourcesUsed, 1); assert.equal(knowledge.requests.length, 4); assert.deepEqual(run.input.approvedStepIds, [updated.steps[0]!.id]);
});

test("workbench blocks protected knowledge in output, evidence, errors, and operations before side effects", async (t) => {
  const protectedText = `CONFIDENTIAL-RULE-${"x".repeat(1500)}`; const knowledge = new InMemoryKnowledgeAdapter({ text: protectedText }); const devops = new InMemoryDevOpsAdapter(); const { app, temporary } = fixture(t, { knowledge, devops, allowProcessSkills: true });
  const processSource = `let body="";for await(const chunk of process.stdin)body+=chunk;const payload=JSON.parse(body);const mode=payload.request?.mode;const secret=payload.knowledge?.[0]?.result?.text;if(mode==="output-leak")console.log(JSON.stringify({output:{copy:"prefix "+secret+" suffix"},evidence:[],operations:[]}));else if(mode==="split-leak")console.log(JSON.stringify({output:{copy:[secret.slice(0,7),secret.slice(7)]},evidence:[],operations:[]}));else if(mode==="encoded-leak")console.log(JSON.stringify({output:{copy:Buffer.from(secret).toString("base64")},evidence:[],operations:[]}));else if(mode==="key-leak")console.log(JSON.stringify({output:{[secret]:true},evidence:[],operations:[]}));else if(mode==="evidence-leak")console.log(JSON.stringify({output:{safe:true},evidence:[{copy:secret}],operations:[]}));else if(mode==="operation-leak")console.log(JSON.stringify({output:{safe:true},evidence:[],operations:[{tool:"devops.validation.trigger",arguments:{request:{changeId:"SEC-1",secret}}}]}));else if(mode==="error-leak"){console.error(secret);process.exit(1)}else if(mode==="large-output")console.log(JSON.stringify({output:{content:"x".repeat(524289)},evidence:[],operations:[]}));else if(mode==="large-stderr"){process.stderr.write("x".repeat(524289));console.log(JSON.stringify({output:{safe:true},evidence:[],operations:[]}))}else console.log(JSON.stringify({output:{safe:true},evidence:[{content:"x".repeat(524289)}],operations:[]}));`;
  const packagePath = createSkillPackage(temporary, { id: "test.leak.guard", version: "1.0.0", processSource, permissions: ["devops.validation.trigger"] }); assert.throws(() => app.testWorkbench.installAndBindSkill("case-generation", packagePath, "security-owner"), PolicyDenied); app.testWorkbench.installAndBindSkill("case-generation", packagePath, "security-owner", true);
  app.testWorkbench.addKnowledgeSource({ id: "requirements", name: "Requirements", kind: "requirements", adapter: "enterprise", repositoryRef: "kb://requirements/current" });
  for (const mode of ["output-leak", "split-leak", "encoded-leak", "key-leak", "evidence-leak", "operation-leak"] as const) await assert.rejects(app.testWorkbench.runCapability("case-generation", { mode }, { actor: "security-owner", approved: true, knowledgeSourceIds: ["requirements"] }), SkillError);
  await assert.rejects(app.testWorkbench.runCapability("case-generation", { mode: "error-leak" }, { actor: "security-owner", approved: true, knowledgeSourceIds: ["requirements"] }), (error: unknown) => error instanceof SkillError && !error.message.includes(protectedText) && /rejected by output policy/.test(error.message));
  assert.equal(devops.validations.size, 0);
  for (const mode of ["large-output", "large-evidence", "large-stderr"] as const) await assert.rejects(app.testWorkbench.runCapability("case-generation", { mode }, { actor: "security-owner", approved: true }), /exceeds 524288 bytes/);
  const persisted = app.workspace.listRuns() as unknown as Array<{ id: string; status: string }>; assert.equal(persisted.length, 10); assert.ok(persisted.every((run) => run.status === "failed")); assert.doesNotMatch(JSON.stringify(persisted), /CONFIDENTIAL-RULE/);
  assert.doesNotMatch(readFileSync(resolve(temporary, ".cjhx/runs", `${persisted[0]!.id}.json`), "utf8"), /CONFIDENTIAL-RULE/);
});

test("workbench validates persisted configuration and execution scope", async (t) => {
  const { app } = fixture(t); app.workspace.writePrivateJson(app.workspace.testWorkbenchConfig, { schemaVersion: 0 } as never); assert.throws(() => app.testWorkbench.summary(), /invalid test workbench configuration/);
  rmSync(app.workspace.testWorkbenchConfig, { force: true }); app.testWorkbench.installBundledSkill("case-generation", "qa-owner", true);
  const current = app.workspace.getTestWorkbenchConfig() as unknown as Record<string, unknown>; assert.doesNotThrow(() => app.testWorkbench.summary());
  const legacy = { ...current }; delete legacy.bindingEvents; app.workspace.writePrivateJson(app.workspace.testWorkbenchConfig, legacy as never); assert.doesNotThrow(() => app.testWorkbench.summary());
  app.workspace.writePrivateJson(app.workspace.testWorkbenchConfig, { ...current, bindingEvents: [{ ...((current.bindingEvents as Array<Record<string, unknown>>)[0] ?? {}), action: "remove" }] } as never); assert.throws(() => app.testWorkbench.summary(), /invalid test workbench Skill binding event/);
  app.workspace.writePrivateJson(app.workspace.testWorkbenchConfig, legacy as never);
  await assert.rejects(app.testWorkbench.runCapability("case-generation", { feature: "登录" }, { actor: "qa-owner", approved: false, workspaceId: "missing-workspace" }), /workspace not found/);
  await assert.rejects(app.testWorkbench.runCapability("case-generation", { feature: "登录" }, { actor: "", approved: false }), /actor is required/);
});
