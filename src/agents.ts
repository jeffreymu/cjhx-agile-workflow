import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { openAgentTerminal, buildAgentTerminalScript, type AgentTerminalLaunch, type AgentTerminalLauncher } from "./agent-terminal.js";
import { PolicyDenied, ValidationError } from "./errors.js";
import type { ComplianceReport, HarnessService, RuleSnapshot } from "./harness.js";
import type { JsonValue } from "./models.js";
import { utcNow } from "./models.js";
import type { Workspace } from "./storage.js";
import type { Task } from "./tasks.js";

export const agentKinds = ["pi", "claude-code", "codex", "qoder", "custom"] as const;
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
export type TokenUsageSource = "provider-reported" | "driver-reported" | "estimated" | "unavailable";
export interface AgentTokenUsage { source: TokenUsageSource; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; totalTokens?: number; observedAt: string }
export interface AgentUsageCollector { collect(value: string): AgentTokenUsage | undefined }
export class PiUsageCollector implements AgentUsageCollector { collect(value: string): AgentTokenUsage | undefined { return parseAgentUsage(value, "pi"); } }
export class ClaudeCodeUsageCollector implements AgentUsageCollector { collect(value: string): AgentTokenUsage | undefined { return parseAgentUsage(value, "claude-code"); } }
export class CodexUsageCollector implements AgentUsageCollector { collect(value: string): AgentTokenUsage | undefined { return parseAgentUsage(value, "codex"); } }
export class QoderUsageCollector implements AgentUsageCollector { collect(value: string): AgentTokenUsage | undefined { return parseAgentUsage(value, "qoder"); } }
export class CustomAgentUsageCollector implements AgentUsageCollector { collect(value: string): AgentTokenUsage | undefined { return parseAgentUsage(value, "custom"); } }
export interface TokenUsageSummary { scope: { kind: "all" | "run" | "session" | "task" | "workspace" | "automation" | "automation-run"; id?: string }; runs: number; runningRuns: number; completedRuns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; totalTokens: number; measuredTokens: number; estimatedTokens: number; unavailableRuns: number; updatedAt: string }
export interface AgentRun {
  id: string;
  taskId: string;
  changeId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  agentKind: AgentKind;
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
  sessionId?: string;
  turnId?: string;
  memorySnapshotId?: string;
  memorySnapshotDigest?: string;
  executionContextId?: string;
  executionContextDigest?: string;
  promptDigest?: string;
  automationId?: string;
  automationRunId?: string;
  usage?: AgentTokenUsage;
  usageUpdatedAt?: string;
  processInstanceId?: string;
  processId?: number;
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
interface AgentDependencies { task(id: string): Task; workspace(id: string): AgentWorkspace; enabledSkills?(): { name: string; description: string; path: string }[]; harness?: HarnessService; executor?: AgentExecutor; terminalLauncher?: AgentTerminalLauncher }
export interface AgentPreparedTask { task: Task; profile: AgentProfile; workspace: AgentWorkspace & { rootPath: string }; prompt: string; agentProfileDigest: string; ruleSnapshot?: RuleSnapshot }
export interface AgentRunContext { sessionId: string; turnId: string; memorySnapshotId: string; memorySnapshotDigest: string; executionContextId: string; executionContextDigest: string; promptDigest: string }
export interface StartAgentTaskOptions { agentId?: string; instructions?: string; userMessage?: string; historicalContext?: string; approved: boolean; approvedRuleDigest?: string; context?: AgentRunContext; automationId?: string; automationRunId?: string; onCompleted?: (run: AgentRun) => void }

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const environmentKey = /^[A-Z_][A-Z0-9_]*$/;
const outputLimit = 1_048_576;

function required(value: string, key: string): string { const normalized = value.trim(); if (!normalized) throw new ValidationError(`${key} is required`); return normalized; }
function validStrings(value: string[] | undefined, key: string): string[] { if (!value) return []; if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && !item.includes("\0"))) throw new ValidationError(`${key} must be an array of strings`); return value; }
function limited(current: string, chunk: Buffer): string { if (Buffer.byteLength(current) >= outputLimit) return current; const available = outputLimit - Buffer.byteLength(current); return current + chunk.subarray(0, available).toString("utf8"); }
function hash(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function estimatedTokens(value: string): number { if (!value) return 0; const cjk = [...value].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)).length; return Math.max(1, Math.ceil((value.length - cjk) / 4 + cjk)); }
function usageNumber(value: unknown, key: string): number | undefined { if (value === undefined) return undefined; if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000_000) throw new ValidationError(`invalid Agent usage field: ${key}`); return Number(value); }
export function parseAgentUsage(value: string, kind: AgentKind = "custom"): AgentTokenUsage | undefined { const lines = value.replaceAll(/\r\n/g, "\n").split("\n").filter((line) => line.startsWith("CJHX_USAGE:")); if (!lines.length) return undefined; const raw = lines.at(-1)!.slice("CJHX_USAGE:".length); if (Buffer.byteLength(raw) > 4_096) throw new ValidationError("Agent usage event exceeds 4 KB"); let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new ValidationError("Agent usage event is not valid JSON"); } if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ValidationError("Agent usage event must be an object"); const item = parsed as Record<string, unknown>; const allowed = new Set(["source", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"]); if (Object.keys(item).some((key) => !allowed.has(key))) throw new ValidationError("Agent usage event contains unknown fields"); if (item.source !== "provider-reported" && item.source !== "driver-reported") throw new ValidationError("Agent usage source must be provider-reported or driver-reported"); const source = item.source === "provider-reported" && kind !== "custom" ? "provider-reported" : "driver-reported"; const inputTokens = usageNumber(item.inputTokens, "inputTokens") ?? 0; const outputTokens = usageNumber(item.outputTokens, "outputTokens") ?? 0; const cacheReadTokens = usageNumber(item.cacheReadTokens, "cacheReadTokens"); const cacheWriteTokens = usageNumber(item.cacheWriteTokens, "cacheWriteTokens"); const reasoningTokens = usageNumber(item.reasoningTokens, "reasoningTokens"); const reportedTotal = usageNumber(item.totalTokens, "totalTokens"); const totalTokens = inputTokens + outputTokens; if (reportedTotal !== undefined && reportedTotal !== totalTokens) throw new ValidationError("Agent usage totalTokens must equal inputTokens + outputTokens"); return { source, inputTokens, outputTokens, ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}), ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}), ...(reasoningTokens !== undefined ? { reasoningTokens } : {}), totalTokens, observedAt: utcNow() }; }
function usageCollector(kind: AgentKind): AgentUsageCollector { return kind === "pi" ? new PiUsageCollector() : kind === "claude-code" ? new ClaudeCodeUsageCollector() : kind === "codex" ? new CodexUsageCollector() : kind === "qoder" ? new QoderUsageCollector() : new CustomAgentUsageCollector(); }
function monotonicUsage(previous: AgentTokenUsage | undefined, next: AgentTokenUsage): boolean { if (!previous || previous.source === "estimated" || previous.source === "unavailable") return true; return (next.inputTokens ?? 0) >= (previous.inputTokens ?? 0) && (next.outputTokens ?? 0) >= (previous.outputTokens ?? 0) && (next.cacheReadTokens ?? 0) >= (previous.cacheReadTokens ?? 0) && (next.cacheWriteTokens ?? 0) >= (previous.cacheWriteTokens ?? 0) && (next.reasoningTokens ?? 0) >= (previous.reasoningTokens ?? 0); }
export function normalizeAgentResponse(stdout: string, kind: AgentKind = "custom"): string | undefined { const clean = stdout.replaceAll(/\u001b\[[0-9;]*m/g, "").replaceAll(/\r\n/g, "\n").trim(); const marker = clean.lastIndexOf("FINAL RESPONSE:"); if (marker < 0 && kind === "custom") return undefined; const selected = marker >= 0 ? clean.slice(marker + "FINAL RESPONSE:".length) : clean.slice(-8_192); const redacted = selected.replaceAll(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").replaceAll(/\b(?:authorization\s*:\s*)?bearer\s+\S+/gi, "Bearer [REDACTED]").replaceAll(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[REDACTED]").replaceAll(/\/(?:Users|home)\/[^\s]+/g, "[LOCAL_PATH]").trim(); return redacted ? redacted.slice(0, 8_192) : undefined; }

export class AgentService {
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly processInstanceId = randomUUID();
  constructor(readonly storage: Workspace, readonly dependencies: AgentDependencies) { this.recoverInterruptedRuns(); }

  summary(): AgentSummary { const config = this.config(); return { configured: config.profiles.length > 0, ...(config.defaultAgentId ? { defaultAgentId: config.defaultAgentId } : {}), profiles: config.profiles }; }
  listRuns(taskId?: string): AgentRun[] { return this.storage.listAgentRuns().filter((run) => !taskId || run.taskId === taskId); }
  usageSummary(scope: TokenUsageSummary["scope"] = { kind: "all" }): TokenUsageSummary { const runs = this.storage.listAgentRuns().filter((run) => scope.kind === "all" || scope.kind === "run" ? scope.kind === "all" || run.id === scope.id : scope.kind === "session" ? run.sessionId === scope.id : scope.kind === "task" ? run.taskId === scope.id : scope.kind === "workspace" ? run.workspaceId === scope.id : scope.kind === "automation" ? run.automationId === scope.id : run.automationRunId === scope.id); let inputTokens = 0; let outputTokens = 0; let cacheReadTokens = 0; let cacheWriteTokens = 0; let reasoningTokens = 0; let measuredTokens = 0; let estimatedTokens = 0; let unavailableRuns = 0; for (const run of runs) { const usage = run.usage; if (!usage || usage.source === "unavailable") { unavailableRuns += 1; continue; } inputTokens += usage.inputTokens ?? 0; outputTokens += usage.outputTokens ?? 0; cacheReadTokens += usage.cacheReadTokens ?? 0; cacheWriteTokens += usage.cacheWriteTokens ?? 0; reasoningTokens += usage.reasoningTokens ?? 0; if (usage.source === "estimated") estimatedTokens += usage.totalTokens ?? 0; else measuredTokens += usage.totalTokens ?? 0; } return { scope, runs: runs.length, runningRuns: runs.filter((run) => run.status === "running").length, completedRuns: runs.filter((run) => run.status !== "running").length, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens: inputTokens + outputTokens, measuredTokens, estimatedTokens, unavailableRuns, updatedAt: utcNow() }; }
  getRun(id: string): AgentRun { return this.storage.getAgentRun(id); }
  harnessPreview(taskId: string, agentId?: string): { snapshot: RuleSnapshot; preflight: ReturnType<HarnessService["preflight"]>; executor: { id: string; evaluations: ReturnType<HarnessService["executorCapabilityEvaluations"]> } } {
    const harness = this.dependencies.harness; if (!harness) throw new ValidationError("Harness engineering is not configured"); const config = this.config(); const selected = agentId ?? config.defaultAgentId; const profile = selected ? config.profiles.find((item) => item.id === selected) : undefined; if (selected && !profile) throw new ValidationError(`agent profile not found: ${selected}`); const executor = this.dependencies.executor ?? new LocalProcessExecutor(); const snapshot = harness.effectiveForTask(taskId); return { snapshot, preflight: harness.preflight(taskId, snapshot), executor: { id: executor.id, evaluations: harness.executorCapabilityEvaluations(snapshot, executor.capabilities()) } };
  }

  openTerminal(id: string, options: { approved: boolean; cwd?: string }): AgentTerminalLaunch {
    if (!options.approved) throw new PolicyDenied("Agent terminal verification requires explicit human approval");
    const profile = this.config().profiles.find((item) => item.id === id); if (!profile) throw new ValidationError(`agent profile not found: ${id}`);
    if (options.cwd !== undefined && !existsSync(options.cwd)) throw new ValidationError(`terminal cwd does not exist: ${options.cwd}`);
    const script = buildAgentTerminalScript(profile, { ...(options.cwd ? { cwd: options.cwd } : {}) });
    return (this.dependencies.terminalLauncher ?? openAgentTerminal)(script);
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

  prepareTask(taskId: string, options: { agentId?: string; instructions?: string; userMessage?: string; historicalContext?: string } = {}): AgentPreparedTask {
    const task = this.dependencies.task(taskId); if (!task.workspaceId) throw new ValidationError("task must be associated with a local Workspace"); const rawWorkspace = this.dependencies.workspace(task.workspaceId);
    if (rawWorkspace.kind !== "local" || !rawWorkspace.rootPath || !existsSync(rawWorkspace.rootPath)) throw new ValidationError("Agent task execution requires a local Workspace");
    const config = this.config(); const agentId = options.agentId ?? config.defaultAgentId; if (!agentId) throw new ValidationError("no default Agent is configured"); const profile = config.profiles.find((item) => item.id === agentId); if (!profile) throw new ValidationError(`agent profile not found: ${agentId}`);
    const instructions = options.instructions?.trim(); const userMessage = options.userMessage?.trim(); const historicalContext = options.historicalContext?.trim(); if (instructions?.includes("\0")) throw new ValidationError("Agent instructions contain unsupported characters"); if (userMessage?.includes("\0")) throw new ValidationError("Agent user message contains unsupported characters"); if (historicalContext?.includes("\0")) throw new ValidationError("Agent historical context contains unsupported characters");
    const snapshot = this.dependencies.harness?.effectiveForTask(task.id); const prompt = this.prompt(task, instructions, snapshot, historicalContext, userMessage); if (prompt.includes("\0")) throw new ValidationError("Agent prompt contains unsupported characters");
    return { task, profile, workspace: { ...rawWorkspace, rootPath: rawWorkspace.rootPath }, prompt, agentProfileDigest: hash({ id: profile.id, kind: profile.kind, command: profile.command, arguments: profile.arguments, promptTransport: profile.promptTransport, timeoutMinutes: profile.timeoutMinutes, environmentKeys: profile.environmentKeys ?? [] }), ...(snapshot ? { ruleSnapshot: snapshot } : {}) };
  }

  startTask(taskId: string, options: StartAgentTaskOptions): AgentRun {
    if (!options.approved) throw new PolicyDenied("Agent task execution requires explicit human approval");
    const prepared = this.prepareTask(taskId, options); const { task, profile, workspace, prompt, ruleSnapshot: snapshot } = prepared; const harness = this.dependencies.harness; const executor = this.dependencies.executor ?? new LocalProcessExecutor();
    if (harness && snapshot?.sources.length) { if (options.approvedRuleDigest !== snapshot.digest) throw new PolicyDenied("Agent approval does not match the current Harness rule snapshot"); harness.assertPreflight(task.id, snapshot); harness.assertExecutorCapabilities(snapshot, executor.capabilities()); }
    if (options.context && options.context.promptDigest !== hash(prompt)) throw new PolicyDenied("Agent approval does not match the current rendered prompt");
    const args = profile.arguments.map((argument) => argument.replaceAll("{prompt}", () => prompt).replaceAll("{taskId}", () => task.id).replaceAll("{changeId}", () => task.changeId)); const instructions = options.instructions?.trim();
    const id = `agent-run-${randomUUID().replaceAll("-", "")}`; const initialUsage: AgentTokenUsage = { source: "estimated", inputTokens: estimatedTokens(prompt), outputTokens: 0, totalTokens: estimatedTokens(prompt), observedAt: utcNow() }; const run: AgentRun = { id, taskId: task.id, changeId: task.changeId, workspaceId: task.workspaceId!, agentId: profile.id, agentName: profile.name, agentKind: profile.kind, status: "running", startedAt: utcNow(), processInstanceId: this.processInstanceId, ...(instructions ? { instructions } : {}), ...(snapshot?.sources.length ? { ruleSnapshotId: snapshot.id, ruleSnapshotDigest: snapshot.digest, complianceStatus: "pending" } : {}), ...(options.context ? options.context : {}), ...(options.automationId ? { automationId: options.automationId } : {}), ...(options.automationRunId ? { automationRunId: options.automationRunId } : {}), usage: initialUsage, usageUpdatedAt: initialUsage.observedAt, stdout: "", stderr: "" }; this.storage.saveAgentRun(run);
    let child: ChildProcessWithoutNullStreams; try { child = executor.start({ command: profile.command, arguments: args, cwd: workspace.rootPath, environment: this.environment(profile), ...(snapshot ? { ruleSnapshot: snapshot } : {}) }); } catch (error) { run.status = "failed"; run.exitCode = -1; run.completedAt = utcNow(); run.stderr = limited(run.stderr, Buffer.from(error instanceof Error ? error.message : String(error))); this.storage.saveAgentRun(run); queueMicrotask(() => { try { options.onCompleted?.(run); } catch { /* completion projection is best-effort; AgentRun remains authoritative */ } }); return run; }
    if (child.pid) run.processId = child.pid; this.storage.saveAgentRun(run); this.children.set(id, child); if (profile.promptTransport === "stdin") child.stdin.end(prompt); else child.stdin.end();
    const collector = usageCollector(run.agentKind); let usageWarningRecorded = false; const updateUsage = () => { try { const measured = collector.collect(`${run.stdout}\n${run.stderr}`); if (measured && monotonicUsage(run.usage, measured)) { run.usage = measured; run.usageUpdatedAt = measured.observedAt; } else if (measured && !usageWarningRecorded) { usageWarningRecorded = true; run.stderr = limited(run.stderr, Buffer.from("\nAgent usage event ignored: Token counters must be monotonic")); } } catch (error) { if (!usageWarningRecorded) { usageWarningRecorded = true; run.stderr = limited(run.stderr, Buffer.from(`\nAgent usage event ignored: ${error instanceof Error ? error.message : String(error)}`)); } } };
    child.stdout.on("data", (chunk: Buffer) => { if (!this.ownsRun(run)) return; run.stdout = limited(run.stdout, chunk); updateUsage(); this.storage.saveAgentRun(run); }); child.stderr.on("data", (chunk: Buffer) => { if (!this.ownsRun(run)) return; run.stderr = limited(run.stderr, chunk); updateUsage(); this.storage.saveAgentRun(run); });
    let timedOut = false; let forceTimer: NodeJS.Timeout | undefined; let finalized = false; const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000); forceTimer.unref(); }, profile.timeoutMinutes * 60_000); timer.unref();
    const finalize = async (status: AgentRun["status"], code: number, error?: string) => { if (finalized) return; finalized = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); if (!this.ownsRun(run)) { this.children.delete(id); return; } run.status = status; run.exitCode = code; run.completedAt = utcNow(); if (error) run.stderr = limited(run.stderr, Buffer.from(error)); updateUsage(); if (!run.usage || run.usage.source === "estimated") { const response = normalizeAgentResponse(run.stdout, run.agentKind) ?? ""; const inputTokens = run.usage?.inputTokens ?? estimatedTokens(prompt); const outputTokens = estimatedTokens(response); run.usage = { source: "estimated", inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, observedAt: utcNow() }; run.usageUpdatedAt = run.usage.observedAt; } this.storage.saveAgentRun(run); this.children.delete(id); if (harness && snapshot?.sources.length) { let report: ComplianceReport; try { report = await harness.verifyRun(id, task.id, snapshot, status === "succeeded" ? "succeeded" : status === "timed_out" ? "timed_out" : "failed"); run.complianceStatus = report.status; run.complianceReportId = report.id; } catch (verificationError) { run.complianceStatus = "failed"; run.stderr = limited(run.stderr, Buffer.from(`\nHarness verification failed: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`)); } this.storage.saveAgentRun(run); } try { options.onCompleted?.(run); } catch (callbackError) { run.stderr = limited(run.stderr, Buffer.from(`\nConversation completion projection failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`)); this.storage.saveAgentRun(run); } };
    child.on("error", (error) => { void finalize(timedOut ? "timed_out" : "failed", -1, error.message); }); child.on("close", (code) => { void finalize(timedOut ? "timed_out" : code === 0 ? "succeeded" : "failed", code ?? -1); }); return run;
  }

  private recoverInterruptedRuns(): void { for (const run of this.storage.listAgentRuns().filter((item) => item.status === "running" && item.processInstanceId !== this.processInstanceId)) { run.status = "failed"; run.exitCode = -1; run.completedAt = utcNow(); run.stderr = limited(run.stderr, Buffer.from("\nAgent execution ownership was lost before this CJHX process started; any orphan process is not trusted as a completed run.")); if (run.complianceStatus === "pending") run.complianceStatus = "failed"; this.storage.saveAgentRun(run); } }
  private ownsRun(run: AgentRun): boolean { try { const stored = this.storage.getAgentRun(run.id); return stored.status === "running" && stored.processInstanceId === this.processInstanceId; } catch { return false; } }
  private prompt(task: Task, instructions?: string, snapshot?: RuleSnapshot, historicalContext?: string, userMessage?: string): string { const skills = this.dependencies.enabledSkills?.() ?? []; const skillContext = skills.length ? `Enabled local CJHX Agent skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}\n  Read and follow: ${skill.path}`).join("\n")}\nUse only the skills relevant to this task.` : ""; const harnessContext = snapshot?.effective.instructions.length ? `Harness engineering rules (${snapshot.digest}):\n${snapshot.effective.instructions.map((item) => `- ${item}`).join("\n")}\nThese instructions are governed separately from runtime controls and postflight checks.` : ""; return [`Implement CJHX task ${task.id} for change ${task.changeId}.`, `Title: ${task.title}`, task.description ? `Description: ${task.description}` : "", task.acceptanceCriteria.length ? `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : "", harnessContext, skillContext, historicalContext ? `Historical context:\n${historicalContext}` : "", instructions ? `Additional instructions:\n${instructions}` : "", userMessage ? `Current user request:\n${userMessage}` : "", "Create or modify files only inside the current repository. You may read only the explicitly listed Skill instruction files outside it. Do not push, publish, deploy, or perform destructive Git operations. Summarize changes and validation when complete."].filter(Boolean).join("\n\n"); }
  private normalize(input: AgentProfileInput): AgentProfileInput { const id = required(input.id, "agent id"); if (!identifier.test(id)) throw new ValidationError("agent id contains unsupported characters"); if (!agentKinds.includes(input.kind)) throw new ValidationError("invalid agent kind"); const command = required(input.command, "agent command"); if (command.includes("\0") || command.includes("\n")) throw new ValidationError("agent command contains unsupported characters"); const arguments_ = validStrings(input.arguments, "agent arguments"); const versionArguments = input.versionArguments === undefined ? undefined : validStrings(input.versionArguments, "version arguments"); if (input.promptTransport !== "argument" && input.promptTransport !== "stdin") throw new ValidationError("invalid prompt transport"); if (input.promptTransport === "argument" && !arguments_.some((item) => item.includes("{prompt}"))) throw new ValidationError("argument prompt transport requires a {prompt} placeholder"); if (!Number.isInteger(input.timeoutMinutes) || input.timeoutMinutes < 1 || input.timeoutMinutes > 120) throw new ValidationError("Agent timeout must be between 1 and 120 minutes"); const environmentKeys = validStrings(input.environmentKeys, "environment keys"); if (!environmentKeys.every((item) => environmentKey.test(item))) throw new ValidationError("environment key contains unsupported characters"); return { id, name: required(input.name, "agent name"), kind: input.kind, command, arguments: arguments_, ...(versionArguments ? { versionArguments } : {}), promptTransport: input.promptTransport, timeoutMinutes: input.timeoutMinutes, environmentKeys: [...new Set(environmentKeys)] }; }
  private environment(profile: AgentProfileInput): NodeJS.ProcessEnv { const keys = new Set(["PATH", "HOME", "LANG", "TMPDIR", ...(profile.environmentKeys ?? [])]); return Object.fromEntries([...keys].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv; }
  private config(): AgentConfig { this.storage.initialize(); if (!this.storage.agentConfigExists()) return { schemaVersion: 1, profiles: [] }; const value = this.storage.getAgentConfig() as unknown as AgentConfig; return { schemaVersion: 1, ...(value.defaultAgentId ? { defaultAgentId: value.defaultAgentId } : {}), profiles: Array.isArray(value.profiles) ? value.profiles : [] }; }
  private applyDefault(config: AgentConfig): void { config.profiles = config.profiles.map((item) => ({ ...item, default: item.id === config.defaultAgentId })); }
  private saveConfig(config: AgentConfig): void { this.storage.saveAgentConfig(config as unknown as JsonValue); }
}
