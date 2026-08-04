import type { DevOpsAdapter, ToolBroker } from "./adapters.js";
import { AdapterError, ValidationError } from "./errors.js";
import { isRecord, type JsonObject, type JsonValue } from "./models.js";
import type { Workspace } from "./storage.js";

export const devOpsAuthTypes = ["none", "bearer", "api-key"] as const;
export type DevOpsAuthType = typeof devOpsAuthTypes[number];

export interface DevOpsHttpConfig {
  schemaVersion: 1;
  baseUrl: string;
  authType: DevOpsAuthType;
  credential?: string;
  apiKeyHeader: string;
  projectId?: string;
  tenantId?: string;
  timeoutSeconds: number;
  savedAt: string;
  lastTestedAt: string;
}

export interface DevOpsConfigInput { baseUrl: string; authType: DevOpsAuthType; credential?: string; apiKeyHeader?: string; projectId?: string; tenantId?: string; timeoutSeconds?: number }
export interface DevOpsConfigSummary { configured: boolean; source: "none" | "runtime" | "workspace"; baseUrl?: string; authType?: DevOpsAuthType; credentialConfigured: boolean; apiKeyHeader?: string; projectId?: string; tenantId?: string; timeoutSeconds?: number; savedAt?: string; lastTestedAt?: string }

