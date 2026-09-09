import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterError, PolicyDenied, ValidationError } from "./errors.js";
import type { JsonObject, JsonValue, SkillManifest, SkillRun } from "./models.js";
import { isRecord, utcNow } from "./models.js";
import { SkillRegistry, SkillRuntime } from "./skills.js";
import { Workspace } from "./storage.js";
import { WorkflowRuntime, type WorkflowDefinition, type WorkflowRun } from "./workflows.js";
import type { ToolBroker } from "./adapters.js";

export const testCapabilityCategories = ["test-design", "test-execution", "intelligent-analysis", "test-governance"] as const;
export type TestCapabilityCategory = (typeof testCapabilityCategories)[number];
export const knowledgeSourceKinds = ["historical-cases", "defects", "requirements", "log-standards", "schema", "sql-standards"] as const;
export type KnowledgeSourceKind = (typeof knowledgeSourceKinds)[number];
export const testCapabilityIds = ["case-generation", "api-testing", "defect-analysis", "test-reporting", "log-analysis", "sql-analysis"] as const;
export type TestCapabilityId = (typeof testCapabilityIds)[number];

export interface TestCapabilityDefinition {
  id: TestCapabilityId;
  category: TestCapabilityCategory;
  name: string;
  description: string;
  knowledgeKinds: KnowledgeSourceKind[];
  skillTags: string[];
  bundledSkill: { id: string; version: string };
}
export interface TestSkillBinding { capabilityId: TestCapabilityId; skillId: string; skillVersion: string; skillDigest: string; boundAt: string; boundBy: string }
export interface TestSkillBindingEvent { id: string; action: "bind" | "unbind"; actor: string; approved: true; occurredAt: string; binding: TestSkillBinding }
export interface TestKnowledgeSource { id: string; name: string; kind: KnowledgeSourceKind; adapter: string; repositoryRef: string; enabled: boolean; createdAt: string; updatedAt: string }
export interface TestFlowStep { id: string; capabilityId: TestCapabilityId; skillId: string; skillVersion: string; skillDigest: string }
export interface TestFlow { id: string; name: string; description: string; steps: TestFlowStep[]; knowledgeSourceIds: string[]; version: number; createdAt: string; updatedAt: string }
export interface TestWorkbenchConfig { schemaVersion: 1; knowledgeSources: TestKnowledgeSource[]; bindings: TestSkillBinding[]; bindingEvents: TestSkillBindingEvent[]; flows: TestFlow[] }
export interface TestCapabilitySummary extends TestCapabilityDefinition { binding?: TestSkillBinding; approvalRequired?: boolean }
export interface TestFlowSummary extends Omit<TestFlow, "steps"> { approvalDigest: string; steps: Array<TestFlowStep & { approvalRequired: boolean }> }
export interface TestWorkbenchSummary { categories: Array<{ id: TestCapabilityCategory; name: string; description: string; capabilities: TestCapabilitySummary[] }>; knowledge: { adapterConfigured: boolean; sources: TestKnowledgeSource[] }; flows: TestFlowSummary[] }

const testWorkbenchByteLimit = 524_288;
const testWorkbenchSourceLimit = 20;

const categoryDetails: Record<TestCapabilityCategory, { name: string; description: string }> = {
  "test-design": { name: "测试设计", description: "结合需求说明和历史用例沉淀高质量测试资产" },
  "test-execution": { name: "测试执行", description: "通过受控 Skill 与企业 DevOps 能力执行接口验证" },
  "intelligent-analysis": { name: "智能分析", description: "关联缺陷、日志、表结构和规范定位问题" },
  "test-governance": { name: "测试治理", description: "汇总过程事实，形成可追溯测试报告" },
};
export const testCapabilities: TestCapabilityDefinition[] = [
  { id: "case-generation", category: "test-design", name: "用例生成", description: "从需求与历史用例生成覆盖正常、边界和异常路径的用例", knowledgeKinds: ["requirements", "historical-cases", "defects"], skillTags: ["test-case", "generation"], bundledSkill: { id: "test.case.generate", version: "1.0.0" } },
  { id: "api-testing", category: "test-execution", name: "接口测试", description: "生成或执行接口验证，并保留环境与结果引用", knowledgeKinds: ["requirements", "historical-cases", "defects"], skillTags: ["api"], bundledSkill: { id: "api-test.execute", version: "1.0.0" } },
  { id: "defect-analysis", category: "intelligent-analysis", name: "缺陷分析", description: "关联历史缺陷、需求和测试结果分析根因与影响范围", knowledgeKinds: ["defects", "requirements", "historical-cases"], skillTags: ["defect", "analysis"], bundledSkill: { id: "test.defect.analyze", version: "1.0.0" } },
  { id: "log-analysis", category: "intelligent-analysis", name: "日志分析", description: "依据日志规范提取异常模式、时间线和关联线索", knowledgeKinds: ["log-standards", "defects", "requirements"], skillTags: ["logs", "analysis"], bundledSkill: { id: "test.log.analyze", version: "1.0.0" } },
  { id: "sql-analysis", category: "intelligent-analysis", name: "SQL 分析", description: "依据表结构与 SQL 规范分析正确性、风险和性能问题", knowledgeKinds: ["schema", "sql-standards", "defects"], skillTags: ["sql", "analysis"], bundledSkill: { id: "test.sql.analyze", version: "1.0.0" } },
  { id: "test-reporting", category: "test-governance", name: "测试报告", description: "汇总用例、执行结果、缺陷与分析结论形成可追溯报告", knowledgeKinds: ["requirements", "historical-cases", "defects"], skillTags: ["report"], bundledSkill: { id: "test.report.generate", version: "1.0.0" } },
];

