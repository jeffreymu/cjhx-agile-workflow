import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { PolicyDenied, ValidationError } from "./errors.js";
import { isRecord, utcNow } from "./models.js";
import { fingerprintRepositoryState } from "./repository-state.js";
import type { Workspace } from "./storage.js";
import { taskStatuses, type Task, type TaskStatus } from "./tasks.js";

export type HarnessScope = "enterprise" | "workspace" | "change" | "task";
export type HarnessMode = "enforce" | "audit";
export type HarnessCheckId = "npm.typecheck" | "npm.test" | "npm.check";
export type HarnessGateTarget = `task.${TaskStatus}`;
export type NetworkMode = "none" | "allowlist" | "unrestricted";

export interface HarnessCapabilities {
  network?: { mode: NetworkMode; allowedHosts?: string[] };
  git?: Partial<{ commit: boolean; push: boolean; forcePush: boolean; destructiveOperations: boolean; createBranch: boolean }>;
  filesystem?: { writeRoots?: string[]; deniedPaths?: string[] };
  tools?: { allowed?: string[]; denied?: string[] };
}
export interface HarnessGate { target: HarnessGateTarget; requires: string[]; ruleId?: string }
export interface HarnessRule {
  id: string;
  description: string;
  enabled?: boolean;
  instruction?: string;
  preconditions?: ("task.has-acceptance-criteria" | "workspace.is-local")[];
  capabilities?: HarnessCapabilities;
  requiredChecks?: HarnessCheckId[];
  gates?: HarnessGate[];
}
export interface HarnessRuleBundle { schemaVersion: 1; id: string; version: string; scope: HarnessScope; mode: HarnessMode; rules: HarnessRule[] }
export interface HarnessRuleSource { id: string; load(context: HarnessContext): HarnessRuleBundle[] }
export interface HarnessContext { workspaceId: string; workspaceRoot: string; changeId: string; taskId: string }
export interface HarnessExecutionTarget { kind: "workspace" | "worktree"; rootPath: string; worktreeLeaseId?: string; baseCommit?: string }
export interface EffectiveHarnessRules {
  mode: HarnessMode;
  instructions: string[];
  preconditions: HarnessRule["preconditions"] extends (infer T)[] | undefined ? T[] : never[];
  requiredChecks: HarnessCheckId[];
  gates: HarnessGate[];
  capabilities: {
    network: { mode: NetworkMode; allowedHosts: string[] };
    git: { commit: boolean; push: boolean; forcePush: boolean; destructiveOperations: boolean; createBranch: boolean };
    filesystem: { writeRoots: string[] | null; deniedPaths: string[] };
    tools: { allowed: string[] | null; denied: string[] };
  };
}
export interface RuleSnapshot {
  id: string;
  digest: string;
  compiledAt: string;
  context: Omit<HarnessContext, "workspaceRoot"> & { executionTarget?: { kind: "workspace" | "worktree"; worktreeLeaseId?: string; baseCommit?: string } };
  sources: { id: string; version: string; scope: HarnessScope; mode: HarnessMode; digest: string }[];
  effective: EffectiveHarnessRules;
}
export interface HarnessEvaluation { id: string; status: "passed" | "failed" | "warning"; message: string }
export interface HarnessCheckResult { checkId: HarnessCheckId; status: "passed" | "failed"; startedAt: string; completedAt: string; exitCode: number; stdout: string; stderr: string }
export interface ComplianceReport { id: string; runId: string; taskId: string; changeId: string; workspaceId: string; ruleSnapshotId: string; ruleSnapshotDigest: string; repositoryStateDigest: string; executionTargetKind?: "workspace" | "worktree"; worktreeLeaseId?: string; baseCommit?: string; agentRunStatus: "succeeded" | "failed" | "timed_out"; status: "passed" | "failed"; checks: HarnessCheckResult[]; createdAt: string }
interface HarnessWorkspace { id: string; kind: "local" | "virtual"; rootPath?: string }
interface HarnessDependencies { task(id: string): Task; workspace(id: string): HarnessWorkspace }

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const checks = new Set<HarnessCheckId>(["npm.typecheck", "npm.test", "npm.check"]);
const preconditions = new Set(["task.has-acceptance-criteria", "workspace.is-local"]);
const networkRank: Record<NetworkMode, number> = { none: 0, allowlist: 1, unrestricted: 2 };
const outputLimit = 262_144;

