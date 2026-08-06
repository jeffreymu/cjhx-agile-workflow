import { AdapterError, PolicyDenied } from "./errors.js";
import type { JsonObject, JsonValue } from "./models.js";

export type Awaitable<T> = T | Promise<T>;
export interface JiraAdapter { getIssue(key: string): Awaitable<JsonObject>; createIssue(fields: JsonObject): Awaitable<JsonObject>; updateIssue(key: string, fields: JsonObject): Awaitable<JsonObject>; transitionIssue(key: string, state: string): Awaitable<JsonObject> }
export interface ConfluenceAdapter { getPage(id: string): Awaitable<JsonObject>; createDraft(page: JsonObject): Awaitable<JsonObject>; updateDraft(id: string, page: JsonObject): Awaitable<JsonObject> }
export interface SourceControlAdapter { getRepository(id: string): Awaitable<JsonObject>; createBranch(id: string, name: string, revision: string): Awaitable<JsonObject>; createChangeRequest(request: JsonObject): Awaitable<JsonObject>; publishCommitStatus(status: JsonObject): Awaitable<JsonObject> }
export interface DevOpsAdapter {
  triggerValidation(request: JsonObject): Awaitable<JsonObject>; getValidationResult(id: string): Awaitable<JsonObject>;
  buildArtifact(request: JsonObject): Awaitable<JsonObject>; deployArtifact(request: JsonObject): Awaitable<JsonObject>; getDeploymentStatus(id: string): Awaitable<JsonObject>;
  listPipelines(request: JsonObject): Awaitable<JsonObject[]>; listPipelineRuns(request: JsonObject): Awaitable<JsonObject[]>; listArtifacts(request: JsonObject): Awaitable<JsonObject[]>; listServices(request: JsonObject): Awaitable<JsonObject[]>;
  triggerPipeline(request: JsonObject): Awaitable<JsonObject>; controlService(request: JsonObject): Awaitable<JsonObject>;
}
export interface ObservabilityAdapter { getDeploymentHealth(id: string): Awaitable<JsonObject>; getRelatedIncidents(id: string): Awaitable<JsonObject[]> }

export interface ToolOperation { tool: string; arguments: JsonObject }
export interface ToolAdapters { jira?: JiraAdapter; confluence?: ConfluenceAdapter; sourceControl?: SourceControlAdapter; devops?: DevOpsAdapter; observability?: ObservabilityAdapter }

function stringArg(args: JsonObject, key: string): string { const value = args[key]; if (typeof value !== "string") throw new AdapterError(`missing tool argument: ${key}`); return value; }
function objectArg(args: JsonObject, key: string): JsonObject { const value = args[key]; if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AdapterError(`missing tool argument: ${key}`); return value; }

