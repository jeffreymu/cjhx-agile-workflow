import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";
import type { AgentRun } from "./agents.js";
import type { AutomationClaim, AutomationDefinition, AutomationFinding, AutomationReport, AutomationRun, AutomationSignalSnapshot } from "./automations.js";
import type { AgentSession, AgentTurn, ExecutionContextSnapshot } from "./conversations.js";
import type { MemoryRecord, MemorySnapshot } from "./memory.js";
import type { Change, JsonValue, SkillRun } from "./models.js";
import type { Goal, GoalSnapshot } from "./goals.js";
import type { Task } from "./tasks.js";

export interface SkillLockRecord { version: string; digest: string; path: string; source: string }
export interface SkillLock { schemaVersion: 1; skills: Record<string, SkillLockRecord> }

export class Workspace {
  readonly root: string;
  readonly changes: string;
  readonly skills: string;
  readonly runs: string;
  readonly tasks: string;
  readonly workspaces: string;
  readonly integrations: string;
  readonly agents: string;
  readonly agentRuns: string;
  readonly agentConfig: string;
  readonly localSkillConfig: string;
  readonly harness: string;
  readonly ruleSnapshots: string;
  readonly complianceReports: string;
  readonly memory: string;
  readonly agentSessions: string;
  readonly agentTurns: string;
  readonly memoryRecords: string;
  readonly memorySnapshots: string;
  readonly executionContexts: string;
  readonly goals: string;
  readonly goalRecords: string;
  readonly goalSnapshots: string;
  readonly automations: string;
  readonly automationDefinitions: string;
  readonly automationDefinitionSnapshots: string;
  readonly automationClaims: string;
  readonly automationSignalSnapshots: string;
  readonly automationRuns: string;
  readonly automationFindings: string;
  readonly automationReports: string;
  readonly lockfile: string;

  constructor(root = ".cjhx") {
    this.root = resolve(root);
    this.changes = resolve(this.root, "changes");
    this.skills = resolve(this.root, "skills");
    this.runs = resolve(this.root, "runs");
    this.tasks = resolve(this.root, "tasks");
    this.workspaces = resolve(this.root, "workspaces");
    this.integrations = resolve(this.root, "integrations");
    this.agents = resolve(this.root, "agents");
    this.agentRuns = resolve(this.root, "agent-runs");
    this.agentConfig = resolve(this.agents, "config.json");
    this.localSkillConfig = resolve(this.root, "local-skills.json");
    this.harness = resolve(this.root, "harness");
    this.ruleSnapshots = resolve(this.harness, "snapshots");
    this.complianceReports = resolve(this.harness, "reports");
    this.memory = resolve(this.root, "memory");
    this.agentSessions = resolve(this.memory, "sessions");
    this.agentTurns = resolve(this.memory, "turns");
    this.memoryRecords = resolve(this.memory, "records");
    this.memorySnapshots = resolve(this.memory, "snapshots");
    this.executionContexts = resolve(this.memory, "execution-contexts");
    this.goals = resolve(this.root, "goals");
    this.goalRecords = resolve(this.goals, "records");
    this.goalSnapshots = resolve(this.goals, "snapshots");
    this.automations = resolve(this.root, "automations");
    this.automationDefinitions = resolve(this.automations, "definitions");
    this.automationDefinitionSnapshots = resolve(this.automations, "definition-snapshots");
    this.automationClaims = resolve(this.automations, "claims");
    this.automationSignalSnapshots = resolve(this.automations, "signal-snapshots");
    this.automationRuns = resolve(this.automations, "runs");
    this.automationFindings = resolve(this.automations, "findings");
    this.automationReports = resolve(this.automations, "reports");
    this.lockfile = resolve(this.root, "skills-lock.json");
  }

  initialize(): void {
    [this.root, this.changes, this.skills, this.runs, this.tasks, this.workspaces, this.integrations, this.agents, this.agentRuns, this.harness, this.ruleSnapshots, this.complianceReports].forEach((path) => mkdirSync(path, { recursive: true }));
    [this.memory, this.agentSessions, this.agentTurns, this.memoryRecords, this.memorySnapshots, this.executionContexts, this.goals, this.goalRecords, this.goalSnapshots, this.automations, this.automationDefinitions, this.automationDefinitionSnapshots, this.automationClaims, this.automationSignalSnapshots, this.automationRuns, this.automationFindings, this.automationReports].forEach((path) => this.ensurePrivateDirectory(path));
    if (!existsSync(this.lockfile)) this.writeJson(this.lockfile, { schemaVersion: 1, skills: {} });
  }