function required(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${name} is required`); if (value.includes("\0")) throw new ValidationError(`${name} contains unsupported characters`); return value.trim(); }
function strings(value: unknown, name: string): string[] { if (value === undefined) return []; if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new ValidationError(`${name} must be an array of strings`); if (value.some((item) => item.includes("\0"))) throw new ValidationError(`${name} contains unsupported characters`); const normalized = value.map((item) => item.trim()).filter(Boolean); if (new Set(normalized).size !== normalized.length) throw new ValidationError(`${name} must not contain duplicates`); return normalized; }
function knownKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new ValidationError(`${name} contains unknown fields: ${unknown.sort().join(", ")}`); }
function hash(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function intersection(left: string[], right: string[]): string[] { const values = new Set(right); return left.filter((item) => values.has(item)); }
function parseCapabilities(value: unknown): HarnessCapabilities | undefined {
  if (value === undefined) return undefined; if (!isRecord(value)) throw new ValidationError("Harness capabilities must be an object"); knownKeys(value, ["network", "git", "filesystem", "tools"], "Harness capabilities"); const result: HarnessCapabilities = {};
  if (value.network !== undefined) { if (!isRecord(value.network) || !["none", "allowlist", "unrestricted"].includes(String(value.network.mode))) throw new ValidationError("invalid Harness network mode"); knownKeys(value.network, ["mode", "allowedHosts"], "Harness network capability"); const allowedHosts = strings(value.network.allowedHosts, "allowedHosts"); if (value.network.mode === "allowlist" && !allowedHosts.length) throw new ValidationError("Harness network allowlist requires allowedHosts"); if (value.network.mode !== "allowlist" && allowedHosts.length) throw new ValidationError("allowedHosts is only valid for Harness network allowlist"); result.network = { mode: value.network.mode as NetworkMode, allowedHosts }; }
  if (value.git !== undefined) { if (!isRecord(value.git)) throw new ValidationError("Harness git capabilities must be an object"); const keys = ["commit", "push", "forcePush", "destructiveOperations", "createBranch"] as const; knownKeys(value.git, keys, "Harness git capability"); const git: NonNullable<HarnessCapabilities["git"]> = {}; for (const key of keys) if (value.git[key] !== undefined) { if (typeof value.git[key] !== "boolean") throw new ValidationError(`Harness git.${key} must be boolean`); git[key] = value.git[key]; } result.git = git; }
  if (value.filesystem !== undefined) { if (!isRecord(value.filesystem)) throw new ValidationError("Harness filesystem capabilities must be an object"); knownKeys(value.filesystem, ["writeRoots", "deniedPaths"], "Harness filesystem capability"); result.filesystem = { ...(value.filesystem.writeRoots !== undefined ? { writeRoots: strings(value.filesystem.writeRoots, "writeRoots") } : {}), ...(value.filesystem.deniedPaths !== undefined ? { deniedPaths: strings(value.filesystem.deniedPaths, "deniedPaths") } : {}) }; }
  if (value.tools !== undefined) { if (!isRecord(value.tools)) throw new ValidationError("Harness tool capabilities must be an object"); knownKeys(value.tools, ["allowed", "denied"], "Harness tool capability"); result.tools = { ...(value.tools.allowed !== undefined ? { allowed: strings(value.tools.allowed, "allowed tools") } : {}), ...(value.tools.denied !== undefined ? { denied: strings(value.tools.denied, "denied tools") } : {}) }; }
  return result;
}

export function parseHarnessRuleBundle(value: unknown): HarnessRuleBundle {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new ValidationError("Harness rule bundle requires schemaVersion 1"); knownKeys(value, ["$schema", "schemaVersion", "id", "version", "scope", "mode", "rules"], "Harness rule bundle"); const id = required(value.id, "Harness bundle id"); const version = required(value.version, "Harness bundle version");
  if (!identifier.test(id) || !identifier.test(version)) throw new ValidationError("Harness bundle id or version contains unsupported characters"); if (!["enterprise", "workspace", "change", "task"].includes(String(value.scope))) throw new ValidationError("invalid Harness scope"); if (value.mode !== "enforce" && value.mode !== "audit") throw new ValidationError("invalid Harness mode"); if (!Array.isArray(value.rules)) throw new ValidationError("Harness rules must be an array");
  const rules = value.rules.map((raw): HarnessRule => { if (!isRecord(raw)) throw new ValidationError("Harness rule must be an object"); knownKeys(raw, ["id", "description", "enabled", "instruction", "preconditions", "capabilities", "requiredChecks", "gates"], "Harness rule"); const ruleId = required(raw.id, "Harness rule id"); if (!identifier.test(ruleId)) throw new ValidationError("Harness rule id contains unsupported characters"); if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new ValidationError("Harness rule enabled must be boolean"); if (raw.instruction !== undefined && (typeof raw.instruction !== "string" || raw.instruction.includes("\0"))) throw new ValidationError("Harness rule instruction must be a string without unsupported characters"); const rawPreconditions = strings(raw.preconditions, "Harness preconditions"); if (!rawPreconditions.every((item) => preconditions.has(item))) throw new ValidationError("unknown Harness precondition"); const requiredChecks = strings(raw.requiredChecks, "Harness required checks"); if (!requiredChecks.every((item) => checks.has(item as HarnessCheckId))) throw new ValidationError("unknown Harness check"); const gates = raw.gates === undefined ? [] : Array.isArray(raw.gates) ? raw.gates.map((gate): HarnessGate => { if (!isRecord(gate)) throw new ValidationError("invalid Harness gate"); knownKeys(gate, ["target", "requires"], "Harness gate"); if (typeof gate.target !== "string" || !gate.target.startsWith("task.") || !taskStatuses.includes(gate.target.slice(5) as TaskStatus)) throw new ValidationError("invalid Harness gate"); const requirements = strings(gate.requires, "Harness gate requirements"); if (!requirements.length) throw new ValidationError("Harness gate requires at least one requirement"); if (!requirements.every((item) => item.startsWith("check:") && checks.has(item.slice(6) as HarnessCheckId))) throw new ValidationError("unknown Harness gate requirement"); return { target: gate.target as HarnessGateTarget, requires: requirements }; }) : (() => { throw new ValidationError("Harness gates must be an array"); })(); const capabilities = parseCapabilities(raw.capabilities); return { id: ruleId, description: required(raw.description, "Harness rule description"), enabled: raw.enabled !== false, ...(typeof raw.instruction === "string" && raw.instruction.trim() ? { instruction: raw.instruction.trim() } : {}), preconditions: rawPreconditions as NonNullable<HarnessRule["preconditions"]>, requiredChecks: requiredChecks as HarnessCheckId[], gates, ...(capabilities ? { capabilities } : {}) }; });
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new ValidationError("Harness rule ids must be unique within a bundle"); return { schemaVersion: 1, id, version, scope: value.scope as HarnessScope, mode: value.mode, rules };
}

function defaults(): EffectiveHarnessRules { return { mode: "audit", instructions: [], preconditions: [], requiredChecks: [], gates: [], capabilities: { network: { mode: "unrestricted", allowedHosts: [] }, git: { commit: true, push: true, forcePush: true, destructiveOperations: true, createBranch: true }, filesystem: { writeRoots: null, deniedPaths: [] }, tools: { allowed: null, denied: [] } } }; }

export class HarnessService {
  constructor(readonly storage: Workspace, private readonly dependencies: HarnessDependencies, private readonly sources: HarnessRuleSource[] = []) {}

  validate(value: unknown): HarnessRuleBundle { return parseHarnessRuleBundle(value); }

  effectiveForTask(taskId: string, target?: HarnessExecutionTarget): RuleSnapshot {
    const task = this.dependencies.task(taskId); if (!task.workspaceId) throw new ValidationError("Harness requires a Task Workspace"); const workspace = this.dependencies.workspace(task.workspaceId); if (workspace.kind !== "local" || !workspace.rootPath) throw new ValidationError("Harness engineering requires a local Workspace"); const workspaceRoot = realpathSync(workspace.rootPath); const root = target ? this.executionRoot(target, workspaceRoot) : workspaceRoot; const context: HarnessContext = { workspaceId: task.workspaceId, workspaceRoot: root, changeId: task.changeId, taskId: task.id };
    const bundles: HarnessRuleBundle[] = []; for (const source of this.sources) bundles.push(...source.load(context).map(parseHarnessRuleBundle)); const projectFile = resolve(root, "cjhx.harness.json"); if (existsSync(projectFile)) { if (lstatSync(projectFile).isSymbolicLink()) throw new ValidationError("cjhx.harness.json cannot be a symbolic link"); const content = readFileSync(projectFile); if (content.length > 1_048_576) throw new ValidationError("cjhx.harness.json exceeds 1 MB"); let value: unknown; try { value = JSON.parse(content.toString("utf8")) as unknown; } catch { throw new ValidationError("cjhx.harness.json must contain valid JSON"); } const projectBundle = parseHarnessRuleBundle(value); if (projectBundle.scope !== "workspace") throw new ValidationError("project cjhx.harness.json must use workspace scope"); bundles.push(projectBundle); }
    const effective = this.compile(bundles); const sourceRecords = bundles.map((bundle) => ({ id: bundle.id, version: bundle.version, scope: bundle.scope, mode: bundle.mode, digest: hash(bundle) })); const executionTarget = target ? { kind: target.kind, ...(target.worktreeLeaseId ? { worktreeLeaseId: target.worktreeLeaseId } : {}), ...(target.baseCommit ? { baseCommit: target.baseCommit } : {}) } : { kind: "workspace" as const }; const snapshotContext = { workspaceId: context.workspaceId, changeId: context.changeId, taskId: context.taskId, executionTarget }; const digest = hash({ context: snapshotContext, sources: sourceRecords, effective }); const snapshot: RuleSnapshot = { id: `rule-snapshot-${randomUUID().replaceAll("-", "")}`, digest, compiledAt: utcNow(), context: snapshotContext, sources: sourceRecords, effective }; this.storage.saveRuleSnapshot(snapshot); return snapshot;
  }

  preflight(taskId: string, snapshot: RuleSnapshot): HarnessEvaluation[] {
    const task = this.dependencies.task(taskId); const workspace = this.dependencies.workspace(snapshot.context.workspaceId); return snapshot.effective.preconditions.map((condition) => condition === "task.has-acceptance-criteria" ? { id: condition, status: task.acceptanceCriteria.length ? "passed" : "failed", message: task.acceptanceCriteria.length ? "Task has acceptance criteria" : "Task requires acceptance criteria" } : { id: condition, status: workspace.kind === "local" ? "passed" : "failed", message: workspace.kind === "local" ? "Workspace is local" : "Workspace must be local" });
  }

  assertPreflight(taskId: string, snapshot: RuleSnapshot): HarnessEvaluation[] { const results = this.preflight(taskId, snapshot); const failed = results.filter((item) => item.status === "failed"); if (snapshot.effective.mode === "enforce" && failed.length) throw new PolicyDenied(`Harness preflight failed: ${failed.map((item) => item.message).join(", ")}`); return results; }

  executorCapabilityEvaluations(snapshot: RuleSnapshot, supported: Set<string>): HarnessEvaluation[] { const required: string[] = []; if (snapshot.effective.capabilities.network.mode !== "unrestricted") required.push(`network.${snapshot.effective.capabilities.network.mode}`); if (snapshot.effective.capabilities.filesystem.writeRoots !== null || snapshot.effective.capabilities.filesystem.deniedPaths.length) required.push("filesystem.restricted"); if (Object.values(snapshot.effective.capabilities.git).some((allowed) => !allowed)) required.push("git.restricted"); if (snapshot.effective.capabilities.tools.allowed !== null || snapshot.effective.capabilities.tools.denied.length) required.push("tools.restricted"); return required.map((capability) => ({ id: capability, status: supported.has(capability) ? "passed" : snapshot.effective.mode === "enforce" ? "failed" : "warning", message: supported.has(capability) ? `Executor enforces ${capability}` : `Executor cannot enforce ${capability}` })); }

  assertExecutorCapabilities(snapshot: RuleSnapshot, supported: Set<string>): void { const unsupported = this.executorCapabilityEvaluations(snapshot, supported).filter((item) => item.status === "failed"); if (unsupported.length) throw new PolicyDenied(`Agent executor cannot enforce required capability: ${unsupported.map((item) => item.id).join(", ")}`); }

  async verifyRun(runId: string, taskId: string, snapshot: RuleSnapshot, agentRunStatus: "succeeded" | "failed" | "timed_out", target?: HarnessExecutionTarget): Promise<ComplianceReport> {
    const task = this.dependencies.task(taskId); const workspace = this.dependencies.workspace(snapshot.context.workspaceId); if (!workspace.rootPath) throw new ValidationError("Harness checks require a local Workspace"); const workspaceRoot = realpathSync(workspace.rootPath); const root = target ? this.executionRoot(target, workspaceRoot) : workspaceRoot; const expected = snapshot.context.executionTarget?.kind ?? "workspace"; if (expected !== (target?.kind ?? "workspace") || snapshot.context.executionTarget?.worktreeLeaseId !== target?.worktreeLeaseId || snapshot.context.executionTarget?.baseCommit !== target?.baseCommit) throw new PolicyDenied("Harness execution target does not match the approved rule snapshot"); const results: HarnessCheckResult[] = []; if (agentRunStatus === "succeeded") for (const check of snapshot.effective.requiredChecks) results.push(await this.runCheck(check, root)); const report: ComplianceReport = { id: `compliance-report-${randomUUID().replaceAll("-", "")}`, runId, taskId, changeId: task.changeId, workspaceId: snapshot.context.workspaceId, ruleSnapshotId: snapshot.id, ruleSnapshotDigest: snapshot.digest, repositoryStateDigest: this.repositoryStateDigest(root), executionTargetKind: target?.kind ?? "workspace", ...(target?.worktreeLeaseId ? { worktreeLeaseId: target.worktreeLeaseId } : {}), ...(target?.baseCommit ? { baseCommit: target.baseCommit } : {}), agentRunStatus, status: agentRunStatus === "succeeded" && results.every((item) => item.status === "passed") ? "passed" : "failed", checks: results, createdAt: utcNow() }; this.storage.saveComplianceReport(report); return report;
  }

  assertTaskGate(taskId: string, target: TaskStatus): void { const task = this.dependencies.task(taskId); if (!task.workspaceId) return; const workspace = this.dependencies.workspace(task.workspaceId); if (workspace.kind !== "local" || !workspace.rootPath) return; const snapshot = this.effectiveForTask(taskId); const gates = snapshot.effective.gates.filter((item) => item.target === `task.${target}`); if (!gates.length || snapshot.effective.mode !== "enforce") return; const latest = this.listReports(taskId).filter((report) => report.status === "passed" && (report.executionTargetKind === undefined || report.executionTargetKind === "workspace") && report.ruleSnapshotDigest === snapshot.digest).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; const missing = gates.flatMap((gate) => gate.requires.filter((requirement) => !latest?.checks.some((check) => `check:${check.checkId}` === requirement && check.status === "passed"))); if (missing.length) throw new PolicyDenied(`Harness gate for task.${target} is missing: ${[...new Set(missing)].join(", ")}`); if (latest && latest.repositoryStateDigest !== this.repositoryStateDigest(workspace.rootPath)) throw new PolicyDenied(`Harness gate for task.${target} requires a new postflight check because the repository state changed`); }

  listReports(taskId?: string): ComplianceReport[] { return this.storage.listComplianceReports<ComplianceReport>().filter((item) => !taskId || item.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  getReport(id: string): ComplianceReport { return this.storage.getComplianceReport<ComplianceReport>(id); }
  listSnapshots(): RuleSnapshot[] { return this.storage.listRuleSnapshots<RuleSnapshot>().sort((a, b) => b.compiledAt.localeCompare(a.compiledAt)); }
  private compile(bundles: HarnessRuleBundle[]): EffectiveHarnessRules { const effective = defaults(); const active = bundles.flatMap((bundle) => bundle.rules.filter((rule) => rule.enabled !== false).map((rule) => ({ bundle, rule }))); const modes = new Set(active.map(({ bundle }) => bundle.mode)); if (modes.size > 1) throw new ValidationError("Harness audit and enforce bundles cannot be mixed in one effective snapshot"); const ruleIds = active.map(({ rule }) => rule.id); if (new Set(ruleIds).size !== ruleIds.length) throw new ValidationError("Harness rule ids must be unique across effective bundles"); effective.mode = modes.has("enforce") ? "enforce" : "audit"; for (const { rule } of active) { if (rule.instruction) effective.instructions.push(rule.instruction); effective.preconditions.push(...(rule.preconditions ?? [])); effective.requiredChecks.push(...(rule.requiredChecks ?? [])); effective.gates.push(...(rule.gates ?? []).map((gate) => ({ ...gate, ruleId: rule.id }))); effective.requiredChecks.push(...(rule.gates ?? []).flatMap((gate) => gate.requires.map((item) => item.slice(6) as HarnessCheckId))); const capabilities = rule.capabilities; if (!capabilities) continue; if (capabilities.network && networkRank[capabilities.network.mode] < networkRank[effective.capabilities.network.mode]) effective.capabilities.network = { mode: capabilities.network.mode, allowedHosts: capabilities.network.allowedHosts ?? [] }; else if (capabilities.network?.mode === "allowlist" && effective.capabilities.network.mode === "allowlist") effective.capabilities.network.allowedHosts = intersection(effective.capabilities.network.allowedHosts, capabilities.network.allowedHosts ?? []); for (const key of Object.keys(effective.capabilities.git) as (keyof EffectiveHarnessRules["capabilities"]["git"])[]) if (capabilities.git?.[key] === false) effective.capabilities.git[key] = false; if (capabilities.filesystem?.writeRoots !== undefined) effective.capabilities.filesystem.writeRoots = effective.capabilities.filesystem.writeRoots === null ? [...capabilities.filesystem.writeRoots] : intersection(effective.capabilities.filesystem.writeRoots, capabilities.filesystem.writeRoots); effective.capabilities.filesystem.deniedPaths.push(...(capabilities.filesystem?.deniedPaths ?? [])); if (capabilities.tools?.allowed !== undefined) effective.capabilities.tools.allowed = effective.capabilities.tools.allowed === null ? [...capabilities.tools.allowed] : intersection(effective.capabilities.tools.allowed, capabilities.tools.allowed); effective.capabilities.tools.denied.push(...(capabilities.tools?.denied ?? [])); }
    effective.instructions = [...new Set(effective.instructions)]; effective.preconditions = [...new Set(effective.preconditions)]; effective.requiredChecks = [...new Set(effective.requiredChecks)]; effective.capabilities.filesystem.deniedPaths = [...new Set(effective.capabilities.filesystem.deniedPaths)]; effective.capabilities.tools.denied = [...new Set(effective.capabilities.tools.denied)]; return effective; }

  private executionRoot(target: HarnessExecutionTarget, workspaceRoot: string): string { if (target.kind !== "workspace" && target.kind !== "worktree") throw new ValidationError("invalid Harness execution target"); if (target.kind === "worktree" && !target.worktreeLeaseId) throw new ValidationError("worktree Harness target requires a lease id"); if (!existsSync(target.rootPath)) throw new ValidationError("Harness execution target does not exist"); const root = realpathSync(target.rootPath); if (target.kind === "workspace" && root !== workspaceRoot) throw new PolicyDenied("workspace Harness target must use the registered Workspace root"); return root; }
  private repositoryStateDigest(cwd: string): string { return fingerprintRepositoryState(cwd, this.storage.root); }

  private async runCheck(checkId: HarnessCheckId, cwd: string): Promise<HarnessCheckResult> { const startedAt = utcNow(); const script = checkId === "npm.typecheck" ? "typecheck" : checkId === "npm.test" ? "test" : "check"; const command = process.platform === "win32" ? "npm.cmd" : "npm"; return await new Promise((accept) => { execFile(command, ["run", script], { cwd, timeout: 120_000, maxBuffer: outputLimit, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "C.UTF-8", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) } }, (error, stdout, stderr) => { const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code === "number" ? (error as unknown as { code: number }).code : error ? 1 : 0; accept({ checkId, status: error ? "failed" : "passed", startedAt, completedAt: utcNow(), exitCode, stdout: stdout.slice(-outputLimit), stderr: `${stderr}${error && !stderr ? error.message : ""}`.slice(-outputLimit) }); }); }); }
}
