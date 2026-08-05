import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipelineKinds, serviceActions, type PipelineKind, type ServiceAction } from "./devops.js";
import { agentKinds, type AgentKind, type PromptTransport } from "./agents.js";
import { memoryKinds, type MemoryKind, type MemoryScope, type MemorySourceRef } from "./memory.js";
import { CJHXError, ValidationError } from "./errors.js";
import { CJHXFramework } from "./framework.js";
import { availableTransitions } from "./lifecycle.js";
import { isRecord, lifecycleStates, riskLevels, type JsonObject, type JsonValue, type LifecycleState, type RiskLevel } from "./models.js";
import { taskPriorities, taskStatuses, type TaskPriority, type TaskStatus } from "./tasks.js";
import { parseWorkflowDefinition } from "./workflows.js";

export interface UiOptions { host?: string; port?: number; open?: boolean }
export interface UiAddress { host: string; port: number; url: string }
export interface UiServer { readonly token: string; listen(): Promise<UiAddress>; close(): Promise<void> }

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const assets = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");
const assetTypes: Record<string, string> = { "/app.js": "text/javascript; charset=utf-8", "/styles.css": "text/css; charset=utf-8" };

function text(value: unknown, key: string): string { if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${key} is required`); return value.trim(); }
function optionalText(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function object(value: unknown, key: string): JsonObject { if (!isRecord(value)) throw new ValidationError(`${key} must be a JSON object`); return value as JsonObject; }
function stringArray(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new ValidationError("expected an array of strings"); return value; }
function decode(value: string): string { try { return decodeURIComponent(value); } catch { throw new ValidationError("invalid URL encoding"); } }
function isLoopbackRequestHost(value: string | undefined): boolean { if (!value) return false; try { return loopbackHosts.has(new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "")); } catch { return false; } }

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.from(chunk as Uint8Array); size += buffer.length; if (size > 1_048_576) throw new ValidationError("request body exceeds 1 MB"); chunks.push(buffer); }
  if (!chunks.length) return {};
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new ValidationError("request body must be valid JSON"); }
  if (!isRecord(value)) throw new ValidationError("request body must be a JSON object"); return value;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(payload);
}

function snapshot(app: CJHXFramework): JsonObject {
  const changes = app.workspace.listChanges().map((change) => ({ ...change, nextTransitions: availableTransitions(change) }));
  const skills = app.registry.list().map((locked) => ({ ...locked, manifest: app.registry.resolve(locked.id).manifest }));
  const agents = app.agents.summary(); const agentSummary = { configured: agents.configured, ...(agents.defaultAgentId ? { defaultAgentId: agents.defaultAgentId } : {}), profiles: agents.profiles.map(({ id, name, kind, version, testedAt, default: isDefault }) => ({ id, name, kind, ...(version ? { version } : {}), testedAt, default: isDefault })) };
  const agentRuns = app.agents.listRuns().map(({ id, taskId, changeId, workspaceId, agentId, agentName, agentKind, status, startedAt, completedAt, exitCode, ruleSnapshotDigest, complianceStatus, complianceReportId }) => ({ id, taskId, changeId, workspaceId, agentId, agentName, agentKind, status, startedAt, ...(completedAt ? { completedAt } : {}), ...(exitCode !== undefined ? { exitCode } : {}), ...(ruleSnapshotDigest ? { ruleSnapshotDigest } : {}), ...(complianceStatus ? { complianceStatus } : {}), ...(complianceReportId ? { complianceReportId } : {}) }));
  return { workspace: app.workspace.root, workspaces: app.workspaceHub.list(), changes, tasks: app.listTasks(), skills, runs: app.workspace.listRuns(), agentRuns, agents: agentSummary, lifecycleStates: [...lifecycleStates], integrations: { jiraConfigured: app.runtime.tools.hasAdapter("jira"), jiraConfig: app.jiraIntegration.summary(), devopsConfigured: app.devops.configured(), devopsConfig: app.devopsIntegration.summary(), sourceControl: app.sourceControlIntegration.summary(), gitLabConfig: app.gitLabIntegration.summary(), gitHubConfig: app.gitHubIntegration.summary() } } as unknown as JsonObject;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" }); child.on("error", () => undefined); child.unref();
}

export function createUiServer(app: CJHXFramework, options: UiOptions = {}): UiServer {
  const host = options.host ?? "127.0.0.1"; const port = options.port ?? 4317; const shouldOpen = options.open ?? true;
  if (!loopbackHosts.has(host)) throw new ValidationError("UI server may only bind to a loopback host");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ValidationError("UI port must be between 0 and 65535");
  app.initialize(); const token = randomUUID(); let server: Server | undefined;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (!isLoopbackRequestHost(request.headers.host)) { send(response, 403, { error: "invalid UI request host" }); return; }
      const method = request.method ?? "GET"; const url = new URL(request.url ?? "/", `http://${host}`); const path = url.pathname;
      if (method === "GET" && path === "/") {
        const html = readFileSync(resolve(assets, "index.html"), "utf8").replace("__CJHX_UI_TOKEN__", token);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", "cache-control": "no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff" }); response.end(html); return;
      }
      if (method === "GET" && path in assetTypes) { const content = readFileSync(resolve(assets, path.slice(1))); response.writeHead(200, { "content-type": assetTypes[path], "content-length": content.length, "cache-control": "no-cache", "x-content-type-options": "nosniff" }); response.end(content); return; }
      if (method === "GET" && path === "/api/snapshot") { send(response, 200, snapshot(app)); return; }
      if (method === "GET" && path === "/api/devops/overview") { send(response, 200, await app.devops.overview(optionalText(url.searchParams.get("changeId")))); return; }
      if (method === "GET" && path === "/api/board") { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, await app.workspaceHub.board(optionalText(url.searchParams.get("workspaceId")))); return; }
      if (method === "GET" && path === "/api/agents") { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.agents.summary()); return; }
      if (method === "GET" && path === "/api/local-skills") { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.localSkills.catalog()); return; }
      if (method === "GET" && path === "/api/agent-runs") { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.agents.listRuns(optionalText(url.searchParams.get("taskId")))); return; }
      if (method === "GET" && path === "/api/agent-sessions") { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.conversations.listSessions({ ...(optionalText(url.searchParams.get("workspaceId")) ? { workspaceId: optionalText(url.searchParams.get("workspaceId")) } : {}), ...(optionalText(url.searchParams.get("changeId")) ? { changeId: optionalText(url.searchParams.get("changeId")) } : {}), ...(optionalText(url.searchParams.get("taskId")) ? { taskId: optionalText(url.searchParams.get("taskId")) } : {}) })); return; }
      const sessionReadMatch = path.match(/^\/api\/agent-sessions\/([^/]+)$/);
      if (method === "GET" && sessionReadMatch?.[1]) { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.conversations.getSession(decode(sessionReadMatch[1]))); return; }
      if (method === "GET" && path === "/api/memories") { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.memory.list({ ...(optionalText(url.searchParams.get("workspaceId")) ? { workspaceId: optionalText(url.searchParams.get("workspaceId")) } : {}), ...(optionalText(url.searchParams.get("changeId")) ? { changeId: optionalText(url.searchParams.get("changeId")) } : {}), ...(optionalText(url.searchParams.get("taskId")) ? { taskId: optionalText(url.searchParams.get("taskId")) } : {}) })); return; }
      const memorySnapshotMatch = path.match(/^\/api\/memory-snapshots\/([^/]+)$/);
      if (method === "GET" && memorySnapshotMatch?.[1]) { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.memory.getSnapshot(decode(memorySnapshotMatch[1]))); return; }
      const executionContextMatch = path.match(/^\/api\/execution-contexts\/([^/]+)$/);
      if (method === "GET" && executionContextMatch?.[1]) { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.conversations.getExecutionContext(decode(executionContextMatch[1]))); return; }
      const agentRunReadMatch = path.match(/^\/api\/agent-runs\/([^/]+)$/);
      if (method === "GET" && agentRunReadMatch?.[1]) { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.agents.getRun(decode(agentRunReadMatch[1]))); return; }
      const harnessTaskMatch = path.match(/^\/api\/tasks\/([^/]+)\/harness$/);
      if (method === "GET" && harnessTaskMatch?.[1]) { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.agents.harnessPreview(decode(harnessTaskMatch[1]), optionalText(url.searchParams.get("agentId")))); return; }
      if (method === "GET" && path === "/api/harness/reports") { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.harness.listReports(optionalText(url.searchParams.get("taskId")))); return; }
      const harnessReportMatch = path.match(/^\/api\/harness\/reports\/([^/]+)$/);
      if (method === "GET" && harnessReportMatch?.[1]) { if (request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; } send(response, 200, app.harness.getReport(decode(harnessReportMatch[1]))); return; }
      let workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)\/(overview|kanban|sessions|team|tree|file|search|refs|commits|worktrees|issues|change-requests)$/);
      if (method === "GET" && workspaceMatch && request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; }
      if (method === "GET" && workspaceMatch?.[1] && workspaceMatch[2]) { const id = decode(workspaceMatch[1]); const action = workspaceMatch[2]; const ref = optionalText(url.searchParams.get("ref")); const itemPath = url.searchParams.get("path") ?? ""; const result = action === "overview" ? await app.workspaceHub.overview(id) : action === "kanban" ? await app.workspaceHub.kanban(id) : action === "sessions" ? app.workspaceHub.sessions(id) : action === "team" ? await app.workspaceHub.team(id) : action === "tree" ? await app.workspaceHub.tree(id, itemPath, ref) : action === "file" ? await app.workspaceHub.file(id, text(itemPath, "path"), ref) : action === "search" ? app.workspaceHub.search(id, text(url.searchParams.get("q"), "q")) : action === "refs" ? await app.workspaceHub.refs(id) : action === "commits" ? await app.workspaceHub.commits(id, ref) : action === "worktrees" ? app.workspaceHub.worktrees(id) : action === "issues" ? await app.workspaceHub.issues(id) : await app.workspaceHub.changeRequests(id); send(response, 200, result); return; }
      workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)\/commits\/([^/]+)\/check$/);
      if (method === "GET" && workspaceMatch && request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; }
      if (method === "GET" && workspaceMatch?.[1] && workspaceMatch[2]) { send(response, 200, await app.workspaceHub.inspectCommit(decode(workspaceMatch[1]), decode(workspaceMatch[2]))); return; }
      workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)\/(issues|change-requests)\/(\d+)\/comments$/);
      if (method === "GET" && workspaceMatch && request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; }
      if (method === "GET" && workspaceMatch?.[1] && workspaceMatch[2] && workspaceMatch[3]) { send(response, 200, await app.workspaceHub.comments(decode(workspaceMatch[1]), workspaceMatch[2] === "issues" ? "issue" : "change-request", Number(workspaceMatch[3]))); return; }
      if (method === "GET" && path === "/api/jira/config") { send(response, 200, app.jiraIntegration.summary()); return; }
      if (method === "GET" && path === "/api/gitlab/config") { send(response, 200, app.gitLabIntegration.summary()); return; }
      if (method === "GET" && path === "/api/github/config") { send(response, 200, app.gitHubIntegration.summary()); return; }
      if (method === "GET" && path === "/api/devops/config") { send(response, 200, app.devopsIntegration.summary()); return; }
      if (method !== "GET" && request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; }

      const input = method === "GET" ? {} : await body(request);
      const agentInput = () => { const kind = text(input.kind, "kind"); if (!agentKinds.includes(kind as AgentKind)) throw new ValidationError("invalid agent kind"); const promptTransport = text(input.promptTransport, "promptTransport"); if (promptTransport !== "argument" && promptTransport !== "stdin") throw new ValidationError("invalid prompt transport"); return { id: text(input.id, "id"), name: text(input.name, "name"), kind: kind as AgentKind, command: text(input.command, "command"), arguments: stringArray(input.arguments), versionArguments: stringArray(input.versionArguments), promptTransport: promptTransport as PromptTransport, timeoutMinutes: Number(input.timeoutMinutes), environmentKeys: stringArray(input.environmentKeys) }; };
      if (method === "POST" && path === "/api/agents/test") { send(response, 200, { version: await app.agents.test(agentInput(), { approved: input.approved === true }) }); return; }
      let agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (method === "PUT" && agentMatch?.[1]) { const profile = agentInput(); if (profile.id !== decode(agentMatch[1])) throw new ValidationError("agent id does not match URL"); send(response, 200, await app.agents.save(profile, { approved: input.approved === true })); return; }
      if (method === "DELETE" && agentMatch?.[1]) { send(response, 200, app.agents.remove(decode(agentMatch[1]))); return; }
      agentMatch = path.match(/^\/api\/agents\/([^/]+)\/activate$/);
      if (method === "POST" && agentMatch?.[1]) { send(response, 200, app.agents.activate(decode(agentMatch[1]))); return; }
      const agentRunMatch = path.match(/^\/api\/tasks\/([^/]+)\/agent-runs$/);
      if (method === "POST" && agentRunMatch?.[1]) { send(response, 202, app.startAgentForTask(decode(agentRunMatch[1]), { ...(optionalText(input.agentId) ? { agentId: optionalText(input.agentId) } : {}), ...(optionalText(input.instructions) ? { instructions: optionalText(input.instructions) } : {}), ...(optionalText(input.approvedRuleDigest) ? { approvedRuleDigest: optionalText(input.approvedRuleDigest) } : {}), approved: input.approved === true })); return; }
      if (method === "POST" && path === "/api/agent-sessions") { send(response, 201, app.createAgentSession(text(input.taskId, "taskId"), { ...(optionalText(input.title) ? { title: optionalText(input.title) } : {}), actor: text(input.actor, "actor") })); return; }
      let sessionMatch = path.match(/^\/api\/agent-sessions\/([^/]+)\/archive$/);
      if (method === "POST" && sessionMatch?.[1]) { send(response, 200, app.conversations.archiveSession(decode(sessionMatch[1]), text(input.actor, "actor"))); return; }
      sessionMatch = path.match(/^\/api\/agent-sessions\/([^/]+)\/turns\/preview$/);
      if (method === "POST" && sessionMatch?.[1]) { send(response, 200, app.previewAgentTurn(decode(sessionMatch[1]), { userMessage: text(input.userMessage, "userMessage"), ...(optionalText(input.agentId) ? { agentId: optionalText(input.agentId) } : {}), ...(optionalText(input.instructions) ? { instructions: optionalText(input.instructions) } : {}) })); return; }
      sessionMatch = path.match(/^\/api\/agent-sessions\/([^/]+)\/turns$/);
      if (method === "POST" && sessionMatch?.[1]) { send(response, 202, app.startAgentTurn(decode(sessionMatch[1]), { userMessage: text(input.userMessage, "userMessage"), ...(optionalText(input.agentId) ? { agentId: optionalText(input.agentId) } : {}), ...(optionalText(input.instructions) ? { instructions: optionalText(input.instructions) } : {}), approved: input.approved === true, approvedContextDigest: text(input.approvedContextDigest, "approvedContextDigest") })); return; }
      if (method === "POST" && path === "/api/memories") { const kind = text(input.kind, "kind"); if (!memoryKinds.includes(kind as MemoryKind)) throw new ValidationError("invalid memory kind"); const scope = object(input.scope, "scope"); const scopeKind = text(scope.kind, "scope.kind"); if (!["task", "change", "workspace"].includes(scopeKind)) throw new ValidationError("invalid memory scope"); const sources = Array.isArray(input.sourceRefs) ? input.sourceRefs.map((item) => { const value = object(item, "sourceRef"); return { type: text(value.type, "sourceRef.type"), id: text(value.id, "sourceRef.id") } as MemorySourceRef; }) : []; send(response, 201, app.memory.remember({ scope: { kind: scopeKind as MemoryScope["kind"], id: text(scope.id, "scope.id") }, kind: kind as MemoryKind, content: text(input.content, "content"), importance: Number(input.importance ?? 3) as 1 | 2 | 3 | 4 | 5, pinned: input.pinned === true, sourceRefs: sources, sensitivity: input.sensitivity === "confidential" ? "confidential" : "internal", ...(optionalText(input.expiresAt) ? { expiresAt: optionalText(input.expiresAt) } : {}), actor: text(input.actor, "actor") })); return; }
      let memoryMatch = path.match(/^\/api\/memories\/([^/]+)\/supersede$/);
      if (method === "POST" && memoryMatch?.[1]) { const sources = Array.isArray(input.sourceRefs) ? input.sourceRefs.map((item) => { const value = object(item, "sourceRef"); return { type: text(value.type, "sourceRef.type"), id: text(value.id, "sourceRef.id") } as MemorySourceRef; }) : []; send(response, 201, app.memory.supersede(decode(memoryMatch[1]), { content: text(input.content, "content"), actor: text(input.actor, "actor"), sourceRefs: sources, ...(optionalText(input.reason) ? { reason: optionalText(input.reason) } : {}), ...(input.importance !== undefined ? { importance: Number(input.importance) as 1 | 2 | 3 | 4 | 5 } : {}), ...(input.pinned !== undefined ? { pinned: input.pinned === true } : {}), ...(optionalText(input.expiresAt) ? { expiresAt: optionalText(input.expiresAt) } : {}) })); return; }
      memoryMatch = path.match(/^\/api\/memories\/([^/]+)\/forget$/);
      if (method === "POST" && memoryMatch?.[1]) { send(response, 200, app.memory.forget(decode(memoryMatch[1]), { actor: text(input.actor, "actor"), reason: text(input.reason, "reason") })); return; }
      memoryMatch = path.match(/^\/api\/memories\/([^/]+)\/pin$/);
      if (method === "POST" && memoryMatch?.[1]) { send(response, 200, app.memory.pin(decode(memoryMatch[1]), input.pinned === true, text(input.actor, "actor"))); return; }
      if (method === "POST" && path === "/api/workspaces") { const kind = text(input.kind, "kind"); if (kind === "local") send(response, 201, app.workspaceHub.addLocal({ path: text(input.path, "path"), ...(optionalText(input.name) ? { name: optionalText(input.name) } : {}) })); else if (kind === "virtual") { const provider = text(input.provider, "provider"); if (provider !== "gitlab" && provider !== "github") throw new ValidationError("provider must be gitlab or github"); send(response, 201, await app.workspaceHub.addVirtual({ provider, repositoryId: text(input.repositoryId, "repositoryId"), ...(optionalText(input.name) ? { name: optionalText(input.name) } : {}), ...(optionalText(input.defaultRef) ? { defaultRef: optionalText(input.defaultRef) } : {}) })); } else throw new ValidationError("kind must be local or virtual"); return; }
      workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
      if (method === "DELETE" && workspaceMatch?.[1]) { app.workspaceHub.remove(decode(workspaceMatch[1])); send(response, 200, { removed: true }); return; }
      workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)\/refs$/);
      if (method === "POST" && workspaceMatch?.[1]) { const type = text(input.type, "type"); if (type !== "branch" && type !== "tag") throw new ValidationError("type must be branch or tag"); send(response, 201, app.workspaceHub.createRef(decode(workspaceMatch[1]), { name: text(input.name, "name"), revision: text(input.revision, "revision"), type, approved: input.approved === true })); return; }
      workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)\/refs\/delete$/);
      if (method === "POST" && workspaceMatch?.[1]) { const type = text(input.type, "type"); if (type !== "branch" && type !== "tag") throw new ValidationError("type must be branch or tag"); send(response, 200, app.workspaceHub.deleteRef(decode(workspaceMatch[1]), { name: text(input.name, "name"), type, approved: input.approved === true })); return; }
      workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)\/worktrees$/);
      if (method === "POST" && workspaceMatch?.[1]) { send(response, 201, app.workspaceHub.addWorktree(decode(workspaceMatch[1]), { path: text(input.path, "path"), ref: text(input.ref, "ref"), ...(optionalText(input.createBranch) ? { createBranch: optionalText(input.createBranch) } : {}), approved: input.approved === true })); return; }
      workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)\/worktrees\/remove$/);
      if (method === "POST" && workspaceMatch?.[1]) { send(response, 200, app.workspaceHub.removeWorktree(decode(workspaceMatch[1]), { path: text(input.path, "path"), approved: input.approved === true })); return; }
      if (method === "POST" && path === "/api/changes") {
        const risk = optionalText(input.riskLevel) ?? "L1"; if (!riskLevels.includes(risk as RiskLevel)) throw new ValidationError(`invalid risk level: ${risk}`);
        const change = app.createChange(text(input.id, "id"), text(input.title, "title"), text(input.owner, "owner"), { ...(optionalText(input.workspaceId) ? { workspaceId: optionalText(input.workspaceId) } : {}), ...(optionalText(input.description) ? { description: optionalText(input.description) } : {}), riskLevel: risk as RiskLevel }); send(response, 201, change); return;
      }
      let match = path.match(/^\/api\/changes\/([^/]+)\/evidence$/);
      if (method === "POST" && match?.[1]) { const evidence = app.addEvidence(decode(match[1]), { kind: text(input.kind, "kind"), source: text(input.source, "source"), status: text(input.status, "status"), subjectRef: text(input.subjectRef, "subjectRef"), ...(optionalText(input.uri) ? { uri: optionalText(input.uri) } : {}) }); send(response, 201, evidence); return; }
      match = path.match(/^\/api\/changes\/([^/]+)\/transitions$/);
      if (method === "POST" && match?.[1]) { const target = text(input.target, "target"); if (!lifecycleStates.includes(target as LifecycleState)) throw new ValidationError(`invalid lifecycle state: ${target}`); const change = app.transitionChange(decode(match[1]), target as LifecycleState, { actor: text(input.actor, "actor"), reason: text(input.reason, "reason") }); send(response, 200, change); return; }
      if (method === "POST" && path === "/api/gitlab/config/test") {
        send(response, 200, await app.gitLabIntegration.test({ baseUrl: text(input.baseUrl, "baseUrl"), authType: text(input.authType, "authType") as "none" | "private-token" | "bearer" | "job-token", ...(optionalText(input.credential) ? { credential: optionalText(input.credential) } : {}), ...(optionalText(input.apiPath) ? { apiPath: optionalText(input.apiPath) } : {}), ...(optionalText(input.projectId) ? { projectId: optionalText(input.projectId) } : {}), ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: Number(input.timeoutSeconds) } : {}) })); return;
      }
      if (method === "PUT" && path === "/api/gitlab/config") {
        send(response, 200, await app.gitLabIntegration.save({ baseUrl: text(input.baseUrl, "baseUrl"), authType: text(input.authType, "authType") as "none" | "private-token" | "bearer" | "job-token", ...(optionalText(input.credential) ? { credential: optionalText(input.credential) } : {}), ...(optionalText(input.apiPath) ? { apiPath: optionalText(input.apiPath) } : {}), ...(optionalText(input.projectId) ? { projectId: optionalText(input.projectId) } : {}), ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: Number(input.timeoutSeconds) } : {}) })); return;
      }
      if (method === "POST" && path === "/api/gitlab/config/activate") { send(response, 200, app.gitLabIntegration.activate()); return; }
      if (method === "DELETE" && path === "/api/gitlab/config") { send(response, 200, app.gitLabIntegration.remove()); return; }
      if (method === "POST" && path === "/api/github/config/test") {
        send(response, 200, await app.gitHubIntegration.test({ baseUrl: text(input.baseUrl, "baseUrl"), authType: text(input.authType, "authType") as "none" | "bearer" | "token", ...(optionalText(input.credential) ? { credential: optionalText(input.credential) } : {}), ...(input.apiPath !== undefined ? { apiPath: typeof input.apiPath === "string" ? input.apiPath : "" } : {}), ...(optionalText(input.repository) ? { repository: optionalText(input.repository) } : {}), ...(optionalText(input.apiVersion) ? { apiVersion: optionalText(input.apiVersion) } : {}), ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: Number(input.timeoutSeconds) } : {}) })); return;
      }
      if (method === "PUT" && path === "/api/github/config") {
        send(response, 200, await app.gitHubIntegration.save({ baseUrl: text(input.baseUrl, "baseUrl"), authType: text(input.authType, "authType") as "none" | "bearer" | "token", ...(optionalText(input.credential) ? { credential: optionalText(input.credential) } : {}), ...(input.apiPath !== undefined ? { apiPath: typeof input.apiPath === "string" ? input.apiPath : "" } : {}), ...(optionalText(input.repository) ? { repository: optionalText(input.repository) } : {}), ...(optionalText(input.apiVersion) ? { apiVersion: optionalText(input.apiVersion) } : {}), ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: Number(input.timeoutSeconds) } : {}) })); return;
      }
      if (method === "POST" && path === "/api/github/config/activate") { send(response, 200, app.gitHubIntegration.activate()); return; }
      if (method === "DELETE" && path === "/api/github/config") { send(response, 200, app.gitHubIntegration.remove()); return; }
      if (method === "POST" && path === "/api/jira/config/test") {
        send(response, 200, await app.jiraIntegration.test({ baseUrl: text(input.baseUrl, "baseUrl"), authType: text(input.authType, "authType") as "none" | "bearer" | "api-key" | "basic", ...(optionalText(input.credential) ? { credential: optionalText(input.credential) } : {}), ...(optionalText(input.apiKeyHeader) ? { apiKeyHeader: optionalText(input.apiKeyHeader) } : {}), ...(optionalText(input.projectKey) ? { projectKey: optionalText(input.projectKey) } : {}), ...(optionalText(input.issueType) ? { issueType: optionalText(input.issueType) } : {}), ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: Number(input.timeoutSeconds) } : {}) })); return;
      }
      if (method === "PUT" && path === "/api/jira/config") {
        send(response, 200, await app.jiraIntegration.save({ baseUrl: text(input.baseUrl, "baseUrl"), authType: text(input.authType, "authType") as "none" | "bearer" | "api-key" | "basic", ...(optionalText(input.credential) ? { credential: optionalText(input.credential) } : {}), ...(optionalText(input.apiKeyHeader) ? { apiKeyHeader: optionalText(input.apiKeyHeader) } : {}), ...(optionalText(input.projectKey) ? { projectKey: optionalText(input.projectKey) } : {}), ...(optionalText(input.issueType) ? { issueType: optionalText(input.issueType) } : {}), ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: Number(input.timeoutSeconds) } : {}) })); return;
      }
      if (method === "DELETE" && path === "/api/jira/config") { send(response, 200, app.jiraIntegration.remove()); return; }
      if (method === "POST" && path === "/api/devops/config/test") {
        send(response, 200, await app.devopsIntegration.test({ baseUrl: text(input.baseUrl, "baseUrl"), authType: text(input.authType, "authType") as "none" | "bearer" | "api-key", ...(optionalText(input.credential) ? { credential: optionalText(input.credential) } : {}), ...(optionalText(input.apiKeyHeader) ? { apiKeyHeader: optionalText(input.apiKeyHeader) } : {}), ...(optionalText(input.projectId) ? { projectId: optionalText(input.projectId) } : {}), ...(optionalText(input.tenantId) ? { tenantId: optionalText(input.tenantId) } : {}), ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: Number(input.timeoutSeconds) } : {}) })); return;
      }
      if (method === "PUT" && path === "/api/devops/config") {
        send(response, 200, await app.devopsIntegration.save({ baseUrl: text(input.baseUrl, "baseUrl"), authType: text(input.authType, "authType") as "none" | "bearer" | "api-key", ...(optionalText(input.credential) ? { credential: optionalText(input.credential) } : {}), ...(optionalText(input.apiKeyHeader) ? { apiKeyHeader: optionalText(input.apiKeyHeader) } : {}), ...(optionalText(input.projectId) ? { projectId: optionalText(input.projectId) } : {}), ...(optionalText(input.tenantId) ? { tenantId: optionalText(input.tenantId) } : {}), ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: Number(input.timeoutSeconds) } : {}) })); return;
      }
      if (method === "DELETE" && path === "/api/devops/config") { send(response, 200, app.devopsIntegration.remove()); return; }
      if (method === "POST" && path === "/api/devops/pipelines/trigger") {
        const kind = text(input.kind, "kind"); if (!pipelineKinds.includes(kind as PipelineKind)) throw new ValidationError(`invalid pipeline kind: ${kind}`);
        send(response, 202, await app.devops.triggerPipeline({ pipelineId: text(input.pipelineId, "pipelineId"), kind: kind as PipelineKind, ...(optionalText(input.changeId) ? { changeId: optionalText(input.changeId) } : {}), ...(optionalText(input.ref) ? { ref: optionalText(input.ref) } : {}), ...(optionalText(input.environment) ? { environment: optionalText(input.environment) } : {}), actor: text(input.actor, "actor"), reason: text(input.reason, "reason"), approved: input.approved === true })); return;
      }
      if (method === "POST" && path === "/api/devops/services/control") {
        const action = text(input.action, "action"); if (!serviceActions.includes(action as ServiceAction)) throw new ValidationError(`invalid service action: ${action}`);
        send(response, 202, await app.devops.controlService({ serviceId: text(input.serviceId, "serviceId"), action: action as ServiceAction, ...(optionalText(input.environment) ? { environment: optionalText(input.environment) } : {}), actor: text(input.actor, "actor"), reason: text(input.reason, "reason"), approved: input.approved === true })); return;
      }
      if (method === "POST" && path === "/api/tasks") {
        const priority = optionalText(input.priority) ?? "P2"; const riskLevel = optionalText(input.riskLevel) ?? "L1"; const status = optionalText(input.status) ?? "todo";
        if (!taskPriorities.includes(priority as TaskPriority)) throw new ValidationError(`invalid task priority: ${priority}`); if (!riskLevels.includes(riskLevel as RiskLevel)) throw new ValidationError(`invalid task risk: ${riskLevel}`); if (!taskStatuses.includes(status as TaskStatus)) throw new ValidationError(`invalid task status: ${status}`);
        const task = app.createTask({ changeId: text(input.changeId, "changeId"), ...(optionalText(input.workspaceId) ? { workspaceId: optionalText(input.workspaceId) } : {}), title: text(input.title, "title"), ...(optionalText(input.description) ? { description: optionalText(input.description) } : {}), ...(optionalText(input.owner) ? { owner: optionalText(input.owner) } : {}), priority: priority as TaskPriority, riskLevel: riskLevel as RiskLevel, status: status as TaskStatus, acceptanceCriteria: stringArray(input.acceptanceCriteria), dependencies: stringArray(input.dependencies), evidenceRefs: stringArray(input.evidenceRefs) }); send(response, 201, task); return;
      }
      match = path.match(/^\/api\/runs\/([^/]+)\/tasks\/import$/);
      if (method === "POST" && match?.[1]) { send(response, 201, app.importTasksFromRun(decode(match[1]), text(input.changeId, "changeId"))); return; }
      match = path.match(/^\/api\/tasks\/([^/]+)\/transitions$/);
      if (method === "POST" && match?.[1]) { const target = text(input.target, "target"); if (!taskStatuses.includes(target as TaskStatus)) throw new ValidationError(`invalid task status: ${target}`); const task = await app.transitionTaskInAuthority(decode(match[1]), target as TaskStatus, { actor: text(input.actor, "actor"), reason: text(input.reason, "reason"), approved: input.approved === true }); send(response, 200, task); return; }
      match = path.match(/^\/api\/tasks\/([^/]+)\/jira\/publish$/);
      if (method === "POST" && match?.[1]) { send(response, 200, await app.publishTaskToJira(decode(match[1]), { approved: input.approved === true })); return; }
      match = path.match(/^\/api\/tasks\/([^/]+)\/jira\/sync$/);
      if (method === "POST" && match?.[1]) { send(response, 200, await app.syncTaskFromJira(decode(match[1]))); return; }
      if (method === "POST" && path === "/api/skills/install") { send(response, 201, app.installSkill(text(input.packagePath, "packagePath"))); return; }
      match = path.match(/^\/api\/local-skills\/([^/]+)\/(enable|disable)$/);
      if (method === "POST" && match?.[1] && match[2]) { send(response, 200, match[2] === "enable" ? app.localSkills.enable(decode(match[1])) : app.localSkills.disable(decode(match[1]))); return; }
      match = path.match(/^\/api\/skills\/([^/]+)\/runs$/);
      if (method === "POST" && match?.[1]) { const run = await app.runSkill(decode(match[1]), object(input.input, "input"), { ...(optionalText(input.changeId) ? { changeId: optionalText(input.changeId) } : {}), ...(optionalText(input.workspaceId) ? { workspaceId: optionalText(input.workspaceId) } : {}), approved: input.approved === true }); send(response, 201, run); return; }
      if (method === "POST" && path === "/api/workflows/runs") {
        const approved = Array.isArray(input.approvedSteps) ? input.approvedSteps.filter((item): item is string => typeof item === "string") : [];
        const run = await app.runWorkflow(parseWorkflowDefinition(input.definition), object(input.input, "input"), { ...(optionalText(input.changeId) ? { changeId: optionalText(input.changeId) } : {}), ...(optionalText(input.workspaceId) ? { workspaceId: optionalText(input.workspaceId) } : {}), approvedSteps: new Set(approved) }); send(response, 201, run); return;
      }
      send(response, 404, { error: "route not found" });
    } catch (error) { send(response, error instanceof CJHXError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) }); }
  };

  return {
    token,
    async listen() { if (server) throw new ValidationError("UI server is already listening"); server = createServer((request, response) => { void handle(request, response); }); await new Promise<void>((accept, reject) => { server?.once("error", reject); server?.listen(port, host, () => accept()); }); const address = server.address(); if (!address || typeof address === "string") throw new Error("UI server did not expose a TCP address"); const displayHost = host === "::1" ? "[::1]" : host; const result = { host, port: address.port, url: `http://${displayHost}:${address.port}` }; if (shouldOpen) openBrowser(result.url); return result; },
    async close() { if (!server) return; const active = server; server = undefined; await new Promise<void>((accept, reject) => active.close((error) => error ? reject(error) : accept())); },
  };
}
