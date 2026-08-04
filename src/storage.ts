import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";
import type { Change, JsonValue, SkillRun } from "./models.js";

export interface SkillLockRecord { version: string; digest: string; path: string; source: string }
export interface SkillLock { schemaVersion: 1; skills: Record<string, SkillLockRecord> }

export class Workspace {
  readonly root: string;
  readonly changes: string;
  readonly skills: string;
  readonly runs: string;
  readonly lockfile: string;

  constructor(root = ".cjhx") {
    this.root = resolve(root);
    this.changes = resolve(this.root, "changes");
    this.skills = resolve(this.root, "skills");
    this.runs = resolve(this.root, "runs");
    this.lockfile = resolve(this.root, "skills-lock.json");
  }

  initialize(): void {
    [this.root, this.changes, this.skills, this.runs].forEach((path) => mkdirSync(path, { recursive: true }));
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

  saveChange(change: Change): void { this.initialize(); this.writeJson(resolve(this.changes, `${change.id}.json`), change as unknown as JsonValue); }
  getChange(id: string): Change { return this.readJson(resolve(this.changes, `${id}.json`)) as unknown as Change; }
  changeExists(id: string): boolean { return existsSync(resolve(this.changes, `${id}.json`)); }
  saveRun(run: SkillRun | { id: string }): void { this.initialize(); this.writeJson(resolve(this.runs, `${run.id}.json`), run as unknown as JsonValue); }
  getLock(): SkillLock { this.initialize(); return this.readJson(this.lockfile) as unknown as SkillLock; }
  saveLock(lock: SkillLock): void { this.writeJson(this.lockfile, lock as unknown as JsonValue); }
}
