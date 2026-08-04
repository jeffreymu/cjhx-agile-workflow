import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";
import type { AgentRun } from "./agents.js";
import type { Change, JsonValue, SkillRun } from "./models.js";
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
    this.lockfile = resolve(this.root, "skills-lock.json");
  }

  initialize(): void {
    [this.root, this.changes, this.skills, this.runs, this.tasks, this.workspaces, this.integrations, this.agents, this.agentRuns].forEach((path) => mkdirSync(path, { recursive: true }));
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

  private changePath(id: string): string { return this.entityPath(this.changes, id, "change id"); }
  private integrationPath(id: string): string { return this.entityPath(this.integrations, id, "integration id"); }
  private entityPath(directory: string, id: string, label: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new ValidationError(`${label} contains unsupported characters`); return resolve(directory, `${id}.json`); }
  private jsonFiles(directory: string): string[] { return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => resolve(directory, entry.name)); }
  private runTime(value: JsonValue): string { return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.completedAt === "string" ? value.completedAt : ""; }
}
