import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentAssignment, AgentMessage, AgentMessageType, CollaborationCapability } from "./collaboration.js";
import { PolicyDenied, ValidationError } from "./errors.js";
import { utcNow } from "./models.js";
import type { Workspace } from "./storage.js";

export type CollaborationPermission = CollaborationCapability["permissions"][number];
export interface IssuedCollaborationCapability { id: string; token: string; expiresAt: string }
export interface SendAgentMessageInput { recipient: AgentMessage["recipient"]; type: AgentMessageType; subject: string; body: string; artifactRefs?: string[]; correlationId?: string; replyTo?: string }
export interface DelegationRequest { agentId: string; role: string; mode: "read-only" | "write"; objective: string; acceptanceCriteria: string[]; dependencyIds?: string[] }
export interface CollaborationBridgeAddress { host: "127.0.0.1"; port: number; url: string }
interface CapabilityContext { capability: CollaborationCapability; assignment: AgentAssignment }
interface CollaborationBridgeOptions { delegate?: (context: CapabilityContext, input: DelegationRequest) => unknown }

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const messageTypes = new Set<AgentMessageType>(["inform", "request", "response", "handoff", "review", "blocked", "escalation"]);
const permissions = new Set<CollaborationPermission>(["message.send", "message.read-own", "assignment.delegate"]);
function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ValidationError(`${label} must be an object`); return value as Record<string, unknown>; }
function id(value: unknown, label: string): string { if (typeof value !== "string" || !identifier.test(value)) throw new ValidationError(`${label} contains unsupported characters`); return value; }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${label} is required`); if (value.includes("\0") || Buffer.byteLength(value) > max) throw new ValidationError(`${label} exceeds its limit or contains unsupported characters`); return value.trim(); }
function optionalId(value: unknown, label: string): string | undefined { return value === undefined ? undefined : id(value, label); }
function safeBody(value: unknown): string { return text(value, "message body", 65_536).replaceAll(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").replaceAll(/\b(?:authorization\s*:\s*)?bearer\s+\S+/gi, "Bearer [REDACTED]").replaceAll(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[REDACTED]"); }
function artifactRefs(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 20) throw new ValidationError("artifactRefs must contain at most 20 ids"); return value.map((item) => id(item, "artifact reference")); }
function equalDigest(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

export class CollaborationMessageService {
  constructor(readonly storage: Workspace) {}

  issueCapability(input: { assignmentId: string; runId: string; permissions: CollaborationPermission[]; ttlSeconds?: number }): IssuedCollaborationCapability {
    const assignment = this.storage.getAgentAssignment(id(input.assignmentId, "assignment id")); const runId = id(input.runId, "Agent run id");
    if (assignment.agentRunId !== runId || assignment.status !== "running") throw new PolicyDenied("collaboration capability requires the Assignment's active Agent Run");
    if (!Array.isArray(input.permissions) || !input.permissions.length || input.permissions.some((item) => !permissions.has(item))) throw new ValidationError("invalid collaboration capability permissions");
    const ttlSeconds = input.ttlSeconds ?? 3_600; if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7_200) throw new ValidationError("capability ttl must be between 1 and 7200 seconds");
    const secret = randomBytes(32).toString("base64url"); const capabilityId = `collaboration-capability-${randomUUID().replaceAll("-", "")}`; const token = `${capabilityId}.${secret}`; const createdAt = utcNow(); const expiresAt = new Date(Date.parse(createdAt) + ttlSeconds * 1_000).toISOString();
    const capability: CollaborationCapability = { schemaVersion: 1, id: capabilityId, tokenDigest: digest(token), collaborationId: assignment.collaborationId, assignmentId: assignment.id, agentId: assignment.agentId, runId, permissions: [...new Set(input.permissions)], expiresAt, createdAt };
    this.storage.saveCollaborationCapability(capability); return { id: capability.id, token, expiresAt };
  }

  authenticate(token: string, permission: CollaborationPermission): CapabilityContext {
    const separator = token.indexOf("."); if (separator <= 0) throw new PolicyDenied("invalid collaboration capability"); const capabilityId = id(token.slice(0, separator), "collaboration capability id"); const capability = this.storage.getCollaborationCapability(capabilityId);
    if (!equalDigest(capability.tokenDigest, digest(token)) || capability.revokedAt || Date.parse(capability.expiresAt) <= Date.now() || !capability.permissions.includes(permission)) throw new PolicyDenied("collaboration capability is expired, revoked, or insufficient");
    const assignment = this.storage.getAgentAssignment(capability.assignmentId); if (assignment.collaborationId !== capability.collaborationId || assignment.agentId !== capability.agentId || assignment.agentRunId !== capability.runId || assignment.status !== "running") throw new PolicyDenied("collaboration capability no longer matches an active Assignment");
    return { capability, assignment };
  }

  revoke(id_: string): CollaborationCapability { const capability = this.storage.getCollaborationCapability(id(id_, "collaboration capability id")); if (!capability.revokedAt) { capability.revokedAt = utcNow(); this.storage.saveCollaborationCapability(capability); } return capability; }
  revokeForAssignment(assignmentId: string): void { for (const capability of this.storage.listCollaborationCapabilities().filter((item) => item.assignmentId === assignmentId && !item.revokedAt)) this.revoke(capability.id); }

  send(token: string, raw: SendAgentMessageInput): AgentMessage {
    const context = this.authenticate(token, "message.send"); const input = object(raw, "message"); const recipient = this.recipient(input.recipient, context.assignment); const type = input.type; if (typeof type !== "string" || !messageTypes.has(type as AgentMessageType)) throw new ValidationError("invalid Agent message type");
    const replyTo = optionalId(input.replyTo, "replyTo"); const correlationId = optionalId(input.correlationId, "correlationId"); if (replyTo) { const parent = this.storage.getAgentMessage(replyTo); if (parent.collaborationId !== context.assignment.collaborationId) throw new PolicyDenied("reply cannot cross Collaboration scope"); }
    const collaboration = this.storage.getCollaboration(context.assignment.collaborationId); const currentMessages = this.storage.listAgentMessages().filter((message) => message.collaborationId === collaboration.id).length; if (currentMessages >= collaboration.limits.maxMessages) throw new PolicyDenied("Collaboration message limit reached");
    const subject = text(input.subject, "message subject", 256); const body = safeBody(input.body); const artifacts = artifactRefs(input.artifactRefs); const createdAt = utcNow(); const messageId = `agent-message-${randomUUID().replaceAll("-", "")}`; const immutable = { collaborationId: collaboration.id, workspaceId: context.assignment.workspaceId, changeId: context.assignment.changeId, taskId: context.assignment.taskId, senderAssignmentId: context.assignment.id, senderAgentId: context.assignment.agentId, senderRunId: context.capability.runId, recipient, type: type as AgentMessageType, subject, body, artifactRefs: artifacts, ...(correlationId ? { correlationId } : {}), ...(replyTo ? { replyTo } : {}), createdAt };
    const message: AgentMessage = { schemaVersion: 1, id: messageId, ...immutable, status: "pending", digest: digest(JSON.stringify(immutable)) }; this.storage.createAgentMessage(message); collaboration.usage.messages = currentMessages + 1; collaboration.updatedAt = createdAt; this.storage.saveCollaboration(collaboration); return message;
  }

  inbox(token: string): AgentMessage[] {
    const { assignment } = this.authenticate(token, "message.read-own"); const messages = this.storage.listAgentMessages().filter((message) => message.collaborationId === assignment.collaborationId && message.status !== "consumed" && this.isRecipient(message, assignment));
    for (const message of messages.filter((item) => item.status === "pending")) { message.status = "delivered"; this.storage.saveAgentMessage(message); }
    return messages;
  }

  consume(token: string, messageId: string): AgentMessage {
    const { assignment } = this.authenticate(token, "message.read-own"); const message = this.storage.getAgentMessage(id(messageId, "message id")); if (message.collaborationId !== assignment.collaborationId || !this.isRecipient(message, assignment)) throw new PolicyDenied("Agent message is not addressed to this Assignment");
    if (message.status !== "consumed") { message.status = "consumed"; message.consumedAt = utcNow(); this.storage.saveAgentMessage(message); } return message;
  }

  private recipient(value: unknown, sender: AgentAssignment): AgentMessage["recipient"] {
    const raw = object(value, "message recipient"); if (raw.kind === "coordinator") { if (Object.keys(raw).some((key) => key !== "kind")) throw new ValidationError("coordinator recipient has unknown fields"); if (!this.storage.listAgentAssignments().some((item) => item.collaborationId === sender.collaborationId && item.role === "coordinator")) throw new ValidationError("Collaboration has no coordinator Assignment"); return { kind: "coordinator" }; }
    if (raw.kind !== "assignment" && raw.kind !== "agent") throw new ValidationError("invalid message recipient kind"); const recipientId = id(raw.id, "message recipient id"); const assignments = this.storage.listAgentAssignments().filter((item) => item.collaborationId === sender.collaborationId); const exists = raw.kind === "assignment" ? assignments.some((item) => item.id === recipientId) : assignments.some((item) => item.agentId === recipientId); if (!exists) throw new PolicyDenied("message recipient is outside the Collaboration"); return { kind: raw.kind, id: recipientId };
  }
  private isRecipient(message: AgentMessage, assignment: AgentAssignment): boolean { return message.recipient.kind === "assignment" ? message.recipient.id === assignment.id : message.recipient.kind === "agent" ? message.recipient.id === assignment.agentId : assignment.role === "coordinator"; }
}

export class CollaborationBridge {
  private server?: Server;
  constructor(readonly messages: CollaborationMessageService, private readonly options: CollaborationBridgeOptions = {}) {}
  async listen(): Promise<CollaborationBridgeAddress> { if (this.server) throw new ValidationError("Collaboration Bridge is already listening"); this.server = createServer((request, response) => void this.handle(request, response)); await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); }); }); const address = this.server.address() as AddressInfo; return { host: "127.0.0.1", port: address.port, url: `http://127.0.0.1:${address.port}` }; }
  async close(): Promise<void> { const server = this.server; this.server = undefined; if (!server) return; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> { try { const token = this.bearer(request); const method = request.method ?? "GET"; const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname; if (method === "GET" && path === "/v1/inbox") return this.json(response, 200, this.messages.inbox(token)); if (method === "GET" && path === "/v1/assignment") return this.json(response, 200, this.messages.authenticate(token, "message.read-own").assignment); if (method === "POST" && path === "/v1/messages") return this.json(response, 201, this.messages.send(token, await this.body(request) as SendAgentMessageInput)); const consume = path.match(/^\/v1\/messages\/([^/]+)\/consume$/); if (method === "POST" && consume?.[1]) return this.json(response, 200, this.messages.consume(token, decodeURIComponent(consume[1]))); if (method === "POST" && path === "/v1/delegations") { const context = this.messages.authenticate(token, "assignment.delegate"); if (!this.options.delegate) throw new ValidationError("delegation is not configured"); return this.json(response, 202, this.options.delegate(context, await this.body(request) as DelegationRequest)); } this.json(response, 404, { error: "not found" }); }
    catch (error) { this.json(response, error instanceof PolicyDenied ? 403 : 400, { error: error instanceof Error ? error.message : String(error) }); } }
  private bearer(request: IncomingMessage): string { const header = request.headers.authorization; if (!header?.startsWith("Bearer ")) throw new PolicyDenied("Collaboration capability is required"); return header.slice(7); }
  private async body(request: IncomingMessage): Promise<unknown> { let value = ""; for await (const chunk of request) { value += Buffer.from(chunk).toString("utf8"); if (Buffer.byteLength(value) > 131_072) throw new ValidationError("request body exceeds 128 KB"); } try { return JSON.parse(value || "{}"); } catch { throw new ValidationError("request body must be valid JSON"); } }
  private json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value)); }
}
