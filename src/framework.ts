import { randomUUID } from "node:crypto";
import type { ToolBroker } from "./adapters.js";
import { ValidationError } from "./errors.js";
import { transition } from "./lifecycle.js";
import { createChange, type Change, type Evidence, type JsonObject, type LifecycleState, type RiskLevel, utcNow } from "./models.js";
import { Policy } from "./policy.js";
import { SkillRegistry, SkillRuntime } from "./skills.js";
import { Workspace } from "./storage.js";
import { WorkflowRuntime, type WorkflowDefinition, type WorkflowRun } from "./workflows.js";

export class CJHXFramework {
  readonly workspace: Workspace; readonly policy: Policy; readonly registry: SkillRegistry; readonly runtime: SkillRuntime; readonly workflows: WorkflowRuntime;
  constructor(workspace = ".cjhx", options: { policy?: Policy; tools?: ToolBroker } = {}) {
    this.workspace = new Workspace(workspace); this.policy = options.policy ?? new Policy(); this.registry = new SkillRegistry(this.workspace, this.policy); this.runtime = new SkillRuntime(this.workspace, this.registry, this.policy, options.tools); this.workflows = new WorkflowRuntime(this.workspace, this.runtime);
  }
  initialize(): void { this.workspace.initialize(); }
  createChange(id: string, title: string, owner: string, options: { description?: string; riskLevel?: RiskLevel } = {}): Change {
    this.workspace.initialize(); if (this.workspace.changeExists(id)) throw new ValidationError(`change already exists: ${id}`);
    const change = createChange({ id, title, owner, ...options }); this.workspace.saveChange(change); return change;
  }
  addEvidence(changeId: string, input: { kind: string; source: string; status: string; subjectRef: string; uri?: string; metadata?: JsonObject }): Evidence {
    const change = this.workspace.getChange(changeId); const evidence: Evidence = { id: `evidence-${randomUUID().replaceAll("-", "")}`, kind: input.kind, source: input.source, status: input.status, subjectRef: input.subjectRef, ...(input.uri ? { uri: input.uri } : {}), createdAt: utcNow(), metadata: input.metadata ?? {} };
    change.evidence.push(evidence); this.workspace.saveChange(change); return evidence;
  }
  transitionChange(changeId: string, target: LifecycleState, options: { actor: string; reason: string; enforceGates?: boolean }): Change { const change = this.workspace.getChange(changeId); transition(change, target, options); this.workspace.saveChange(change); return change; }
  installSkill(packagePath: string): ReturnType<SkillRegistry["install"]> { return this.registry.install(packagePath); }
  async runSkill(id: string, input: JsonObject, options: { changeId?: string; approved?: boolean } = {}) { return await this.runtime.run(id, input, options); }
  async runWorkflow(definition: WorkflowDefinition, input: JsonObject, options: { changeId?: string; approvedSteps?: Set<string> } = {}): Promise<WorkflowRun> { return await this.workflows.run(definition, input, options); }
}
