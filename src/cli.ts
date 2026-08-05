#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CJHXError } from "./errors.js";
import { CJHXFramework } from "./framework.js";
import type { MemoryKind, MemoryScope, MemorySourceRef } from "./memory.js";
import { memoryKinds } from "./memory.js";
import type { JsonObject, LifecycleState, RiskLevel } from "./models.js";
import { lifecycleStates, riskLevels } from "./models.js";
import { Policy } from "./policy.js";
import { createUiServer } from "./ui.js";
import { loadWorkflow } from "./workflows.js";

interface Parsed { workspace: string; allowProcessSkills: boolean; command: string; positional: string[]; options: Map<string, string[]>; flags: Set<string> }
const usage = `CJHX Agile Workflow CLI

Usage: cjhx [--workspace PATH] [--allow-process-skills] <command> [options]

Commands:
  init
  change-create ID TITLE --owner OWNER [--description TEXT] [--risk L1]
  change-show ID
  evidence-add CHANGE_ID KIND --source SOURCE --status STATUS --subject REF [--uri URI]
  change-transition ID STATE --actor ACTOR --reason REASON [--skip-gates]
  skill-install PACKAGE
  skill-list
  skill-run ID --input JSON_OR_FILE [--change-id ID] [--approved]
  workflow-run FILE --input JSON_OR_FILE [--change-id ID] [--approve-step ID]
  harness-validate FILE
  harness-effective TASK_ID
  harness-reports [--task-id TASK_ID]
  session-start --task TASK_ID --actor ACTOR [--title TITLE]
  session-list [--task TASK_ID] [--workspace-id ID]
  session-show SESSION_ID
  session-preview SESSION_ID --message TEXT [--agent-id ID] [--instructions TEXT]
  session-continue SESSION_ID --message TEXT --context-digest DIGEST --approved [--agent-id ID] [--instructions TEXT]
  memory-list [--task TASK_ID] [--change-id ID] [--workspace-id ID]
  memory-remember --scope task|change|workspace --scope-id ID --kind KIND --content TEXT --actor ACTOR --source-type TYPE --source-id ID [--importance 3] [--pinned]
  memory-correct MEMORY_ID --content TEXT --actor ACTOR --source-type TYPE --source-id ID [--reason TEXT]
  memory-forget MEMORY_ID --actor ACTOR --reason TEXT
  ui [--host 127.0.0.1] [--port 4317] [--no-open]
`;

function parse(argv: string[]): Parsed {
  let workspace = ".cjhx"; let allowProcessSkills = false; let index = 0;
  while (index < argv.length && argv[index]?.startsWith("--")) {
    if (argv[index] === "--workspace") { workspace = argv[index + 1] ?? ""; index += 2; }
    else if (argv[index] === "--allow-process-skills") { allowProcessSkills = true; index += 1; }
    else break;
  }
  const command = argv[index] ?? ""; index += 1; const positional: string[] = []; const options = new Map<string, string[]>(); const flags = new Set<string>();
  while (index < argv.length) {
    const token = argv[index]; if (!token) break;
    if (token.startsWith("--")) { const next = argv[index + 1]; if (!next || next.startsWith("--")) { flags.add(token); index += 1; } else { options.set(token, [...(options.get(token) ?? []), next]); index += 2; } }
    else { positional.push(token); index += 1; }
  }
  return { workspace, allowProcessSkills, command, positional, options, flags };
}
function option(parsed: Parsed, key: string, required = false): string | undefined { const value = parsed.options.get(key)?.at(-1); if (required && !value) throw new Error(`missing option: ${key}`); return value; }
function position(parsed: Parsed, index: number, name: string): string { const value = parsed.positional[index]; if (!value) throw new Error(`missing argument: ${name}`); return value; }
function loadPayload(value: string): JsonObject { const raw = value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value.trimStart().startsWith("{") ? value : existsSync(value) ? readFileSync(value, "utf8") : value; const result = JSON.parse(raw) as unknown; if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("payload must be a JSON object"); return result as JsonObject; }