export class ToolBroker {
  constructor(private readonly adapters: ToolAdapters = {}) {}
  hasAdapter(name: keyof ToolAdapters): boolean { return this.adapters[name] !== undefined; }
  getAdapter<K extends keyof ToolAdapters>(name: K): ToolAdapters[K] { return this.adapters[name]; }
  setAdapter<K extends keyof ToolAdapters>(name: K, adapter: NonNullable<ToolAdapters[K]>): void { this.adapters[name] = adapter; }
  removeAdapter(name: keyof ToolAdapters): void { delete this.adapters[name]; }
  async execute(operation: ToolOperation, permissions: Set<string>): Promise<JsonObject> {
    if (!permissions.has(operation.tool)) throw new PolicyDenied(`skill has no permission for tool: ${operation.tool}`);
    const a = this.adapters; let result: JsonValue;
    switch (operation.tool) {
      case "jira.issue.read": result = await this.need(a.jira, operation.tool).getIssue(stringArg(operation.arguments, "key")); break;
      case "jira.issue.create": result = await this.need(a.jira, operation.tool).createIssue(objectArg(operation.arguments, "fields")); break;
      case "jira.issue.update": result = await this.need(a.jira, operation.tool).updateIssue(stringArg(operation.arguments, "key"), objectArg(operation.arguments, "fields")); break;
      case "jira.issue.transition": result = await this.need(a.jira, operation.tool).transitionIssue(stringArg(operation.arguments, "key"), stringArg(operation.arguments, "state")); break;
      case "confluence.page.read": result = await this.need(a.confluence, operation.tool).getPage(stringArg(operation.arguments, "pageId")); break;
      case "confluence.page.create-draft": result = await this.need(a.confluence, operation.tool).createDraft(objectArg(operation.arguments, "page")); break;
      case "confluence.page.update-draft": result = await this.need(a.confluence, operation.tool).updateDraft(stringArg(operation.arguments, "pageId"), objectArg(operation.arguments, "page")); break;
      case "scm.repository.read": result = await this.need(a.sourceControl, operation.tool).getRepository(stringArg(operation.arguments, "repositoryId")); break;
      case "scm.branch.create": result = await this.need(a.sourceControl, operation.tool).createBranch(stringArg(operation.arguments, "repositoryId"), stringArg(operation.arguments, "name"), stringArg(operation.arguments, "revision")); break;
      case "scm.change-request.create": result = await this.need(a.sourceControl, operation.tool).createChangeRequest(objectArg(operation.arguments, "request")); break;
      case "scm.commit-status.publish": result = await this.need(a.sourceControl, operation.tool).publishCommitStatus(objectArg(operation.arguments, "status")); break;
      case "devops.validation.trigger": result = await this.need(a.devops, operation.tool).triggerValidation(objectArg(operation.arguments, "request")); break;
      case "devops.validation.read": result = await this.need(a.devops, operation.tool).getValidationResult(stringArg(operation.arguments, "runId")); break;
      case "devops.artifact.build": result = await this.need(a.devops, operation.tool).buildArtifact(objectArg(operation.arguments, "request")); break;
      case "devops.artifact.deploy": result = await this.need(a.devops, operation.tool).deployArtifact(objectArg(operation.arguments, "request")); break;
      case "devops.deployment.read": result = await this.need(a.devops, operation.tool).getDeploymentStatus(stringArg(operation.arguments, "deploymentId")); break;
      case "devops.pipeline.list": result = await this.need(a.devops, operation.tool).listPipelines(objectArg(operation.arguments, "request")); break;
      case "devops.pipeline-runs.list": result = await this.need(a.devops, operation.tool).listPipelineRuns(objectArg(operation.arguments, "request")); break;
      case "devops.artifact.list": result = await this.need(a.devops, operation.tool).listArtifacts(objectArg(operation.arguments, "request")); break;
      case "devops.service.list": result = await this.need(a.devops, operation.tool).listServices(objectArg(operation.arguments, "request")); break;
      case "devops.pipeline.trigger": result = await this.need(a.devops, operation.tool).triggerPipeline(objectArg(operation.arguments, "request")); break;
      case "devops.service.control": result = await this.need(a.devops, operation.tool).controlService(objectArg(operation.arguments, "request")); break;
      case "observability.deployment-health.read": result = await this.need(a.observability, operation.tool).getDeploymentHealth(stringArg(operation.arguments, "deploymentId")); break;
      case "observability.incidents.read": result = await this.need(a.observability, operation.tool).getRelatedIncidents(stringArg(operation.arguments, "serviceId")); break;
      default: throw new AdapterError(`unknown tool: ${operation.tool}`);
    }
    return { tool: operation.tool, result };
  }
  private need<T>(adapter: T | undefined, tool: string): T { if (!adapter) throw new AdapterError(`adapter is not configured for tool: ${tool}`); return adapter; }
}

export class InMemoryJiraAdapter implements JiraAdapter {
  readonly issues = new Map<string, JsonObject>();
  readonly transitions: { key: string; state: string }[] = [];
  getIssue(key: string): JsonObject { const issue = this.issues.get(key); if (!issue) throw new AdapterError(`Jira issue not found: ${key}`); return { ...issue }; }
  createIssue(fields: JsonObject): JsonObject { const key = String(fields.key ?? `TASK-${this.issues.size + 1}`); const issue = { key, status: "To Do", url: `jira://${key}`, ...fields }; this.issues.set(key, issue); return { ...issue }; }
  updateIssue(key: string, fields: JsonObject): JsonObject { const issue = { ...this.getIssue(key), ...fields }; this.issues.set(key, issue); return { ...issue }; }
  transitionIssue(key: string, state: string): JsonObject { const issue = { ...this.getIssue(key), status: state }; this.issues.set(key, issue); this.transitions.push({ key, state }); return { ...issue }; }
  setStatus(key: string, status: string): void { const issue = { ...this.getIssue(key), status }; this.issues.set(key, issue); }
}