  writeJson(path: string, value: JsonValue): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  }

  writePrivateJson(path: string, value: JsonValue): void {
    mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, path); chmodSync(path, 0o600);
  }

  readJson<T extends JsonValue>(path: string): T {
    try { return JSON.parse(readFileSync(path, "utf8")) as T; }
    catch (error) { throw new ValidationError(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  saveChange(change: Change): void { this.initialize(); this.writeJson(this.changePath(change.id), change as unknown as JsonValue); }
  getChange(id: string): Change { return this.readJson(this.changePath(id)) as unknown as Change; }
  listChanges(): Change[] { this.initialize(); return this.jsonFiles(this.changes).map((path) => this.readJson(path) as unknown as Change).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  changeExists(id: string): boolean { return existsSync(this.changePath(id)); }
  saveRun(run: SkillRun | { id: string }): void { this.initialize(); this.writeJson(resolve(this.runs, `${run.id}.json`), run as unknown as JsonValue); }
  getRun(id: string): JsonValue { return this.readJson(this.entityPath(this.runs, id, "run id")); }
  listRuns(): JsonValue[] { this.initialize(); return this.jsonFiles(this.runs).map((path) => this.readJson(path)).sort((a, b) => this.runTime(b).localeCompare(this.runTime(a))); }
  saveTask(task: Task): void { this.initialize(); this.writeJson(this.entityPath(this.tasks, task.id, "task id"), task as unknown as JsonValue); }
  getTask(id: string): Task { return this.readJson(this.entityPath(this.tasks, id, "task id")) as unknown as Task; }
  listTasks(): Task[] { this.initialize(); return this.jsonFiles(this.tasks).map((path) => this.readJson(path) as unknown as Task).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  getLock(): SkillLock { this.initialize(); return this.readJson(this.lockfile) as unknown as SkillLock; }
  saveLock(lock: SkillLock): void { this.writeJson(this.lockfile, lock as unknown as JsonValue); }
  integrationExists(id: string): boolean { return existsSync(this.integrationPath(id)); }
  getIntegrationConfig(id: string): JsonValue { return this.readJson(this.integrationPath(id)); }
  saveIntegrationConfig(id: string, value: JsonValue): void { this.initialize(); this.writePrivateJson(this.integrationPath(id), value); }
  removeIntegrationConfig(id: string): void { rmSync(this.integrationPath(id), { force: true }); }
  agentConfigExists(): boolean { return existsSync(this.agentConfig); }
  getAgentConfig(): JsonValue { return this.readJson(this.agentConfig); }
  saveAgentConfig(value: JsonValue): void { this.initialize(); this.writePrivateJson(this.agentConfig, value); }
  localSkillConfigExists(): boolean { return existsSync(this.localSkillConfig); }
  getLocalSkillConfig(): JsonValue { return this.readJson(this.localSkillConfig); }
  saveLocalSkillConfig(value: JsonValue): void { this.initialize(); this.writePrivateJson(this.localSkillConfig, value); }
  saveAgentRun(run: AgentRun): void { this.initialize(); this.writePrivateJson(this.entityPath(this.agentRuns, run.id, "agent run id"), run as unknown as JsonValue); }
  getAgentRun(id: string): AgentRun { return this.readJson(this.entityPath(this.agentRuns, id, "agent run id")) as unknown as AgentRun; }
  listAgentRuns(): AgentRun[] { this.initialize(); return this.jsonFiles(this.agentRuns).map((path) => this.readJson(path) as unknown as AgentRun).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  saveRuleSnapshot(value: { id: string }): void { this.initialize(); this.writePrivateJson(this.entityPath(this.ruleSnapshots, value.id, "rule snapshot id"), value as unknown as JsonValue); }
  listRuleSnapshots<T>(): T[] { this.initialize(); return this.jsonFiles(this.ruleSnapshots).map((path) => this.readJson(path) as unknown as T); }
  saveComplianceReport(value: { id: string }): void { this.initialize(); this.writePrivateJson(this.entityPath(this.complianceReports, value.id, "compliance report id"), value as unknown as JsonValue); }
  getComplianceReport<T>(id: string): T { return this.readJson(this.entityPath(this.complianceReports, id, "compliance report id")) as unknown as T; }
  listComplianceReports<T>(): T[] { this.initialize(); return this.jsonFiles(this.complianceReports).map((path) => this.readJson(path) as unknown as T); }
  saveAgentSession(value: AgentSession): void { this.initialize(); this.writePrivateJson(this.entityPath(this.agentSessions, value.id, "agent session id"), value as unknown as JsonValue); }
  getAgentSession(id: string): AgentSession { return this.readPrivateJson(this.entityPath(this.agentSessions, id, "agent session id")) as unknown as AgentSession; }
  listAgentSessions(): AgentSession[] { this.initialize(); return this.jsonFiles(this.agentSessions).map((path) => this.readPrivateJson(path) as unknown as AgentSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  createAgentTurn(value: AgentTurn): void { this.initialize(); const directory = this.turnDirectory(value.sessionId); this.ensurePrivateDirectory(directory); const path = resolve(directory, `${String(value.sequence).padStart(6, "0")}.json`); const temporary = `${path}.${randomUUID()}.tmp`; try { writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); linkSync(temporary, path); chmodSync(path, 0o600); } catch (error) { if (existsSync(path)) throw new ValidationError("conversation Turn sequence is already in use"); throw error; } finally { rmSync(temporary, { force: true }); } }
  saveAgentTurn(value: AgentTurn): void { this.initialize(); const directory = this.turnDirectory(value.sessionId); this.ensurePrivateDirectory(directory); this.writePrivateJson(resolve(directory, `${String(value.sequence).padStart(6, "0")}.json`), value as unknown as JsonValue); }
  removeAgentTurn(sessionId: string, sequence: number): void { rmSync(resolve(this.turnDirectory(sessionId), `${String(sequence).padStart(6, "0")}.json`), { force: true }); }
  listAgentTurns(sessionId: string): AgentTurn[] { this.initialize(); const directory = this.turnDirectory(sessionId); if (!existsSync(directory)) return []; return this.jsonFiles(directory).map((path) => this.readPrivateJson(path) as unknown as AgentTurn).sort((a, b) => a.sequence - b.sequence); }
  saveMemoryRecord(value: MemoryRecord): void { this.initialize(); this.writePrivateJson(this.entityPath(this.memoryRecords, value.id, "memory id"), value as unknown as JsonValue); }
  removeMemoryRecord(id: string): void { rmSync(this.entityPath(this.memoryRecords, id, "memory id"), { force: true }); }
  getMemoryRecord(id: string): MemoryRecord { return this.readPrivateJson(this.entityPath(this.memoryRecords, id, "memory id")) as unknown as MemoryRecord; }
  listMemoryRecords(): MemoryRecord[] { this.initialize(); return this.jsonFiles(this.memoryRecords).map((path) => this.readPrivateJson(path) as unknown as MemoryRecord).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  saveMemorySnapshot(value: MemorySnapshot): void { this.initialize(); this.writePrivateJson(this.entityPath(this.memorySnapshots, value.id, "memory snapshot id"), value as unknown as JsonValue); }
  getMemorySnapshot(id: string): MemorySnapshot { return this.readPrivateJson(this.entityPath(this.memorySnapshots, id, "memory snapshot id")) as unknown as MemorySnapshot; }
  saveExecutionContext(value: ExecutionContextSnapshot): void { this.initialize(); this.writePrivateJson(this.entityPath(this.executionContexts, value.id, "execution context id"), value as unknown as JsonValue); }
  getExecutionContext(id: string): ExecutionContextSnapshot { return this.readPrivateJson(this.entityPath(this.executionContexts, id, "execution context id")) as unknown as ExecutionContextSnapshot; }
  saveGoal(value: Goal): void { this.initialize(); this.writePrivateJson(this.entityPath(this.goalRecords, value.id, "goal id"), value as unknown as JsonValue); }
  getGoal<T = Goal>(id: string): T { return this.readPrivateJson(this.entityPath(this.goalRecords, id, "goal id")) as unknown as T; }
  listGoals<T = Goal>(): T[] { this.initialize(); return this.jsonFiles(this.goalRecords).map((path) => this.readPrivateJson(path) as unknown as T); }
  removeGoal(id: string): void { rmSync(this.entityPath(this.goalRecords, id, "goal id"), { force: true }); }
  saveGoalSnapshot(value: GoalSnapshot): void { this.initialize(); this.writePrivateJson(this.entityPath(this.goalSnapshots, value.id, "goal snapshot id"), value as unknown as JsonValue); }
  getGoalSnapshot<T = GoalSnapshot>(id: string): T { return this.readPrivateJson(this.entityPath(this.goalSnapshots, id, "goal snapshot id")) as unknown as T; }
  listGoalSnapshots<T = GoalSnapshot>(): T[] { this.initialize(); return this.jsonFiles(this.goalSnapshots).map((path) => this.readPrivateJson(path) as unknown as T); }
  saveAutomationDefinition(value: AutomationDefinition): void { this.initialize(); this.writePrivateJson(this.entityPath(this.automationDefinitions, value.id, "automation id"), value as unknown as JsonValue); }
  getAutomationDefinition<T = AutomationDefinition>(id: string): T { return this.readPrivateJson(this.entityPath(this.automationDefinitions, id, "automation id")) as unknown as T; }
  listAutomationDefinitions<T = AutomationDefinition>(): T[] { this.initialize(); return this.jsonFiles(this.automationDefinitions).map((path) => this.readPrivateJson(path) as unknown as T); }
  removeAutomationDefinition(id: string): void { rmSync(this.entityPath(this.automationDefinitions, id, "automation id"), { force: true }); }
  saveAutomationDefinitionSnapshot(value: { id: string }): void { this.initialize(); this.writePrivateJson(this.entityPath(this.automationDefinitionSnapshots, value.id, "automation definition snapshot id"), value as unknown as JsonValue); }
  getAutomationDefinitionSnapshot<T>(id: string): T { return this.readPrivateJson(this.entityPath(this.automationDefinitionSnapshots, id, "automation definition snapshot id")) as unknown as T; }
  createAutomationClaim(value: AutomationClaim): boolean { this.initialize(); const path = this.entityPath(this.automationClaims, value.automationId, "automation id"); const temporary = `${path}.${randomUUID()}.tmp`; try { writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); linkSync(temporary, path); chmodSync(path, 0o600); return true; } catch (error) { if (existsSync(path)) return false; throw error; } finally { rmSync(temporary, { force: true }); } }
  getAutomationClaim(id: string): AutomationClaim | undefined { const path = this.entityPath(this.automationClaims, id, "automation id"); return existsSync(path) ? this.readPrivateJson(path) as unknown as AutomationClaim : undefined; }
  removeAutomationClaim(id: string, runId: string): void { const path = this.entityPath(this.automationClaims, id, "automation id"); if (!existsSync(path)) return; const claim = this.readPrivateJson(path) as unknown as AutomationClaim; if (claim.runId === runId) rmSync(path, { force: true }); }
  saveAutomationSignalSnapshot(value: AutomationSignalSnapshot): void { this.initialize(); this.writePrivateJson(this.entityPath(this.automationSignalSnapshots, value.id, "automation signal snapshot id"), value as unknown as JsonValue); }
  getAutomationSignalSnapshot<T = AutomationSignalSnapshot>(id: string): T { return this.readPrivateJson(this.entityPath(this.automationSignalSnapshots, id, "automation signal snapshot id")) as unknown as T; }
  saveAutomationRun(value: AutomationRun): void { this.initialize(); this.writePrivateJson(this.entityPath(this.automationRuns, value.id, "automation run id"), value as unknown as JsonValue); }
  getAutomationRun<T = AutomationRun>(id: string): T { return this.readPrivateJson(this.entityPath(this.automationRuns, id, "automation run id")) as unknown as T; }
  listAutomationRuns<T = AutomationRun>(): T[] { this.initialize(); return this.jsonFiles(this.automationRuns).map((path) => this.readPrivateJson(path) as unknown as T); }
  saveAutomationFinding(value: AutomationFinding): void { this.initialize(); this.writePrivateJson(this.entityPath(this.automationFindings, value.id, "automation finding id"), value as unknown as JsonValue); }
  listAutomationFindings<T = AutomationFinding>(): T[] { this.initialize(); return this.jsonFiles(this.automationFindings).map((path) => this.readPrivateJson(path) as unknown as T); }
  saveAutomationReport(value: AutomationReport): void { this.initialize(); this.writePrivateJson(this.entityPath(this.automationReports, value.id, "automation report id"), value as unknown as JsonValue); }
  getAutomationReport<T = AutomationReport>(id: string): T { return this.readPrivateJson(this.entityPath(this.automationReports, id, "automation report id")) as unknown as T; }
  listAutomationReports<T = AutomationReport>(): T[] { this.initialize(); return this.jsonFiles(this.automationReports).map((path) => this.readPrivateJson(path) as unknown as T); }

  private changePath(id: string): string { return this.entityPath(this.changes, id, "change id"); }
  private integrationPath(id: string): string { return this.entityPath(this.integrations, id, "integration id"); }
  private entityPath(directory: string, id: string, label: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new ValidationError(`${label} contains unsupported characters`); return resolve(directory, `${id}.json`); }
  private turnDirectory(sessionId: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) throw new ValidationError("agent session id contains unsupported characters"); const directory = resolve(this.agentTurns, sessionId); if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new ValidationError("private state directory cannot be a symbolic link"); return directory; }
  private ensurePrivateDirectory(path: string): void { if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ValidationError("private state directory cannot be a symbolic link"); mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
  private readPrivateJson(path: string): JsonValue { if (lstatSync(path).isSymbolicLink()) throw new ValidationError("private state file cannot be a symbolic link"); return this.readJson(path); }
  private jsonFiles(directory: string): string[] { return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => resolve(directory, entry.name)); }
  private runTime(value: JsonValue): string { return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.completedAt === "string" ? value.completedAt : ""; }
}
