import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";
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
  readonly lockfile: string;

  constructor(root = ".cjhx") {
    this.root = resolve(root);
    this.changes = resolve(this.root, "changes");
    this.skills = resolve(this.root, "skills");
    this.runs = resolve(this.root, "runs");
    this.tasks = resolve(this.root, "tasks");
    this.lockfile = resolve(this.root, "skills-lock.json");
  }

  initialize(): void {
    [this.root, this.changes, this.skills, this.runs, this.tasks].forEach((path) => mkdirSync(path, { recursive: true }));
    if (!existsSync(this.lockfile)) this.writeJson(this.lockfile, { schemaVersion: 1, skills: {} });
  }

  writeJson(path: string, value: JsonValue): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
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

  private changePath(id: string): string { return this.entityPath(this.changes, id, "change id"); }
  private entityPath(directory: string, id: string, label: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new ValidationError(`${label} contains unsupported characters`); return resolve(directory, `${id}.json`); }
  private jsonFiles(directory: string): string[] { return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => resolve(directory, entry.name)); }
  private runTime(value: JsonValue): string { return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.completedAt === "string" ? value.completedAt : ""; }
}