async function execute(parsed: Parsed): Promise<unknown> {
  const app = new CJHXFramework(parsed.workspace, { policy: new Policy({ allowProcessSkills: parsed.allowProcessSkills }) });
  switch (parsed.command) {
    case "init": app.initialize(); return { workspace: app.workspace.root, status: "initialized" };
    case "change-create": { const risk = option(parsed, "--risk") ?? "L1"; if (!riskLevels.includes(risk as RiskLevel)) throw new Error(`invalid risk: ${risk}`); return app.createChange(position(parsed, 0, "id"), position(parsed, 1, "title"), option(parsed, "--owner", true)!, { description: option(parsed, "--description"), riskLevel: risk as RiskLevel }); }
    case "change-show": return app.workspace.getChange(position(parsed, 0, "id"));
    case "evidence-add": return app.addEvidence(position(parsed, 0, "change id"), { kind: position(parsed, 1, "kind"), source: option(parsed, "--source", true)!, status: option(parsed, "--status", true)!, subjectRef: option(parsed, "--subject", true)!, ...(option(parsed, "--uri") ? { uri: option(parsed, "--uri")! } : {}) });
    case "change-transition": { const state = position(parsed, 1, "state"); if (!lifecycleStates.includes(state as LifecycleState)) throw new Error(`invalid lifecycle state: ${state}`); return app.transitionChange(position(parsed, 0, "id"), state as LifecycleState, { actor: option(parsed, "--actor", true)!, reason: option(parsed, "--reason", true)!, enforceGates: !parsed.flags.has("--skip-gates") }); }
    case "skill-install": return app.installSkill(position(parsed, 0, "package"));
    case "skill-list": return app.registry.list();
    case "skill-run": return await app.runSkill(position(parsed, 0, "skill id"), loadPayload(option(parsed, "--input", true)!), { ...(option(parsed, "--change-id") ? { changeId: option(parsed, "--change-id")! } : {}), approved: parsed.flags.has("--approved") });
    case "workflow-run": return await app.runWorkflow(loadWorkflow(position(parsed, 0, "workflow file")), loadPayload(option(parsed, "--input", true)!), { ...(option(parsed, "--change-id") ? { changeId: option(parsed, "--change-id")! } : {}), approvedSteps: new Set(parsed.options.get("--approve-step") ?? []) });
    case "harness-validate": return { valid: true, bundle: app.harness.validate(loadPayload(position(parsed, 0, "Harness rule file"))) };
    case "harness-effective": return app.harness.effectiveForTask(position(parsed, 0, "task id"));
    case "harness-reports": return app.harness.listReports(option(parsed, "--task-id"));
    case "session-start": return app.createAgentSession(option(parsed, "--task", true)!, { actor: option(parsed, "--actor", true)!, ...(option(parsed, "--title") ? { title: option(parsed, "--title") } : {}) });
    case "session-list": return app.conversations.listSessions({ ...(option(parsed, "--task") ? { taskId: option(parsed, "--task") } : {}), ...(option(parsed, "--workspace-id") ? { workspaceId: option(parsed, "--workspace-id") } : {}) });
    case "session-show": return app.conversations.getSession(position(parsed, 0, "session id"));
    case "session-preview": return app.previewAgentTurn(position(parsed, 0, "session id"), { userMessage: option(parsed, "--message", true)!, ...(option(parsed, "--agent-id") ? { agentId: option(parsed, "--agent-id") } : {}), ...(option(parsed, "--instructions") ? { instructions: option(parsed, "--instructions") } : {}) });
    case "session-continue": return app.startAgentTurn(position(parsed, 0, "session id"), { userMessage: option(parsed, "--message", true)!, approvedContextDigest: option(parsed, "--context-digest", true)!, approved: parsed.flags.has("--approved"), ...(option(parsed, "--agent-id") ? { agentId: option(parsed, "--agent-id") } : {}), ...(option(parsed, "--instructions") ? { instructions: option(parsed, "--instructions") } : {}) });
    case "memory-list": return app.memory.list({ ...(option(parsed, "--task") ? { taskId: option(parsed, "--task") } : {}), ...(option(parsed, "--change-id") ? { changeId: option(parsed, "--change-id") } : {}), ...(option(parsed, "--workspace-id") ? { workspaceId: option(parsed, "--workspace-id") } : {}) });
    case "memory-remember": { const scopeKind = option(parsed, "--scope", true)!; if (!["task", "change", "workspace"].includes(scopeKind)) throw new Error(`invalid memory scope: ${scopeKind}`); const kind = option(parsed, "--kind", true)!; if (!memoryKinds.includes(kind as MemoryKind)) throw new Error(`invalid memory kind: ${kind}`); const importance = Number(option(parsed, "--importance") ?? "3"); return app.memory.remember({ scope: { kind: scopeKind as MemoryScope["kind"], id: option(parsed, "--scope-id", true)! }, kind: kind as MemoryKind, content: option(parsed, "--content", true)!, actor: option(parsed, "--actor", true)!, importance: importance as 1 | 2 | 3 | 4 | 5, pinned: parsed.flags.has("--pinned"), sourceRefs: [{ type: option(parsed, "--source-type", true)! as MemorySourceRef["type"], id: option(parsed, "--source-id", true)! }] }); }
    case "memory-correct": return app.memory.supersede(position(parsed, 0, "memory id"), { content: option(parsed, "--content", true)!, actor: option(parsed, "--actor", true)!, sourceRefs: [{ type: option(parsed, "--source-type", true)! as MemorySourceRef["type"], id: option(parsed, "--source-id", true)! }], ...(option(parsed, "--reason") ? { reason: option(parsed, "--reason") } : {}) });
    case "memory-forget": return app.memory.forget(position(parsed, 0, "memory id"), { actor: option(parsed, "--actor", true)!, reason: option(parsed, "--reason", true)! });
    case "ui": { const rawPort = option(parsed, "--port") ?? "4317"; const port = Number(rawPort); if (!Number.isInteger(port)) throw new Error(`invalid UI port: ${rawPort}`); const ui = createUiServer(app, { host: option(parsed, "--host") ?? "127.0.0.1", port, open: !parsed.flags.has("--no-open") }); return await ui.listen(); }
    default: throw new Error(usage);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(usage); return 0; }
  try { process.stdout.write(`${JSON.stringify(await execute(parse(argv)), null, 2)}\n`); return 0; }
  catch (error) { process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`); return error instanceof CJHXError ? 2 : 1; }
}

const launchedPath = process.argv[1];
if (launchedPath && realpathSync(launchedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
