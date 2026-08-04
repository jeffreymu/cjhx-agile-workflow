import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { PolicyDenied, ValidationError } from "./errors.js";
import type { ComplianceReport, HarnessService, RuleSnapshot } from "./harness.js";
import type { JsonValue } from "./models.js";
import { utcNow } from "./models.js";
import type { Workspace } from "./storage.js";
import type { Task } from "./tasks.js";

export const agentKinds = ["claude-code", "codex", "qoder", "custom"] as const;
export type AgentKind = typeof agentKinds[number];
export type PromptTransport = "argument" | "stdin";

export interface AgentProfileInput {
  id: string;
  name: string;
  kind: AgentKind;
  command: string;
  arguments: string[];
  versionArguments?: string[];
  promptTransport: PromptTransport;
  timeoutMinutes: number;
  environmentKeys?: string[];
}

export interface AgentProfile extends AgentProfileInput { version?: string; testedAt: string; default: boolean }
export interface AgentSummary { configured: boolean; defaultAgentId?: string; profiles: AgentProfile[] }
export interface AgentRun {
  id: string;
  taskId: string;
  changeId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  status: "running" | "succeeded" | "failed" | "timed_out";
  startedAt: string;
  completedAt?: string;
  instructions?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  ruleSnapshotId?: string;
  ruleSnapshotDigest?: string;
  complianceStatus?: "pending" | "passed" | "failed" | "warning" | "unsupported";
  complianceReportId?: string;
}
export interface AgentExecutionPlan { command: string; arguments: string[]; cwd: string; environment: NodeJS.ProcessEnv; ruleSnapshot?: RuleSnapshot }
export interface AgentExecutor { readonly id: string; capabilities(): Set<string>; start(plan: AgentExecutionPlan): ChildProcessWithoutNullStreams }
export class LocalProcessExecutor implements AgentExecutor {
  readonly id = "local-process";
  capabilities(): Set<string> { return new Set(["process.arguments", "process.timeout", "process.output-limit"]); }
  start(plan: AgentExecutionPlan): ChildProcessWithoutNullStreams { return spawn(plan.command, plan.arguments, { cwd: plan.cwd, env: plan.environment, stdio: ["pipe", "pipe", "pipe"], shell: false }); }
}
interface AgentConfig { schemaVersion: 1; defaultAgentId?: string; profiles: AgentProfile[] }
interface AgentWorkspace { id: string; kind: "local" | "virtual"; rootPath?: string }
interface AgentDependencies { task(id: string): Task; workspace(id: string): AgentWorkspace; enabledSkills?(): { name: string; description: string; path: string }[]; harness?: HarnessService; executor?: AgentExecutor }

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const environmentKey = /^[A-Z_][A-Z0-9_]*$/;
const outputLimit = 1_048_576;

function required(value: string, key: string): string { const normalized = value.trim(); if (!normalized) throw new ValidationError(`${key} is required`); return normalized; }
function validStrings(value: string[] | undefined, key: string): string[] { if (!value) return []; if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && !item.includes("\0"))) throw new ValidationError(`${key} must be an array of strings`); return value; }
function limited(current: string, chunk: Buffer): string { if (Buffer.byteLength(current) >= outputLimit) return current; const available = outputLimit - Buffer.byteLength(current); return current + chunk.subarray(0, available).toString("utf8"); }

export class AgentService {
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(readonly storage: Workspace, readonly dependencies: AgentDependencies) {}

  summary(): AgentSummary { const config = this.config(); return { configured: config.profiles.length > 0, ...(config.defaultAgentId ? { defaultAgentId: config.defaultAgentId } : {}), profiles: config.profiles }; }
  listRuns(taskId?: string): AgentRun[] { return this.storage.listAgentRuns().filter((run) => !taskId || run.taskId === taskId); }
  getRun(id: string): AgentRun { return this.storage.getAgentRun(id); }
  harnessPreview(taskId: string, agentId?: string): { snapshot: RuleSnapshot; preflight: ReturnType<HarnessService["preflight"]>; executor: { id: string; evaluations: ReturnType<HarnessService["executorCapabilityEvaluations"]> } } {
    const harness = this.dependencies.harness; if (!harness) throw new ValidationError("Harness engineering is not configured"); const config = this.config(); const selected = agentId ?? config.defaultAgentId; const profile = selected ? config.profiles.find((item) => item.id === selected) : undefined; if (selected && !profile) throw new ValidationError(`agent profile not found: ${selected}`); const executor = this.dependencies.executor ?? new LocalProcessExecutor(); const snapshot = harness.effectiveForTask(taskId); return { snapshot, preflight: harness.preflight(taskId, snapshot), executor: { id: executor.id, evaluations: harness.executorCapabilityEvaluations(snapshot, executor.capabilities()) } };
  }