const forbiddenHeaders = new Set(["authorization", "cookie", "host", "content-length", "connection", "transfer-encoding"]);
function required(value: unknown, key: string): string { if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${key} is required`); return value.trim(); }
function optional(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function baseUrl(value: unknown): string {
  let url: URL; try { url = new URL(required(value, "baseUrl")); } catch { throw new ValidationError("baseUrl must be a valid absolute URL"); }
  if (url.username || url.password) throw new ValidationError("baseUrl cannot contain credentials");
  if (url.search || url.hash) throw new ValidationError("baseUrl cannot contain query parameters or fragments");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new ValidationError("baseUrl must use HTTPS unless it targets loopback");
  return url.toString().replace(/\/$/, "");
}
function headerName(value: unknown): string { const result = optional(value) ?? "X-API-Key"; if (!/^[A-Za-z0-9-]+$/.test(result) || forbiddenHeaders.has(result.toLowerCase())) throw new ValidationError("apiKeyHeader is not allowed"); return result; }
function timeout(value: unknown): number { const result = value === undefined ? 15 : Number(value); if (!Number.isInteger(result) || result < 1 || result > 60) throw new ValidationError("timeoutSeconds must be between 1 and 60"); return result; }
function authType(value: unknown): DevOpsAuthType { if (typeof value !== "string" || !devOpsAuthTypes.includes(value as DevOpsAuthType)) throw new ValidationError("invalid DevOps auth type"); return value as DevOpsAuthType; }

export class HttpDevOpsAdapter implements DevOpsAdapter {
  constructor(readonly config: DevOpsHttpConfig) {}
  async testConnection(): Promise<JsonObject> { return await this.json("/health", { method: "GET" }); }
  async triggerValidation(request: JsonObject): Promise<JsonObject> { return await this.json("/validations", { method: "POST", body: request }); }
  async getValidationResult(id: string): Promise<JsonObject> { return await this.json(`/validations/${encodeURIComponent(id)}`, { method: "GET" }); }
  async buildArtifact(request: JsonObject): Promise<JsonObject> { return await this.json("/artifacts/build", { method: "POST", body: request }); }
  async deployArtifact(request: JsonObject): Promise<JsonObject> { return await this.json("/deployments", { method: "POST", body: request }); }
  async getDeploymentStatus(id: string): Promise<JsonObject> { return await this.json(`/deployments/${encodeURIComponent(id)}`, { method: "GET" }); }
  async listPipelines(request: JsonObject): Promise<JsonObject[]> { return await this.list("/pipelines", request); }
  async listPipelineRuns(request: JsonObject): Promise<JsonObject[]> { return await this.list("/pipeline-runs", request); }
  async listArtifacts(request: JsonObject): Promise<JsonObject[]> { return await this.list("/artifacts", request); }
  async listServices(request: JsonObject): Promise<JsonObject[]> { return await this.list("/services", request); }
  async triggerPipeline(request: JsonObject): Promise<JsonObject> { const id = required(request.pipelineId, "pipelineId"); return await this.json(`/pipelines/${encodeURIComponent(id)}/runs`, { method: "POST", body: request }); }
  async controlService(request: JsonObject): Promise<JsonObject> { const id = required(request.serviceId, "serviceId"); return await this.json(`/services/${encodeURIComponent(id)}/actions`, { method: "POST", body: request }); }

  private async list(path: string, request: JsonObject): Promise<JsonObject[]> { const changeId = optional(request.changeId); const value = await this.value(`${path}${changeId ? `?changeId=${encodeURIComponent(changeId)}` : ""}`, { method: "GET" }); if (!Array.isArray(value) || !value.every(isRecord)) throw new AdapterError("DevOps Gateway returned an invalid list"); return value as JsonObject[]; }
  private async json(path: string, request: { method: "GET" | "POST"; body?: JsonObject }): Promise<JsonObject> { const value = await this.value(path, request); if (!isRecord(value)) throw new AdapterError("DevOps Gateway returned an invalid object"); return value as JsonObject; }
  private async value(path: string, request: { method: "GET" | "POST"; body?: JsonObject }): Promise<JsonValue> {
    const headers = new Headers({ accept: "application/json" }); if (request.body) headers.set("content-type", "application/json");
    if (this.config.authType === "bearer" && this.config.credential) headers.set("authorization", `Bearer ${this.config.credential}`);
    if (this.config.authType === "api-key" && this.config.credential) headers.set(this.config.apiKeyHeader, this.config.credential);
    if (this.config.projectId) headers.set("x-cjhx-project-id", this.config.projectId); if (this.config.tenantId) headers.set("x-cjhx-tenant-id", this.config.tenantId);
    let response: Response; try { response = await fetch(`${this.config.baseUrl}${path}`, { method: request.method, headers, ...(request.body ? { body: JSON.stringify(request.body) } : {}), redirect: "error", signal: AbortSignal.timeout(this.config.timeoutSeconds * 1000) }); } catch (error) { throw new AdapterError(`DevOps Gateway request failed: ${error instanceof Error ? error.message : String(error)}`); }
    const contentLength = Number(response.headers.get("content-length") ?? 0); if (contentLength > 1_048_576) throw new AdapterError("DevOps Gateway response exceeds 1 MB");
    const payload = await this.responseText(response);
    if (!response.ok) throw new AdapterError(`DevOps Gateway returned HTTP ${response.status}`);
    try { return JSON.parse(payload) as JsonValue; } catch { throw new AdapterError("DevOps Gateway response is not valid JSON"); }
  }
  private async responseText(response: Response): Promise<string> {
    if (!response.body) return ""; const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0; let result = "";
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 1_048_576) { await reader.cancel(); throw new AdapterError("DevOps Gateway response exceeds 1 MB"); } result += decoder.decode(chunk.value, { stream: true }); } return result + decoder.decode(); }
    finally { reader.releaseLock(); }
  }
}

export class DevOpsIntegrationManager {
  private readonly fallback: DevOpsAdapter | undefined;
  constructor(private readonly workspace: Workspace, private readonly tools: ToolBroker) { this.fallback = tools.getAdapter("devops"); this.restore(); }
  summary(): DevOpsConfigSummary {
    if (!this.workspace.integrationExists("devops")) return { configured: this.tools.hasAdapter("devops"), source: this.tools.hasAdapter("devops") ? "runtime" : "none", credentialConfigured: false };
    const config = this.read(); return { configured: true, source: "workspace", baseUrl: config.baseUrl, authType: config.authType, credentialConfigured: Boolean(config.credential), apiKeyHeader: config.apiKeyHeader, ...(config.projectId ? { projectId: config.projectId } : {}), ...(config.tenantId ? { tenantId: config.tenantId } : {}), timeoutSeconds: config.timeoutSeconds, savedAt: config.savedAt, lastTestedAt: config.lastTestedAt };
  }
  async test(input: DevOpsConfigInput): Promise<{ status: "connected"; testedAt: string }> { const config = this.normalize(input, false); await new HttpDevOpsAdapter(config).testConnection(); return { status: "connected", testedAt: config.lastTestedAt }; }
  async save(input: DevOpsConfigInput): Promise<DevOpsConfigSummary> { const config = this.normalize(input, true); await new HttpDevOpsAdapter(config).testConnection(); this.workspace.saveIntegrationConfig("devops", config as unknown as JsonValue); this.tools.setAdapter("devops", new HttpDevOpsAdapter(config)); return this.summary(); }
  remove(): DevOpsConfigSummary { this.workspace.removeIntegrationConfig("devops"); if (this.fallback) this.tools.setAdapter("devops", this.fallback); else this.tools.removeAdapter("devops"); return this.summary(); }
  private restore(): void { if (this.workspace.integrationExists("devops")) this.tools.setAdapter("devops", new HttpDevOpsAdapter(this.read())); }
  private read(): DevOpsHttpConfig { const raw = this.workspace.getIntegrationConfig("devops"); if (!isRecord(raw)) throw new ValidationError("invalid saved DevOps configuration"); return this.normalize(raw as unknown as DevOpsConfigInput, true, true); }
  private normalize(input: DevOpsConfigInput, saving: boolean, preserveDates = false): DevOpsHttpConfig {
    const existing = this.workspace.integrationExists("devops") && !preserveDates ? this.read() : undefined; const type = authType(input.authType); const credential = optional(input.credential) ?? (existing?.authType === type ? existing.credential : undefined);
    if (type !== "none" && !credential) throw new ValidationError("credential is required for the selected authentication type"); const now = new Date().toISOString();
    const raw = input as DevOpsConfigInput & Partial<DevOpsHttpConfig>; return { schemaVersion: 1, baseUrl: baseUrl(input.baseUrl), authType: type, ...(credential ? { credential } : {}), apiKeyHeader: headerName(input.apiKeyHeader), ...(optional(input.projectId) ? { projectId: optional(input.projectId) } : {}), ...(optional(input.tenantId) ? { tenantId: optional(input.tenantId) } : {}), timeoutSeconds: timeout(input.timeoutSeconds), savedAt: preserveDates && typeof raw.savedAt === "string" ? raw.savedAt : saving ? now : existing?.savedAt ?? now, lastTestedAt: preserveDates && typeof raw.lastTestedAt === "string" ? raw.lastTestedAt : now };
  }
}
