import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { ToolBroker, type ToolOperation } from "./adapters.js";
import { redact } from "./audit.js";
import { builtins, type SkillResponse } from "./builtin-skills.js";
import { SkillError, ValidationError } from "./errors.js";
import type { JsonObject, JsonValue, SkillManifest, SkillRun } from "./models.js";
import { isRecord, parseSkillManifest, utcNow } from "./models.js";
import { Policy } from "./policy.js";
import { Workspace, type SkillLockRecord } from "./storage.js";

const manifestName = "skill.json";

function packageFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new SkillError(`skill packages cannot contain symbolic links: ${relative(root, path)}`);
    if (stat.isDirectory()) {
      if (entry.name !== "__pycache__") files.push(...packageFiles(root, path));
    } else if (!entry.name.endsWith(".pyc") && !entry.name.endsWith(".pyo")) files.push(path);
  }
  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

export function packageDigest(root: string): string {
  const hash = createHash("sha256");
  for (const file of packageFiles(root)) {
    const name = Buffer.from(relative(root, file)); const content = readFileSync(file);
    const nameLength = Buffer.alloc(4); nameLength.writeUInt32BE(name.length);
    const contentLength = Buffer.alloc(8); contentLength.writeBigUInt64BE(BigInt(content.length));
    hash.update(nameLength).update(name).update(contentLength).update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}

export class SkillRegistry {
  constructor(readonly workspace: Workspace, readonly policy: Policy) {}

  loadManifest(packagePath: string): SkillManifest {
    try { return parseSkillManifest(JSON.parse(readFileSync(resolve(packagePath, manifestName), "utf8")) as unknown); }
    catch (error) { if (error instanceof ValidationError) throw error; throw new ValidationError(`invalid ${manifestName}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  install(packagePath: string): { manifest: SkillManifest; digest: string; path: string } {
    const source = realpathSync(resolve(packagePath));
    if (!lstatSync(source).isDirectory()) throw new SkillError(`skill package is not a directory: ${source}`);
    packageFiles(source);
    const manifest = this.loadManifest(source); this.policy.checkInstall(manifest);
    const digest = packageDigest(source); const target = resolve(this.workspace.skills, manifest.id, manifest.version);
    this.workspace.initialize();
    if (existsSync(target)) {
      if (packageDigest(target) !== digest) throw new SkillError(`${manifest.id}@${manifest.version} is already installed with a different digest`);
    } else {
      mkdirSync(resolve(target, ".."), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`;
      cpSync(source, temporary, { recursive: true, dereference: false }); renameSync(temporary, target);
    }
    const lock = this.workspace.getLock();
    lock.skills[manifest.id] = { version: manifest.version, digest, path: relative(this.workspace.root, target), source: manifest.source };
    this.workspace.saveLock(lock); return { manifest, digest, path: target };
  }

  list(): ({ id: string } & SkillLockRecord)[] { return Object.entries(this.workspace.getLock().skills).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({ id, ...value })); }

  resolve(skillId: string): { manifest: SkillManifest; packagePath: string; digest: string } {
    const record = this.workspace.getLock().skills[skillId]; if (!record) throw new SkillError(`skill is not installed: ${skillId}`);
    const packagePath = resolve(this.workspace.root, record.path); const manifest = this.loadManifest(packagePath); const digest = packageDigest(packagePath);
    if (digest !== record.digest) throw new SkillError(`installed skill digest mismatch: ${skillId}`);
    return { manifest, packagePath, digest };
  }
}

function parseResponse(value: unknown): SkillResponse {
  if (!isRecord(value)) throw new SkillError("skill response must be an object");
  const output = value.output ?? {}; const evidence = value.evidence ?? []; const operations = value.operations ?? [];
  if (!isRecord(output)) throw new SkillError("skill output must be an object");
  if (!Array.isArray(evidence) || !evidence.every(isRecord)) throw new SkillError("skill evidence must be an array of objects");
  if (!Array.isArray(operations) || !operations.every((item) => isRecord(item) && typeof item.tool === "string" && isRecord(item.arguments))) throw new SkillError("skill operations must be valid tool operations");
  return { output: output as JsonObject, evidence: evidence as JsonObject[], operations: operations as ToolOperation[] };
}

export class SkillRuntime {
  constructor(readonly workspace: Workspace, readonly registry: SkillRegistry, readonly policy: Policy, readonly tools = new ToolBroker()) {}

  async run(skillId: string, payload: JsonObject, options: { changeId?: string; workspaceId?: string; approved?: boolean } = {}): Promise<SkillRun> {
    const { manifest, packagePath } = this.registry.resolve(skillId); this.policy.checkRun(manifest, options.approved ?? false);
    const id = `skill-run-${randomUUID().replaceAll("-", "")}`; const startedAt = utcNow();
    try {
      const response = parseResponse(await this.invoke(manifest, packagePath, payload));
      const toolResults: JsonObject[] = [];
      for (const operation of response.operations) toolResults.push(await this.tools.execute(operation, new Set(manifest.permissions)));
      const output = toolResults.length ? { ...response.output, toolResults } : response.output;
      const run: SkillRun = { id, skillId: manifest.id, skillVersion: manifest.version, ...(options.changeId ? { changeId: options.changeId } : {}), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), status: "succeeded", startedAt, completedAt: utcNow(), input: redact(payload) as JsonObject, output: redact(output) as JsonObject, evidence: redact(response.evidence) as JsonObject[] };
      this.workspace.saveRun(run); return run;
    } catch (error) {
      const run: SkillRun = { id, skillId: manifest.id, skillVersion: manifest.version, ...(options.changeId ? { changeId: options.changeId } : {}), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), status: "failed", startedAt, completedAt: utcNow(), input: redact(payload) as JsonObject, output: {}, evidence: [], error: `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}` };
      this.workspace.saveRun(run); throw error;
    }
  }

  private async invoke(manifest: SkillManifest, packagePath: string, payload: JsonObject): Promise<unknown> {
    if (manifest.entrypoint.type === "builtin") { const handler = builtins[manifest.entrypoint.target]; if (!handler) throw new SkillError(`unknown builtin skill: ${manifest.entrypoint.target}`); return handler(payload); }
    const executable = resolve(packagePath, manifest.entrypoint.target); const prefix = `${packagePath}${sep}`;
    if (!executable.startsWith(prefix) || !existsSync(executable) || lstatSync(executable).isDirectory()) throw new SkillError("process entrypoint must be a file inside its skill package");
    const extension = basename(executable).split(".").pop();
    const command = extension === "js" || extension === "mjs" ? process.execPath : extension === "py" ? "python3" : executable;
    const args = command === process.execPath || command === "python3" ? [executable] : [];
    return await new Promise((accept, reject) => {
      const child = spawn(command, args, { cwd: packagePath, env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = ""; let settled = false;
      const timeout = Math.min(manifest.timeoutSeconds, this.policy.processTimeoutSeconds);
      const timer = setTimeout(() => { child.kill("SIGKILL"); if (!settled) { settled = true; reject(new SkillError(`skill timed out after ${timeout} seconds`)); } }, timeout * 1000);
      child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; }); child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
      child.on("error", (error) => { clearTimeout(timer); if (!settled) { settled = true; reject(new SkillError(`skill process failed: ${error.message}`)); } });
      child.on("close", (code) => { clearTimeout(timer); if (settled) return; settled = true; if (code !== 0) return reject(new SkillError(`skill process exited ${code}: ${stderr.slice(-1000).trim()}`)); try { accept(JSON.parse(stdout) as unknown); } catch { reject(new SkillError("skill process did not return valid JSON")); } });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}