  async save(input: AgentProfileInput, options: { approved: boolean }): Promise<AgentProfile> {
    if (!options.approved) throw new PolicyDenied("Agent executable test requires explicit human approval");
    const normalized = this.normalize(input); const version = await this.test(normalized, options); const config = this.config(); const existing = config.profiles.find((item) => item.id === normalized.id); const defaultAgentId = config.defaultAgentId ?? normalized.id;
    const profile: AgentProfile = { ...normalized, ...(version ? { version } : {}), testedAt: utcNow(), default: defaultAgentId === normalized.id };
    config.profiles = [...config.profiles.filter((item) => item.id !== profile.id), profile].sort((a, b) => a.name.localeCompare(b.name)); config.defaultAgentId = defaultAgentId; this.applyDefault(config); this.saveConfig(config); return config.profiles.find((item) => item.id === profile.id)!;
  }

  async test(input: AgentProfileInput, options: { approved: boolean }): Promise<string> {
    if (!options.approved) throw new PolicyDenied("Agent executable test requires explicit human approval");
    const profile = this.normalize(input); const args = profile.versionArguments?.length ? profile.versionArguments : ["--version"];
    return await new Promise((accept, reject) => {
      execFile(profile.command, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 65_536, env: this.environment(profile) }, (error, stdout, stderr) => {
        if (error) { reject(new ValidationError(`Agent executable test failed: ${error.message.split("\n")[0]}`)); return; }
        accept(`${stdout || stderr}`.trim().split("\n")[0]?.slice(0, 200) ?? "");
      });
    });
  }

  activate(id: string): AgentSummary { const config = this.config(); if (!config.profiles.some((item) => item.id === id)) throw new ValidationError(`agent profile not found: ${id}`); config.defaultAgentId = id; this.applyDefault(config); this.saveConfig(config); return this.summary(); }
  remove(id: string): AgentSummary { const config = this.config(); config.profiles = config.profiles.filter((item) => item.id !== id); if (config.defaultAgentId === id) config.defaultAgentId = config.profiles[0]?.id; this.applyDefault(config); this.saveConfig(config); return this.summary(); }

  startTask(taskId: string, options: { agentId?: string; instructions?: string; approved: boolean; approvedRuleDigest?: string }): AgentRun {
    if (!options.approved) throw new PolicyDenied("Agent task execution requires explicit human approval");
    const task = this.dependencies.task(taskId); if (!task.workspaceId) throw new ValidationError("task must be associated with a local Workspace"); const workspace = this.dependencies.workspace(task.workspaceId);
    if (workspace.kind !== "local" || !workspace.rootPath || !existsSync(workspace.rootPath)) throw new ValidationError("Agent task execution requires a local Workspace");
    const config = this.config(); const agentId = options.agentId ?? config.defaultAgentId; if (!agentId) throw new ValidationError("no default Agent is configured"); const profile = config.profiles.find((item) => item.id === agentId); if (!profile) throw new ValidationError(`agent profile not found: ${agentId}`);
    const harness = this.dependencies.harness; const executor = this.dependencies.executor ?? new LocalProcessExecutor(); let snapshot: RuleSnapshot | undefined;
    if (harness) { const effective = harness.effectiveForTask(task.id); if (effective.sources.length) { snapshot = effective; if (options.approvedRuleDigest !== snapshot.digest) throw new PolicyDenied("Agent approval does not match the current Harness rule snapshot"); harness.assertPreflight(task.id, snapshot); harness.assertExecutorCapabilities(snapshot, executor.capabilities()); } }
    const instructions = options.instructions?.trim(); if (instructions?.includes("\0")) throw new ValidationError("Agent instructions contain unsupported characters"); const prompt = this.prompt(task, instructions, snapshot); if (prompt.includes("\0")) throw new ValidationError("Agent prompt contains unsupported characters"); const args = profile.arguments.map((argument) => argument.replaceAll("{prompt}", () => prompt).replaceAll("{taskId}", () => task.id).replaceAll("{changeId}", () => task.changeId));
    const id = `agent-run-${randomUUID().replaceAll("-", "")}`; const run: AgentRun = { id, taskId: task.id, changeId: task.changeId, workspaceId: task.workspaceId, agentId: profile.id, agentName: profile.name, status: "running", startedAt: utcNow(), ...(instructions ? { instructions } : {}), ...(snapshot ? { ruleSnapshotId: snapshot.id, ruleSnapshotDigest: snapshot.digest, complianceStatus: "pending" } : {}), stdout: "", stderr: "" }; this.storage.saveAgentRun(run);
    const child = executor.start({ command: profile.command, arguments: args, cwd: workspace.rootPath, environment: this.environment(profile), ...(snapshot ? { ruleSnapshot: snapshot } : {}) }); this.children.set(id, child);
    if (profile.promptTransport === "stdin") child.stdin.end(prompt); else child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => { run.stdout = limited(run.stdout, chunk); this.storage.saveAgentRun(run); }); child.stderr.on("data", (chunk: Buffer) => { run.stderr = limited(run.stderr, chunk); this.storage.saveAgentRun(run); });
    let timedOut = false; let forceTimer: NodeJS.Timeout | undefined; let finalized = false; const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000); forceTimer.unref(); }, profile.timeoutMinutes * 60_000); timer.unref();
    const finalize = async (status: AgentRun["status"], code: number, error?: string) => { if (finalized) return; finalized = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); run.status = status; run.exitCode = code; run.completedAt = utcNow(); if (error) run.stderr = limited(run.stderr, Buffer.from(error)); this.storage.saveAgentRun(run); this.children.delete(id); if (harness && snapshot) { let report: ComplianceReport; try { report = await harness.verifyRun(id, task.id, snapshot, status === "succeeded" ? "succeeded" : status === "timed_out" ? "timed_out" : "failed"); run.complianceStatus = report.status; run.complianceReportId = report.id; } catch (verificationError) { run.complianceStatus = "failed"; run.stderr = limited(run.stderr, Buffer.from(`\nHarness verification failed: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`)); } this.storage.saveAgentRun(run); } };
    child.on("error", (error) => { void finalize(timedOut ? "timed_out" : "failed", -1, error.message); });
    child.on("close", (code) => { void finalize(timedOut ? "timed_out" : code === 0 ? "succeeded" : "failed", code ?? -1); });
    return run;
  }

  private prompt(task: Task, instructions?: string, snapshot?: RuleSnapshot): string { const skills = this.dependencies.enabledSkills?.() ?? []; const skillContext = skills.length ? `Enabled local CJHX Agent skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}\n  Read and follow: ${skill.path}`).join("\n")}\nUse only the skills relevant to this task.` : ""; const harnessContext = snapshot?.effective.instructions.length ? `Harness engineering rules (${snapshot.digest}):\n${snapshot.effective.instructions.map((item) => `- ${item}`).join("\n")}\nThese instructions are governed separately from runtime controls and postflight checks.` : ""; return [`Implement CJHX task ${task.id} for change ${task.changeId}.`, `Title: ${task.title}`, task.description ? `Description: ${task.description}` : "", task.acceptanceCriteria.length ? `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : "", harnessContext, skillContext, instructions ? `Additional instructions:\n${instructions}` : "", "Create or modify files only inside the current repository. You may read only the explicitly listed Skill instruction files outside it. Do not push, publish, deploy, or perform destructive Git operations. Summarize changes and validation when complete."].filter(Boolean).join("\n\n"); }
  private normalize(input: AgentProfileInput): AgentProfileInput { const id = required(input.id, "agent id"); if (!identifier.test(id)) throw new ValidationError("agent id contains unsupported characters"); if (!agentKinds.includes(input.kind)) throw new ValidationError("invalid agent kind"); const command = required(input.command, "agent command"); if (command.includes("\0") || command.includes("\n")) throw new ValidationError("agent command contains unsupported characters"); const arguments_ = validStrings(input.arguments, "agent arguments"); const versionArguments = input.versionArguments === undefined ? undefined : validStrings(input.versionArguments, "version arguments"); if (input.promptTransport !== "argument" && input.promptTransport !== "stdin") throw new ValidationError("invalid prompt transport"); if (input.promptTransport === "argument" && !arguments_.some((item) => item.includes("{prompt}"))) throw new ValidationError("argument prompt transport requires a {prompt} placeholder"); if (!Number.isInteger(input.timeoutMinutes) || input.timeoutMinutes < 1 || input.timeoutMinutes > 120) throw new ValidationError("Agent timeout must be between 1 and 120 minutes"); const environmentKeys = validStrings(input.environmentKeys, "environment keys"); if (!environmentKeys.every((item) => environmentKey.test(item))) throw new ValidationError("environment key contains unsupported characters"); return { id, name: required(input.name, "agent name"), kind: input.kind, command, arguments: arguments_, ...(versionArguments ? { versionArguments } : {}), promptTransport: input.promptTransport, timeoutMinutes: input.timeoutMinutes, environmentKeys: [...new Set(environmentKeys)] }; }
  private environment(profile: AgentProfileInput): NodeJS.ProcessEnv { const keys = new Set(["PATH", "HOME", "LANG", "TMPDIR", ...(profile.environmentKeys ?? [])]); return Object.fromEntries([...keys].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv; }
  private config(): AgentConfig { this.storage.initialize(); if (!this.storage.agentConfigExists()) return { schemaVersion: 1, profiles: [] }; const value = this.storage.getAgentConfig() as unknown as AgentConfig; return { schemaVersion: 1, ...(value.defaultAgentId ? { defaultAgentId: value.defaultAgentId } : {}), profiles: Array.isArray(value.profiles) ? value.profiles : [] }; }
  private applyDefault(config: AgentConfig): void { config.profiles = config.profiles.map((item) => ({ ...item, default: item.id === config.defaultAgentId })); }
  private saveConfig(config: AgentConfig): void { this.storage.saveAgentConfig(config as unknown as JsonValue); }
}