export class InMemoryConfluenceAdapter implements ConfluenceAdapter {
  readonly pages = new Map<string, JsonObject>();
  getPage(id: string): JsonObject { const page = this.pages.get(id); if (!page) throw new AdapterError(`Confluence page not found: ${id}`); return { ...page }; }
  createDraft(page: JsonObject): JsonObject { const id = String(page.id ?? this.pages.size + 1); const created = { id, status: "draft", ...page }; this.pages.set(id, created); return { ...created }; }
  updateDraft(id: string, page: JsonObject): JsonObject { const current = this.getPage(id); if (current.status !== "draft") throw new AdapterError("only draft pages may be updated"); const updated = { ...current, ...page }; this.pages.set(id, updated); return updated; }
}

export class InMemoryDevOpsAdapter implements DevOpsAdapter {
  readonly validations = new Map<string, JsonObject>(); readonly pipelines = new Map<string, JsonObject>(); readonly pipelineRuns = new Map<string, JsonObject>(); readonly artifacts = new Map<string, JsonObject>(); readonly services = new Map<string, JsonObject>();
  triggerValidation(request: JsonObject): JsonObject { const id = String(request.runId ?? `validation-${this.validations.size + 1}`); const run = { runId: id, status: "requested", ...request }; this.validations.set(id, run); return run; }
  getValidationResult(id: string): JsonObject { const run = this.validations.get(id); if (!run) throw new AdapterError(`validation not found: ${id}`); return { ...run }; }
  buildArtifact(request: JsonObject): JsonObject { const artifact = { artifactId: String(request.artifactId ?? `artifact-${this.artifacts.size + 1}`), status: "built", ...request }; this.artifacts.set(String(artifact.artifactId), artifact); return artifact; }
  deployArtifact(request: JsonObject): JsonObject { return { deploymentId: String(request.deploymentId ?? "deployment-1"), status: "requested", ...request }; }
  getDeploymentStatus(id: string): JsonObject { return { deploymentId: id, status: "requested" }; }
  listPipelines(request: JsonObject): JsonObject[] { return this.filtered(this.pipelines, request); }
  listPipelineRuns(request: JsonObject): JsonObject[] { return this.filtered(this.pipelineRuns, request); }
  listArtifacts(request: JsonObject): JsonObject[] { return this.filtered(this.artifacts, request); }
  listServices(request: JsonObject): JsonObject[] { return this.filtered(this.services, request); }
  triggerPipeline(request: JsonObject): JsonObject { const pipelineId = String(request.pipelineId); const pipeline = this.pipelines.get(pipelineId); if (!pipeline) throw new AdapterError(`pipeline not found: ${pipelineId}`); const runId = `pipeline-run-${this.pipelineRuns.size + 1}`; const run = { runId, pipelineId, pipelineName: pipeline.name ?? pipelineId, kind: request.kind ?? pipeline.kind ?? "ci", status: "running", startedAt: new Date().toISOString(), ...request }; this.pipelineRuns.set(runId, run); return run; }
  controlService(request: JsonObject): JsonObject { const serviceId = String(request.serviceId); const current = this.services.get(serviceId); if (!current) throw new AdapterError(`service not found: ${serviceId}`); const action = String(request.action); const service = { ...current, status: action === "stop" ? "stopped" : "running", lastAction: action, updatedAt: new Date().toISOString() }; this.services.set(serviceId, service); return service; }
  private filtered(items: Map<string, JsonObject>, request: JsonObject): JsonObject[] { const changeId = typeof request.changeId === "string" ? request.changeId : undefined; const workspaceId = typeof request.workspaceId === "string" ? request.workspaceId : undefined; return [...items.values()].filter((item) => (!changeId || item.changeId === changeId) && (!workspaceId || item.workspaceId === workspaceId)).map((item) => ({ ...item })); }
}
