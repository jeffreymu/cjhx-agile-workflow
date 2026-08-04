import type { ToolBroker } from "./adapters.js";
import { PolicyDenied, ValidationError } from "./errors.js";
import type { JsonObject, JsonValue } from "./models.js";

export const pipelineKinds = ["ci", "cd"] as const;
export type PipelineKind = typeof pipelineKinds[number];
export const serviceActions = ["start", "stop", "restart"] as const;
export type ServiceAction = typeof serviceActions[number];

export interface DevOpsOverview {
  pipelines: JsonObject[];
  runs: JsonObject[];
  artifacts: JsonObject[];
  services: JsonObject[];
  syncedAt: string;
}

function resultArray(value: JsonObject): JsonObject[] {
  const result: JsonValue | undefined = value.result;
  if (!Array.isArray(result) || !result.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) throw new ValidationError("DevOps Adapter returned an invalid list");
  return result as JsonObject[];
}

export class DevOpsService {
  constructor(private readonly tools: ToolBroker) {}

  configured(): boolean { return this.tools.hasAdapter("devops"); }

  async overview(changeId?: string): Promise<DevOpsOverview> {
    const request: JsonObject = { ...(changeId ? { changeId } : {}) };
    const permissions = new Set(["devops.pipeline.list", "devops.pipeline-runs.list", "devops.artifact.list", "devops.service.list"]);
    const [pipelines, runs, artifacts, services] = await Promise.all([
      this.tools.execute({ tool: "devops.pipeline.list", arguments: { request } }, permissions),
      this.tools.execute({ tool: "devops.pipeline-runs.list", arguments: { request } }, permissions),
      this.tools.execute({ tool: "devops.artifact.list", arguments: { request } }, permissions),
      this.tools.execute({ tool: "devops.service.list", arguments: { request } }, permissions),
    ]);
    return { pipelines: resultArray(pipelines), runs: resultArray(runs), artifacts: resultArray(artifacts), services: resultArray(services), syncedAt: new Date().toISOString() };
  }

  async triggerPipeline(input: { pipelineId: string; kind: PipelineKind; changeId?: string; ref?: string; environment?: string; actor: string; reason: string; approved: boolean }): Promise<JsonObject> {
    this.requireApproval(input.approved);
    const pipelineId = this.required(input.pipelineId, "pipelineId"); const actor = this.required(input.actor, "actor"); const reason = this.required(input.reason, "reason");
    if (!pipelineKinds.includes(input.kind)) throw new ValidationError(`invalid pipeline kind: ${input.kind}`);
    const operation = await this.tools.execute({ tool: "devops.pipeline.trigger", arguments: { request: { pipelineId, kind: input.kind, ...(input.changeId ? { changeId: input.changeId } : {}), ...(input.ref ? { ref: input.ref } : {}), ...(input.environment ? { environment: input.environment } : {}), actor, reason } } }, new Set(["devops.pipeline.trigger"]));
    return this.resultObject(operation);
  }

  async controlService(input: { serviceId: string; action: ServiceAction; environment?: string; actor: string; reason: string; approved: boolean }): Promise<JsonObject> {
    this.requireApproval(input.approved);
    const serviceId = this.required(input.serviceId, "serviceId"); const actor = this.required(input.actor, "actor"); const reason = this.required(input.reason, "reason");
    if (!serviceActions.includes(input.action)) throw new ValidationError(`invalid service action: ${input.action}`);
    const operation = await this.tools.execute({ tool: "devops.service.control", arguments: { request: { serviceId, action: input.action, ...(input.environment ? { environment: input.environment } : {}), actor, reason } } }, new Set(["devops.service.control"]));
    return this.resultObject(operation);
  }

  private requireApproval(approved: boolean): void { if (!approved) throw new PolicyDenied("DevOps write operation requires human approval"); }
  private required(value: string, key: string): string { const normalized = value.trim(); if (!normalized) throw new ValidationError(`${key} is required`); return normalized; }
  private resultObject(value: JsonObject): JsonObject { const result = value.result; if (typeof result !== "object" || result === null || Array.isArray(result)) throw new ValidationError("DevOps Adapter returned an invalid object"); return result; }
}
