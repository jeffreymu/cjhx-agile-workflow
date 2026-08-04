import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redact } from "./audit.js";
import { ValidationError } from "./errors.js";
import type { JsonObject, JsonValue } from "./models.js";
import { isRecord, utcNow } from "./models.js";
import { SkillRuntime } from "./skills.js";
import { Workspace } from "./storage.js";

export interface WorkflowStep { id: string; skill: string; input: JsonObject }
export interface WorkflowDefinition { id: string; version: string; name: string; steps: WorkflowStep[] }
export interface WorkflowRun { id: string; workflowId: string; workflowVersion: string; workspaceId?: string; status: "succeeded" | "failed"; startedAt: string; completedAt: string; input: JsonObject; steps: JsonObject[]; output: JsonObject; changeId?: string; error?: string }

export function loadWorkflow(path: string): WorkflowDefinition {
  return parseWorkflowDefinition(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.version !== "string" || typeof value.name !== "string" || !Array.isArray(value.steps) || !value.steps.length) throw new ValidationError("workflow requires id, version, name, and non-empty steps");
  const seen = new Set<string>(); const steps = value.steps.map((raw): WorkflowStep => {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.skill !== "string" || !isRecord(raw.input)) throw new ValidationError("each workflow step requires id, skill, and input");
    if (seen.has(raw.id)) throw new ValidationError(`duplicate workflow step id: ${raw.id}`); seen.add(raw.id); return { id: raw.id, skill: raw.skill, input: raw.input as JsonObject };
  });
  return { id: value.id, version: value.version, name: value.name, steps };
}

export class WorkflowRuntime {
  constructor(readonly workspace: Workspace, readonly skills: SkillRuntime) {}
  async run(definition: WorkflowDefinition, payload: JsonObject, options: { changeId?: string; workspaceId?: string; approvedSteps?: Set<string> } = {}): Promise<WorkflowRun> {
    const id = `workflow-run-${randomUUID().replaceAll("-", "")}`; const startedAt = utcNow(); const context: JsonObject = { input: payload, steps: {} }; const records: JsonObject[] = [];
    try {
      for (const step of definition.steps) {
        const resolved = this.resolve(step.input, context) as JsonObject; const run = await this.skills.run(step.skill, resolved, { ...(options.changeId ? { changeId: options.changeId } : {}), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), approved: options.approvedSteps?.has(step.id) ?? false });
        (context.steps as JsonObject)[step.id] = { output: run.output, runId: run.id }; records.push({ id: step.id, skill: step.skill, skillRunId: run.id, status: run.status, output: run.output });
      }
      const last = definition.steps.at(-1); if (!last) throw new ValidationError("workflow has no steps");
      const run: WorkflowRun = { id, workflowId: definition.id, workflowVersion: definition.version, ...(options.changeId ? { changeId: options.changeId } : {}), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), status: "succeeded", startedAt, completedAt: utcNow(), input: redact(payload) as JsonObject, steps: redact(records) as JsonObject[], output: redact(((context.steps as JsonObject)[last.id] as JsonObject).output ?? {}) as JsonObject };
      this.workspace.saveRun(run); return run;
    } catch (error) {
      const run: WorkflowRun = { id, workflowId: definition.id, workflowVersion: definition.version, ...(options.changeId ? { changeId: options.changeId } : {}), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), status: "failed", startedAt, completedAt: utcNow(), input: redact(payload) as JsonObject, steps: redact(records) as JsonObject[], output: {}, error: `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}` };
      this.workspace.saveRun(run); throw error;
    }
  }
  private resolve(value: JsonValue, context: JsonObject): JsonValue {
    if (isRecord(value) && Object.keys(value).length === 1 && "$ref" in value) { if (typeof value.$ref !== "string") throw new ValidationError("workflow $ref must be a string"); return this.lookup(context, value.$ref); }
    if (Array.isArray(value)) return value.map((item) => this.resolve(item, context));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolve(item as JsonValue, context)]));
    return value;
  }
  private lookup(context: JsonObject, reference: string): JsonValue { let current: JsonValue = context; for (const part of reference.split(".")) { if (!isRecord(current) || !(part in current)) throw new ValidationError(`workflow reference not found: ${reference}`); current = current[part] as JsonValue; } return current; }
}
