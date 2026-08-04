import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ToolBroker } from "../src/adapters.js";
import { DevOpsIntegrationManager } from "../src/devops-config.js";
import { ValidationError } from "../src/errors.js";
import { Workspace } from "../src/storage.js";

async function gateway(t: test.TestContext) {
  const seen: { authorization?: string; apiKey?: string; project?: string; tenant?: string }[] = [];
  const server = createServer((request, response) => { seen.push({ ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), ...(typeof request.headers["x-api-key"] === "string" ? { apiKey: request.headers["x-api-key"] } : {}), ...(typeof request.headers["x-cjhx-project-id"] === "string" ? { project: request.headers["x-cjhx-project-id"] } : {}), ...(typeof request.headers["x-cjhx-tenant-id"] === "string" ? { tenant: request.headers["x-cjhx-tenant-id"] } : {}) }); response.writeHead(200, { "content-type": "application/json" }); response.end(request.url === "/health" ? '{"status":"ok"}' : "[]"); });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept)); t.after(() => server.close()); const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address"); return { url: `http://127.0.0.1:${address.port}`, seen };
}

function fixture(t: test.TestContext) { const root = mkdtempSync(resolve(tmpdir(), "cjhx-devops-config-")); t.after(() => rmSync(root, { recursive: true, force: true })); const workspace = new Workspace(resolve(root, ".cjhx")); workspace.initialize(); const tools = new ToolBroker(); return { workspace, tools, manager: new DevOpsIntegrationManager(workspace, tools) }; }

test("DevOps configuration tests, saves privately, restores, and redacts credentials", async (t) => {
  const remote = await gateway(t); const { workspace, tools, manager } = fixture(t);
  const result = await manager.save({ baseUrl: remote.url, authType: "bearer", credential: "top-secret", projectId: "pay", tenantId: "tenant-1", timeoutSeconds: 5 });
  assert.equal(result.configured, true); assert.equal(result.credentialConfigured, true); assert.equal("credential" in result, false); assert.equal(remote.seen[0]?.authorization, "Bearer top-secret");
  const path = resolve(workspace.integrations, "devops.json"); assert.equal(statSync(path).mode & 0o777, 0o600); assert.match(readFileSync(path, "utf8"), /top-secret/);
  tools.removeAdapter("devops"); new DevOpsIntegrationManager(workspace, tools); assert.equal(tools.hasAdapter("devops"), true);
  const removed = manager.remove(); assert.equal(removed.configured, false); assert.equal(workspace.integrationExists("devops"), false);
});

test("DevOps configuration updates can retain an existing credential", async (t) => {
  const remote = await gateway(t); const { manager } = fixture(t); await manager.save({ baseUrl: remote.url, authType: "api-key", credential: "key-1", apiKeyHeader: "X-API-Key" });
  const result = await manager.save({ baseUrl: remote.url, authType: "api-key", apiKeyHeader: "X-API-Key", projectId: "updated" }); assert.equal(result.projectId, "updated"); assert.equal(remote.seen.at(-1)?.apiKey, "key-1");
});

test("DevOps configuration rejects unsafe URLs and header names", async (t) => {
  const { manager } = fixture(t);
  await assert.rejects(manager.test({ baseUrl: "http://devops.example", authType: "none" }), ValidationError);
  await assert.rejects(manager.test({ baseUrl: "https://devops.example", authType: "api-key", credential: "key", apiKeyHeader: "Authorization" }), ValidationError);
});