function identifier(value: string, label: string): string { const result = value.trim(); if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) throw new ValidationError(`${label} contains unsupported characters`); return result; }
function required(value: string, label: string, maximum = 500): string { const result = value.trim(); if (!result) throw new ValidationError(`${label} is required`); if (result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new ValidationError(`${label} is invalid`); return result; }
function capability(id: string): TestCapabilityDefinition { const result = testCapabilities.find((item) => item.id === id); if (!result) throw new ValidationError(`unknown test capability: ${id}`); return result; }
function semanticVersion(value: string): { core: number[]; prerelease: string[] } {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) throw new ValidationError(`Skill version must use semantic versioning: ${value}`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^0\d+$/.test(part))) throw new ValidationError(`Skill version must use semantic versioning: ${value}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease };
}
function compareVersions(a: string, b: string): number {
  const left = semanticVersion(a); const right = semanticVersion(b);
  for (let index = 0; index < 3; index += 1) { const difference = left.core[index]! - right.core[index]!; if (difference) return difference; }
  if (!left.prerelease.length || !right.prerelease.length) return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const l = left.prerelease[index]; const r = right.prerelease[index]; if (l === undefined) return -1; if (r === undefined) return 1;
    const ln = /^\d+$/.test(l); const rn = /^\d+$/.test(r); if (ln && rn) { const difference = Number(l) - Number(r); if (difference) return difference; } else if (ln !== rn) return ln ? -1 : 1; else { const difference = l.localeCompare(r, "en"); if (difference) return difference; }
  }
  return 0;
}
function skillIdentifier(value: string): string { const result = required(value, "Skill id", 200); if (!/^[a-z0-9][a-z0-9._-]*$/.test(result)) throw new ValidationError("Skill id contains unsupported characters"); return result; }
function repositoryReference(value: string): string {
  const result = required(value, "knowledge repository reference", 2_048);
  if (/(?:authorization|auth|credential|password|private[_-]?key|secret|signature|access[_-]?token|api[_-]?key|token|bearer)\s*[=:]/i.test(result)) throw new ValidationError("knowledge repository reference must not contain credentials");
  try { const url = new URL(result); if (url.username || url.password) throw new ValidationError("knowledge repository reference must not contain URL credentials"); for (const key of url.searchParams.keys()) if (/(?:auth|credential|password|secret|signature|token|key|sas)/i.test(key)) throw new ValidationError("knowledge repository reference must not contain credential query parameters"); }
  catch (error) { if (error instanceof ValidationError) throw error; }
  return result;
}
function timestamp(value: string, label: string): string { const result = required(value, label, 80); if (Number.isNaN(Date.parse(result))) throw new ValidationError(`${label} is invalid`); return result; }
function description(value: string | undefined, label: string): string { if (value === undefined) return ""; const result = value.trim(); if (result.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) throw new ValidationError(`${label} is invalid`); return result; }
function emptyConfig(): TestWorkbenchConfig { return { schemaVersion: 1, knowledgeSources: [], bindings: [], bindingEvents: [], flows: [] }; }

export class TestWorkbenchService {
  constructor(readonly workspace: Workspace, readonly registry: SkillRegistry, readonly skills: SkillRuntime, readonly workflows: WorkflowRuntime, readonly tools: ToolBroker, readonly scope?: { workspace(id: string): unknown }) {}

  summary(): TestWorkbenchSummary {
    const config = this.config();
    return {
      categories: testCapabilityCategories.map((id) => ({
        id, ...categoryDetails[id],
        capabilities: testCapabilities.filter((item) => item.category === id).map((item) => { const binding = config.bindings.find((candidate) => candidate.capabilityId === item.id); if (!binding) return item; const resolved = this.registry.resolvePinned(binding.skillId, binding.skillVersion, binding.skillDigest); this.assertCompatible(item, resolved.manifest); return { ...item, binding, approvalRequired: this.skills.policy.requiresApproval(resolved.manifest) }; }),
      })),
      knowledge: { adapterConfigured: this.tools.hasAdapter("knowledge"), sources: config.knowledgeSources },
      flows: this.latestFlows(config.flows).map((flow) => { const approval = this.flowApproval(flow); return { ...flow, approvalDigest: approval.digest, steps: approval.steps }; }), 
    };
  }

  addKnowledgeSource(input: { id: string; name: string; kind: KnowledgeSourceKind; adapter: string; repositoryRef: string; enabled?: boolean }): TestKnowledgeSource {
    if (!knowledgeSourceKinds.includes(input.kind)) throw new ValidationError("invalid knowledge source kind");
    const config = this.config(); const id = identifier(input.id, "knowledge source id");
    if (config.knowledgeSources.some((item) => item.id === id)) throw new ValidationError(`knowledge source already exists: ${id}`);
    const adapter = identifier(input.adapter, "knowledge adapter"); const reference = repositoryReference(input.repositoryRef); this.assertUniqueKnowledgeReference(config, adapter, reference);
    const now = utcNow(); const source: TestKnowledgeSource = { id, name: required(input.name, "knowledge source name", 120), kind: input.kind, adapter, repositoryRef: reference, enabled: input.enabled !== false, createdAt: now, updatedAt: now };
    config.knowledgeSources.push(source); this.save(config); return source;
  }

  updateKnowledgeSource(id: string, input: { name: string; kind: KnowledgeSourceKind; adapter: string; repositoryRef: string; enabled?: boolean }): TestKnowledgeSource {
    if (!knowledgeSourceKinds.includes(input.kind)) throw new ValidationError("invalid knowledge source kind");
    const config = this.config(); const index = config.knowledgeSources.findIndex((item) => item.id === identifier(id, "knowledge source id")); if (index < 0) throw new ValidationError(`knowledge source not found: ${id}`); const existing = config.knowledgeSources[index]!;
    const adapter = identifier(input.adapter, "knowledge adapter"); const reference = repositoryReference(input.repositoryRef); this.assertUniqueKnowledgeReference(config, adapter, reference, existing.id);
    const source: TestKnowledgeSource = { ...existing, name: required(input.name, "knowledge source name", 120), kind: input.kind, adapter, repositoryRef: reference, enabled: input.enabled !== false, updatedAt: utcNow() };
    config.knowledgeSources[index] = source; this.save(config); return source;
  }

  removeKnowledgeSource(id: string): void {
    const config = this.config(); const safeId = identifier(id, "knowledge source id");
    if (!config.knowledgeSources.some((item) => item.id === safeId)) throw new ValidationError(`knowledge source not found: ${safeId}`);
    if (config.flows.some((flow) => flow.knowledgeSourceIds.includes(safeId))) throw new ValidationError("knowledge source is referenced by a test flow");
    config.knowledgeSources = config.knowledgeSources.filter((item) => item.id !== safeId); this.save(config);
  }

  installBundledSkill(capabilityId: string, actor: string, approved = false): TestSkillBinding {
    const definition = capability(capabilityId); const validatedActor = required(actor, "actor", 120); if (!approved) throw new PolicyDenied("test workbench Skill installation requires human approval"); const folders: Record<TestCapabilityId, string> = { "case-generation": "test-case-generate", "api-testing": "api-test-execute", "defect-analysis": "test-defect-analyze", "test-reporting": "test-report-generate", "log-analysis": "test-log-analyze", "sql-analysis": "test-sql-analyze" };
    const moduleRoot = dirname(fileURLToPath(import.meta.url)); const roots = [resolve(moduleRoot, "../../examples/skills"), resolve(moduleRoot, "../examples/skills")]; const packagePath = roots.map((root) => resolve(root, folders[definition.id])).find(existsSync);
    if (!packagePath) throw new ValidationError("bundled test Skills are unavailable in this installation"); const candidate = this.registry.loadManifest(packagePath);
    if (candidate.id !== definition.bundledSkill.id || candidate.version !== definition.bundledSkill.version) throw new ValidationError("bundled test Skill identity does not match the capability catalog");
    this.assertCompatible(definition, candidate); const installed = this.registry.install(packagePath);
    return this.saveBinding(definition, installed, validatedActor);
  }

  installAndBindSkill(capabilityId: string, packagePath: string, actor: string, approved = false): TestSkillBinding {
    const definition = capability(capabilityId); const validatedActor = required(actor, "actor", 120); if (!approved) throw new PolicyDenied("test workbench Skill installation requires human approval"); const candidate = this.registry.loadManifest(required(packagePath, "packagePath", 4_096)); this.assertCompatible(definition, candidate);
    const installed = this.registry.install(packagePath); return this.saveBinding(definition, installed, validatedActor);
  }

  bindSkill(capabilityId: string, skillId: string, actor: string, approved = false): TestSkillBinding {
    const definition = capability(capabilityId); const validatedActor = required(actor, "actor", 120); if (!approved) throw new PolicyDenied("test workbench Skill binding requires human approval"); const resolved = this.registry.resolve(skillIdentifier(skillId)); this.assertCompatible(definition, resolved.manifest);
    return this.saveBinding(definition, resolved, validatedActor);
  }

  unbindSkill(capabilityId: string, options: { actor: string; approved: boolean; approvedBindingDigest: string }): TestSkillBinding {
    const definition = capability(capabilityId); const actor = required(options.actor, "actor", 120); if (!options.approved) throw new PolicyDenied("test workbench Skill unbinding requires human approval");
    const approvedDigest = required(options.approvedBindingDigest, "approvedBindingDigest", 80); if (!/^sha256:[a-f0-9]{64}$/.test(approvedDigest)) throw new ValidationError("approvedBindingDigest is invalid");
    const config = this.config(); const binding = config.bindings.find((item) => item.capabilityId === definition.id); if (!binding) throw new ValidationError("test capability has no Skill binding to unbind");
    if (binding.skillDigest !== approvedDigest) throw new PolicyDenied("test workbench Skill unbinding approval snapshot is stale");
    config.bindings = config.bindings.filter((item) => item.capabilityId !== definition.id); config.bindingEvents.push(this.bindingEvent("unbind", binding, actor)); this.save(config); return binding;
  }

  upgradeSkill(capabilityId: string, packagePath: string, options: { actor: string; approved: boolean }): TestSkillBinding {
    const definition = capability(capabilityId); const actor = required(options.actor, "actor", 120); if (!options.approved) throw new PolicyDenied("test workbench Skill upgrade requires human approval"); const current = this.config().bindings.find((item) => item.capabilityId === definition.id); if (!current) throw new ValidationError("test capability has no Skill binding to upgrade");
    const candidate = this.registry.loadManifest(required(packagePath, "packagePath", 4_096));
    if (candidate.id !== current.skillId) throw new ValidationError("upgraded Skill id must match the current binding");
    if (compareVersions(candidate.version, current.skillVersion) <= 0) throw new ValidationError("upgraded Skill version must be newer than the current binding");
    this.assertCompatible(definition, candidate); const installed = this.registry.install(packagePath); return this.saveBinding(definition, installed, actor);
  }

  createFlow(input: { id: string; name: string; description?: string; capabilityIds: string[]; knowledgeSourceIds?: string[] }): TestFlow {
    const config = this.config(); const id = identifier(input.id, "test flow id"); if (config.flows.some((item) => item.id === id)) throw new ValidationError(`test flow already exists: ${id}`);
    const flow = this.flowFromInput(input, undefined, config); config.flows.push(flow); this.save(config); return flow;
  }

  updateFlow(id: string, input: { name: string; description?: string; capabilityIds: string[]; knowledgeSourceIds?: string[] }): TestFlow {
    const config = this.config(); const safeId = identifier(id, "test flow id"); const existing = this.latestFlows(config.flows).find((item) => item.id === safeId); if (!existing) throw new ValidationError(`test flow not found: ${id}`);
    const flow = this.flowFromInput({ ...input, id: safeId }, existing, config); config.flows.push(flow); this.save(config); return flow;
  }

  removeFlow(id: string): void { const config = this.config(); const safeId = identifier(id, "test flow id"); if (!config.flows.some((item) => item.id === safeId)) throw new ValidationError(`test flow not found: ${safeId}`); config.flows = config.flows.filter((item) => item.id !== safeId); this.save(config); }

  async runCapability(capabilityId: string, input: JsonObject, options: { actor: string; approved: boolean; changeId?: string; workspaceId?: string; knowledgeSourceIds?: string[] }): Promise<SkillRun> {
    this.assertExecutionScope(options); const actor = required(options.actor, "actor", 120); const definition = capability(capabilityId); const binding = this.currentBinding(definition.id); const selectedSourceIds = [...new Set((options.knowledgeSourceIds ?? []).map((id) => identifier(id, "knowledge source id")))];
    const pinned = this.registry.resolvePinned(binding.skillId, binding.skillVersion, binding.skillDigest); this.skills.policy.checkRun(pinned.manifest, options.approved);
    const knowledge = await this.knowledgeContext(definition.knowledgeKinds, selectedSourceIds, input);
    const payload: JsonObject = { ...input, request: input, knowledge: knowledge as unknown as JsonValue, workbench: { capabilityId: definition.id, capabilityName: definition.name, actor } };
    return await this.skills.run(binding.skillId, payload, { approved: options.approved, pinned: { version: binding.skillVersion, digest: binding.skillDigest }, auditInput: { capabilityId: definition.id, actor, approved: options.approved, knowledgeSourceIds: selectedSourceIds, request: input }, outputPolicy: { maxBytes: testWorkbenchByteLimit, forbiddenValues: knowledge.map((item) => item.result ?? null) }, ...(options.changeId ? { changeId: options.changeId } : {}), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}) });
  }

  async runFlow(id: string, input: JsonObject, options: { actor: string; reviewedFlowDigest: string; approvedStepIds?: Set<string>; changeId?: string; workspaceId?: string }): Promise<WorkflowRun> {
    this.assertExecutionScope(options); const actor = required(options.actor, "actor", 120); const safeId = identifier(id, "test flow id"); const candidates = this.config().flows.filter((item) => item.id === safeId); if (!candidates.length) throw new ValidationError(`test flow not found: ${id}`);
    const reviewedDigest = required(options.reviewedFlowDigest, "reviewedFlowDigest", 80); const selected = candidates.map((flow) => ({ flow, approval: this.flowApproval(flow) })).find((item) => item.approval.digest === reviewedDigest); if (!selected) throw new PolicyDenied("test flow approval snapshot is stale"); const { flow, approval } = selected;
    const definitions = flow.steps.map((step) => capability(step.capabilityId));
    const approvedStepIds = options.approvedStepIds ?? new Set<string>(); const requiredStepIds = new Set(approval.steps.filter((step) => step.approvalRequired).map((step) => step.id));
    if ([...approvedStepIds].some((stepId) => !requiredStepIds.has(stepId))) throw new ValidationError("test flow approval references a step that does not require approval");
    for (const step of approval.steps) { const resolved = this.registry.resolvePinned(step.skillId, step.skillVersion, step.skillDigest); this.skills.policy.checkRun(resolved.manifest, approvedStepIds.has(step.id)); }
    const knowledgeKinds = [...new Set(definitions.flatMap((item) => item.knowledgeKinds))]; const knowledge = await this.knowledgeContext(knowledgeKinds, flow.knowledgeSourceIds, input);
    const knowledgeByStep = Object.fromEntries(flow.steps.map((step) => { const allowed = capability(step.capabilityId).knowledgeKinds; return [step.id, knowledge.filter((item) => { const source = item.source; return isRecord(source) && typeof source.kind === "string" && allowed.includes(source.kind as KnowledgeSourceKind); })]; })) as JsonObject;
    const requestReferences = Object.fromEntries(Object.keys(input).map((key) => [key, { $ref: `input.${key}` }])) as JsonObject;
    const steps = flow.steps.map((step, index) => ({ id: step.id, skill: step.skillId, pinned: { version: step.skillVersion, digest: step.skillDigest }, input: { ...requestReferences, request: { $ref: "input.request" }, knowledge: { $ref: `input.knowledgeByStep.${step.id}` }, workbench: { flowId: flow.id, flowVersion: flow.version, capabilityId: step.capabilityId, actor }, ...(index ? { previous: { $ref: `steps.${flow.steps[index - 1]!.id}.output` } } : {}) } })) as WorkflowDefinition["steps"];
    const definition: WorkflowDefinition = { id: `test-workbench.${flow.id}`, version: String(flow.version), name: flow.name, steps };
    const approvedSteps = new Set(flow.steps.filter((step) => approvedStepIds.has(step.id)).map((step) => step.id));
    return await this.workflows.run(definition, { ...input, request: input, knowledgeByStep }, { approvedSteps, auditInput: { flowId: flow.id, flowVersion: flow.version, approvalDigest: approval.digest, approvalRequiredStepIds: [...requiredStepIds], approvedStepIds: [...approvedStepIds], actor, knowledgeSourceIds: flow.knowledgeSourceIds, request: input }, outputPolicy: { maxBytes: testWorkbenchByteLimit, forbiddenValues: knowledge.map((item) => item.result ?? null) }, ...(options.changeId ? { changeId: options.changeId } : {}), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}) });
  }

  private saveBinding(definition: TestCapabilityDefinition, resolved: { manifest: SkillManifest; digest: string }, actor: string): TestSkillBinding {
    const binding: TestSkillBinding = { capabilityId: definition.id, skillId: resolved.manifest.id, skillVersion: resolved.manifest.version, skillDigest: resolved.digest, boundAt: utcNow(), boundBy: required(actor, "actor", 120) };
    const config = this.config(); config.bindings = config.bindings.filter((item) => item.capabilityId !== definition.id); config.bindings.push(binding); config.bindingEvents.push(this.bindingEvent("bind", binding, binding.boundBy)); this.save(config); return binding;
  }
  private bindingEvent(action: TestSkillBindingEvent["action"], binding: TestSkillBinding, actor: string): TestSkillBindingEvent { return { id: randomUUID(), action, actor: required(actor, "actor", 120), approved: true, occurredAt: utcNow(), binding: { ...binding } }; }
  private currentBinding(capabilityId: TestCapabilityId): TestSkillBinding {
    const binding = this.config().bindings.find((item) => item.capabilityId === capabilityId); if (!binding) throw new ValidationError(`test capability has no Skill binding: ${capabilityId}`);
    const resolved = this.registry.resolvePinned(binding.skillId, binding.skillVersion, binding.skillDigest); this.assertCompatible(capability(capabilityId), resolved.manifest); return binding;
  }
  private assertExecutionScope(options: { changeId?: string; workspaceId?: string }): void {
    const workspaceId = options.workspaceId ? identifier(options.workspaceId, "workspace id") : undefined;
    if (workspaceId) { if (!this.scope) throw new ValidationError("test run Workspace scope cannot be validated"); this.scope.workspace(workspaceId); }
    if (!options.changeId) return;
    const change = this.workspace.getChange(identifier(options.changeId, "change id"));
    if (workspaceId && change.workspaceId !== workspaceId) throw new ValidationError("test run Workspace does not match the Change Workspace");
  }
  private assertCompatible(definition: TestCapabilityDefinition, manifest: SkillManifest): void { semanticVersion(manifest.version); if (!definition.skillTags.some((tag) => manifest.tags.includes(tag))) throw new ValidationError(`Skill ${manifest.id} is not tagged for ${definition.name}`); }
  private flowFromInput(input: { id: string; name: string; description?: string; capabilityIds: string[]; knowledgeSourceIds?: string[] }, existing: TestFlow | undefined, config: TestWorkbenchConfig): TestFlow {
    if (!Array.isArray(input.capabilityIds) || !input.capabilityIds.length || input.capabilityIds.length > 20) throw new ValidationError("test flow requires 1-20 capabilities");
    const selected = input.capabilityIds.map(capability); const bindings = selected.map((item) => this.currentBinding(item.id)); const knowledgeSourceIds = [...new Set(input.knowledgeSourceIds ?? [])].map((id) => identifier(id, "knowledge source id"));
    if (knowledgeSourceIds.length > testWorkbenchSourceLimit) throw new ValidationError(`test flow supports at most ${testWorkbenchSourceLimit} knowledge sources`);
    if (knowledgeSourceIds.some((id) => !config.knowledgeSources.some((source) => source.id === id))) throw new ValidationError("test flow references an unknown knowledge source");
    const now = utcNow(); const version = (existing?.version ?? 0) + 1; return { id: identifier(input.id, "test flow id"), name: required(input.name, "test flow name", 120), description: description(input.description, "test flow description"), steps: selected.map((item, index) => ({ id: `v${version}-step-${index + 1}-${item.id}`, capabilityId: item.id, skillId: bindings[index]!.skillId, skillVersion: bindings[index]!.skillVersion, skillDigest: bindings[index]!.skillDigest })), knowledgeSourceIds, version, createdAt: existing?.createdAt ?? now, updatedAt: now };
  }
  private latestFlows(flows: TestFlow[]): TestFlow[] {
    const latest = new Map<string, TestFlow>(); for (const flow of flows) { const current = latest.get(flow.id); if (!current || flow.version > current.version) latest.set(flow.id, flow); } return [...latest.values()];
  }
  private flowApproval(flow: TestFlow): { digest: string; steps: Array<TestFlowStep & { approvalRequired: boolean }> } {
    const steps = flow.steps.map((step) => { const resolved = this.registry.resolvePinned(step.skillId, step.skillVersion, step.skillDigest); this.assertCompatible(capability(step.capabilityId), resolved.manifest); return { ...step, approvalRequired: this.skills.policy.requiresApproval(resolved.manifest) }; });
    const surface = { flowId: flow.id, flowVersion: flow.version, knowledgeSourceIds: flow.knowledgeSourceIds, steps: steps.map(({ id, capabilityId, skillId, skillVersion, skillDigest, approvalRequired }) => ({ id, capabilityId, skillId, skillVersion, skillDigest, approvalRequired })) };
    return { digest: `sha256:${createHash("sha256").update(JSON.stringify(surface)).digest("hex")}`, steps };
  }
  private async knowledgeContext(kinds: KnowledgeSourceKind[], selectedIds: string[], query: JsonObject): Promise<JsonObject[]> {
    const config = this.config(); const requestedIds = [...new Set(selectedIds.map((id) => identifier(id, "knowledge source id")))];
    if (requestedIds.length > testWorkbenchSourceLimit) throw new ValidationError(`test run supports at most ${testWorkbenchSourceLimit} knowledge sources`);
    const requested = requestedIds.map((id) => config.knowledgeSources.find((source) => source.id === id));
    if (requested.some((source) => !source)) throw new ValidationError("unknown knowledge source selected for test run");
    if (requested.some((source) => !source!.enabled)) throw new ValidationError("disabled knowledge source selected for test run");
    if (requested.some((source) => !kinds.includes(source!.kind))) throw new ValidationError("knowledge source is incompatible with the test capability");
    const selected = requested as TestKnowledgeSource[]; if (!selected.length) return [];
    if (!this.tools.hasAdapter("knowledge")) throw new AdapterError("knowledge adapter is not configured");
    const results: JsonObject[] = []; let totalBytes = 0;
    for (const source of selected) {
      const response = await this.tools.execute({ tool: "knowledge.search", arguments: { sourceId: source.id, adapter: source.adapter, repositoryRef: source.repositoryRef, query } }, new Set(["knowledge.search"]));
      const result = response.result ?? null; const bytes = Buffer.byteLength(JSON.stringify(result)); if (bytes > testWorkbenchByteLimit) throw new AdapterError(`knowledge response exceeds 512 KB: ${source.id}`);
      totalBytes += bytes; if (totalBytes > testWorkbenchByteLimit) throw new AdapterError("combined knowledge responses exceed 512 KB");
      results.push({ source: { id: source.id, name: source.name, kind: source.kind }, result });
    }
    return results;
  }
  private assertUniqueKnowledgeReference(config: TestWorkbenchConfig, adapter: string, repositoryRef: string, exceptId?: string): void {
    if (config.knowledgeSources.some((source) => source.id !== exceptId && source.adapter === adapter && source.repositoryRef === repositoryRef)) throw new ValidationError("knowledge source reference already exists");
  }
  private config(): TestWorkbenchConfig {
    if (!this.workspace.testWorkbenchConfigExists()) return emptyConfig();
    const value = this.workspace.getTestWorkbenchConfig();
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.knowledgeSources) || !Array.isArray(value.bindings) || (value.bindingEvents !== undefined && !Array.isArray(value.bindingEvents)) || !Array.isArray(value.flows)) throw new ValidationError("invalid test workbench configuration");
    const sources = value.knowledgeSources.map((raw): TestKnowledgeSource => {
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.kind !== "string" || typeof raw.adapter !== "string" || typeof raw.repositoryRef !== "string" || typeof raw.enabled !== "boolean" || typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string" || !knowledgeSourceKinds.includes(raw.kind as KnowledgeSourceKind)) throw new ValidationError("invalid test workbench knowledge source");
      return { id: identifier(raw.id, "knowledge source id"), name: required(raw.name, "knowledge source name", 120), kind: raw.kind as KnowledgeSourceKind, adapter: identifier(raw.adapter, "knowledge adapter"), repositoryRef: repositoryReference(raw.repositoryRef), enabled: raw.enabled, createdAt: timestamp(raw.createdAt, "knowledge source createdAt"), updatedAt: timestamp(raw.updatedAt, "knowledge source updatedAt") };
    });
    const bindings = value.bindings.map((raw): TestSkillBinding => {
      if (!isRecord(raw) || typeof raw.capabilityId !== "string" || typeof raw.skillId !== "string" || typeof raw.skillVersion !== "string" || typeof raw.skillDigest !== "string" || typeof raw.boundAt !== "string" || typeof raw.boundBy !== "string") throw new ValidationError("invalid test workbench Skill binding");
      const definition = capability(raw.capabilityId); if (!/^sha256:[a-f0-9]{64}$/.test(raw.skillDigest)) throw new ValidationError("invalid test workbench Skill digest"); semanticVersion(raw.skillVersion);
      return { capabilityId: definition.id, skillId: skillIdentifier(raw.skillId), skillVersion: raw.skillVersion, skillDigest: raw.skillDigest, boundAt: timestamp(raw.boundAt, "Skill boundAt"), boundBy: required(raw.boundBy, "Skill boundBy", 120) };
    });
    const bindingEvents = (value.bindingEvents ?? []).map((raw): TestSkillBindingEvent => {
      if (!isRecord(raw) || typeof raw.id !== "string" || (raw.action !== "bind" && raw.action !== "unbind") || typeof raw.actor !== "string" || raw.approved !== true || typeof raw.occurredAt !== "string" || !isRecord(raw.binding)) throw new ValidationError("invalid test workbench Skill binding event");
      const binding = raw.binding; if (typeof binding.capabilityId !== "string" || typeof binding.skillId !== "string" || typeof binding.skillVersion !== "string" || typeof binding.skillDigest !== "string" || typeof binding.boundAt !== "string" || typeof binding.boundBy !== "string" || !/^sha256:[a-f0-9]{64}$/.test(binding.skillDigest)) throw new ValidationError("invalid test workbench Skill binding event");
      const definition = capability(binding.capabilityId); semanticVersion(binding.skillVersion); return { id: identifier(raw.id, "Skill binding event id"), action: raw.action, actor: required(raw.actor, "Skill binding event actor", 120), approved: true, occurredAt: timestamp(raw.occurredAt, "Skill binding event occurredAt"), binding: { capabilityId: definition.id, skillId: skillIdentifier(binding.skillId), skillVersion: binding.skillVersion, skillDigest: binding.skillDigest, boundAt: timestamp(binding.boundAt, "Skill boundAt"), boundBy: required(binding.boundBy, "Skill boundBy", 120) } };
    });
    const flows = value.flows.map((raw): TestFlow => {
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.description !== "string" || !Array.isArray(raw.steps) || !raw.steps.length || !Array.isArray(raw.knowledgeSourceIds) || !raw.knowledgeSourceIds.every((item) => typeof item === "string") || typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1 || typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") throw new ValidationError("invalid test workbench flow");
      const steps = raw.steps.map((item): TestFlowStep => { if (!isRecord(item) || typeof item.id !== "string" || typeof item.capabilityId !== "string" || typeof item.skillId !== "string" || typeof item.skillVersion !== "string" || typeof item.skillDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.skillDigest)) throw new ValidationError("invalid test workbench flow step"); const definition = capability(item.capabilityId); semanticVersion(item.skillVersion); return { id: identifier(item.id, "test flow step id"), capabilityId: definition.id, skillId: skillIdentifier(item.skillId), skillVersion: item.skillVersion, skillDigest: item.skillDigest }; });
      if (steps.length > 20 || new Set(steps.map((step) => step.id)).size !== steps.length) throw new ValidationError("invalid test workbench flow steps");
      const knowledgeSourceIds = raw.knowledgeSourceIds.map((item) => identifier(item, "knowledge source id")); if (new Set(knowledgeSourceIds).size !== knowledgeSourceIds.length) throw new ValidationError("duplicate knowledge source in test workbench flow");
      return { id: identifier(raw.id, "test flow id"), name: required(raw.name, "test flow name", 120), description: description(raw.description, "test flow description"), steps, knowledgeSourceIds, version: Number(raw.version), createdAt: timestamp(raw.createdAt, "test flow createdAt"), updatedAt: timestamp(raw.updatedAt, "test flow updatedAt") };
    });
    const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new ValidationError(`duplicate ${label} in test workbench configuration`); };
    unique(sources.map((item) => item.id), "knowledge source"); unique(sources.map((item) => `${item.adapter}\0${item.repositoryRef}`), "knowledge source reference"); unique(bindings.map((item) => item.capabilityId), "capability binding"); unique(bindingEvents.map((item) => item.id), "Skill binding event"); unique(flows.map((item) => `${item.id}@${item.version}`), "flow version");
    if (flows.some((flow) => flow.knowledgeSourceIds.some((id) => !sources.some((source) => source.id === id)))) throw new ValidationError("test workbench flow references an unknown knowledge source");
    return { schemaVersion: 1, knowledgeSources: sources, bindings, bindingEvents, flows };
  }
  private save(config: TestWorkbenchConfig): void { this.workspace.saveTestWorkbenchConfig(config as unknown as JsonValue); }
}
