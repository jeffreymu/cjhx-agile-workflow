#!/usr/bin/env node

interface Parsed { command: string; subcommand?: string; options: Map<string, string[]> }
function parse(argv: string[]): Parsed { const command = argv[0] ?? ""; const subcommand = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined; const options = new Map<string, string[]>(); for (let index = subcommand ? 2 : 1; index < argv.length;) { const key = argv[index]; const value = argv[index + 1]; if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`invalid option: ${key ?? ""}`); options.set(key, [...(options.get(key) ?? []), value]); index += 2; } return { command, ...(subcommand ? { subcommand } : {}), options }; }
function option(parsed: Parsed, key: string, required = false): string | undefined { const value = parsed.options.get(key)?.at(-1); if (required && !value) throw new Error(`missing option: ${key}`); return value; }
function context(): { url: string; token: string } { const url = process.env.CJHX_COLLABORATION_URL; const token = process.env.CJHX_COLLABORATION_TOKEN; if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !token) throw new Error("CJHX collaboration environment is unavailable"); return { url, token }; }
async function call(path: string, options: RequestInit = {}): Promise<unknown> { const { url, token } = context(); const response = await fetch(`${url}${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { "content-type": "application/json" } : {}) } }); const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error ?? `request failed (${response.status})`); return result; }
function recipient(value: string): { kind: "coordinator" } | { kind: "assignment" | "agent"; id: string } { if (value === "coordinator") return { kind: "coordinator" }; const separator = value.indexOf(":"); if (separator <= 0) throw new Error("--to must be coordinator, assignment:ID, or agent:ID"); const kind = value.slice(0, separator); if (kind !== "assignment" && kind !== "agent") throw new Error("--to must be coordinator, assignment:ID, or agent:ID"); return { kind, id: value.slice(separator + 1) }; }

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try { const parsed = parse(argv); let result: unknown;
    if (parsed.command === "inbox") result = await call("/v1/inbox");
    else if (parsed.command === "assignment") result = await call("/v1/assignment");
    else if (parsed.command === "message" && parsed.subcommand === "send") result = await call("/v1/messages", { method: "POST", body: JSON.stringify({ recipient: recipient(option(parsed, "--to", true)!), type: option(parsed, "--type") ?? "inform", subject: option(parsed, "--subject", true), body: option(parsed, "--body", true), artifactRefs: parsed.options.get("--artifact") ?? [], ...(option(parsed, "--reply-to") ? { replyTo: option(parsed, "--reply-to") } : {}), ...(option(parsed, "--correlation-id") ? { correlationId: option(parsed, "--correlation-id") } : {}) }) });
    else if (parsed.command === "message" && parsed.subcommand === "consume") result = await call(`/v1/messages/${encodeURIComponent(option(parsed, "--id", true)!)}/consume`, { method: "POST", body: "{}" });
    else if (parsed.command === "delegate") result = await call("/v1/delegations", { method: "POST", body: JSON.stringify({ agentId: option(parsed, "--agent", true), role: option(parsed, "--role", true), mode: option(parsed, "--mode") ?? "read-only", objective: option(parsed, "--objective", true), acceptanceCriteria: parsed.options.get("--acceptance") ?? [], dependencyIds: parsed.options.get("--depends-on") ?? [] }) });
    else throw new Error("Usage: cjhx-agent inbox | assignment | message send|consume | delegate");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) { process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

if (process.argv[1]?.endsWith("agent-collaboration-cli.js")) process.exitCode = await main();
