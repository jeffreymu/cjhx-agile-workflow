import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CJHXError, ValidationError } from "./errors.js";
import { CJHXFramework } from "./framework.js";
import { availableTransitions } from "./lifecycle.js";
import { isRecord, lifecycleStates, riskLevels, type JsonObject, type JsonValue, type LifecycleState, type RiskLevel } from "./models.js";
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
  return { workspace: app.workspace.root, changes, skills, runs: app.workspace.listRuns(), lifecycleStates: [...lifecycleStates] } as unknown as JsonObject;
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
      if (method !== "GET" && request.headers["x-cjhx-ui-token"] !== token) { send(response, 403, { error: "invalid UI session token" }); return; }

      const input = method === "GET" ? {} : await body(request);
      if (method === "POST" && path === "/api/changes") {
        const risk = optionalText(input.riskLevel) ?? "L1"; if (!riskLevels.includes(risk as RiskLevel)) throw new ValidationError(`invalid risk level: ${risk}`);
        const change = app.createChange(text(input.id, "id"), text(input.title, "title"), text(input.owner, "owner"), { ...(optionalText(input.description) ? { description: optionalText(input.description) } : {}), riskLevel: risk as RiskLevel }); send(response, 201, change); return;
      }
      let match = path.match(/^\/api\/changes\/([^/]+)\/evidence$/);
      if (method === "POST" && match?.[1]) { const evidence = app.addEvidence(decode(match[1]), { kind: text(input.kind, "kind"), source: text(input.source, "source"), status: text(input.status, "status"), subjectRef: text(input.subjectRef, "subjectRef"), ...(optionalText(input.uri) ? { uri: optionalText(input.uri) } : {}) }); send(response, 201, evidence); return; }
      match = path.match(/^\/api\/changes\/([^/]+)\/transitions$/);
      if (method === "POST" && match?.[1]) { const target = text(input.target, "target"); if (!lifecycleStates.includes(target as LifecycleState)) throw new ValidationError(`invalid lifecycle state: ${target}`); const change = app.transitionChange(decode(match[1]), target as LifecycleState, { actor: text(input.actor, "actor"), reason: text(input.reason, "reason") }); send(response, 200, change); return; }
      if (method === "POST" && path === "/api/skills/install") { send(response, 201, app.installSkill(text(input.packagePath, "packagePath"))); return; }
      match = path.match(/^\/api\/skills\/([^/]+)\/runs$/);
      if (method === "POST" && match?.[1]) { const run = await app.runSkill(decode(match[1]), object(input.input, "input"), { ...(optionalText(input.changeId) ? { changeId: optionalText(input.changeId) } : {}), approved: input.approved === true }); send(response, 201, run); return; }
      if (method === "POST" && path === "/api/workflows/runs") {
        const approved = Array.isArray(input.approvedSteps) ? input.approvedSteps.filter((item): item is string => typeof item === "string") : [];
        const run = await app.runWorkflow(parseWorkflowDefinition(input.definition), object(input.input, "input"), { ...(optionalText(input.changeId) ? { changeId: optionalText(input.changeId) } : {}), approvedSteps: new Set(approved) }); send(response, 201, run); return;
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
