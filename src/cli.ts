#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CJHXError } from "./errors.js";
import { CJHXFramework } from "./framework.js";
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
