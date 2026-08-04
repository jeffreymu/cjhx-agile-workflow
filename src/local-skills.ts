import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { SkillError, ValidationError } from "./errors.js";
import type { SkillManifest } from "./models.js";
import type { Policy } from "./policy.js";
import { packageDigest, type SkillRegistry } from "./skills.js";
import type { Workspace } from "./storage.js";

export type LocalSkillKind = "cjhx-package" | "agent-instructions";
export interface LocalSkill {
  id: string;
  kind: LocalSkillKind;
  name: string;
  description: string;
  path: string;
  root: string;
  enabled: boolean;
  compatible: boolean;
  compatibilityError?: string;
  skillId?: string;
  version?: string;
  source?: string;
  riskLevel?: string;
}
export interface LocalSkillScan { roots: string[]; skills: LocalSkill[]; warnings: string[] }
export interface EnabledAgentSkill { name: string; description: string; path: string }
interface LocalSkillState { schemaVersion: 1; enabledAgentSkills: Record<string, string> }
interface Candidate { id: string; kind: LocalSkillKind; directory: string; root: string; manifest?: SkillManifest; name: string; description: string }

const maxEntries = 5_000;
const maxDepth = 6;

function defaultRoots(workspace: Workspace): string[] {
  const home = homedir(); const project = dirname(workspace.root); const configured = (process.env.CJHX_SKILL_PATHS ?? "").split(delimiter).filter(Boolean);
  return [...configured, resolve(home, ".pi/agent/skills"), resolve(home, ".agents/skills"), resolve(home, ".claude/skills"), resolve(home, ".codex/skills"), resolve(home, ".qoder/skills"), resolve(home, ".qorder/skills"), resolve(project, ".pi/skills"), resolve(project, ".claude/skills"), resolve(project, ".codex/skills"), resolve(project, ".qoder/skills"), resolve(project, ".qorder/skills")];
}
function identifier(kind: LocalSkillKind, directory: string): string { return `local-skill-${createHash("sha256").update(`${kind}\0${directory}`).digest("hex").slice(0, 24)}`; }
function instructionDigest(directory: string): string { const path = resolve(directory, "SKILL.md"); if (statSync(path).size > 1_048_576) throw new ValidationError("SKILL.md exceeds 1 MB"); return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`; }
function frontmatter(path: string): { name: string; description: string } {
  if (statSync(path).size > 1_048_576) throw new ValidationError("SKILL.md exceeds 1 MB");
  const text = readFileSync(path, "utf8").slice(0, 131_072).replaceAll("\r\n", "\n"); const closing = text.startsWith("---\n") ? text.indexOf("\n---", 4) : -1; const lines = closing < 0 ? [] : text.slice(4, closing).split("\n");
  const value = (key: string) => { const index = lines.findIndex((line) => line.startsWith(`${key}:`)); if (index < 0) return ""; const initial = lines[index]!.slice(key.length + 1).trim(); if (!/^[>|][+-]?$/.test(initial)) return initial.replace(/^['"]|['"]$/g, ""); const parts: string[] = []; for (const line of lines.slice(index + 1)) { if (line && !/^\s/.test(line)) break; if (line.trim()) parts.push(line.trim()); } return initial.startsWith(">") ? parts.join(" ") : parts.join("\n"); };
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ""; return { name: (value("name") || title).slice(0, 200), description: value("description").slice(0, 2_000) };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class LocalSkillService {
  readonly roots: string[];
  constructor(readonly workspace: Workspace, readonly registry: SkillRegistry, readonly policy: Policy, roots?: string[]) {
    this.roots = [...new Set((roots ?? defaultRoots(workspace)).map((path) => resolve(path)))];
  }

  scan(): LocalSkill[] { return this.catalog().skills; }
  catalog(): LocalSkillScan {
    const warnings: string[] = []; const roots: string[] = []; const candidates: Candidate[] = []; let entries = 0;
    for (const configuredRoot of this.roots) {
      if (!existsSync(configuredRoot)) continue;
      try {
        const root = realpathSync(configuredRoot); if (!lstatSync(root).isDirectory()) { warnings.push(`${configuredRoot}: not a directory`); continue; } const found: Candidate[] = [];
        this.walk(root, root, 0, found, warnings, () => { entries += 1; if (entries > maxEntries) throw new SkillError(`local Skill scan exceeds ${maxEntries} entries`); }); roots.push(root); candidates.push(...found);
      } catch (error) { warnings.push(`${configuredRoot}: ${errorMessage(error)}`); }
    }
    const state = this.state(); const lock = this.workspace.getLock(); const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]; const skills = unique.map((candidate): LocalSkill => {
      let compatible = true; let compatibilityError: string | undefined; let enabled = candidate.kind === "agent-instructions" && state.enabledAgentSkills[candidate.id] === instructionDigest(candidate.directory);
      if (candidate.manifest) {
        try { const record = lock.skills[candidate.manifest.id]; enabled = Boolean(record && record.version === candidate.manifest.version && record.digest === packageDigest(candidate.directory)); }
        catch (error) { compatible = false; compatibilityError = errorMessage(error); enabled = false; }
        try { this.policy.checkInstall(candidate.manifest); }
        catch (error) { compatible = false; compatibilityError = errorMessage(error); }
      }
      return { id: candidate.id, kind: candidate.kind, name: candidate.name, description: candidate.description, path: candidate.directory, root: candidate.root, enabled, compatible, ...(compatibilityError ? { compatibilityError } : {}), ...(candidate.manifest ? { skillId: candidate.manifest.id, version: candidate.manifest.version, source: candidate.manifest.source, riskLevel: candidate.manifest.riskLevel } : {}) };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return { roots: [...new Set(roots)], skills, warnings };
  }

  enable(id: string): LocalSkill {
    const candidate = this.find(id); if (candidate.manifest) { this.policy.checkInstall(candidate.manifest); this.registry.install(candidate.directory); }
    else { const state = this.state(); state.enabledAgentSkills[id] = instructionDigest(candidate.directory); this.save(state); }
    return this.scan().find((item) => item.id === id)!;
  }

  disable(id: string): LocalSkill {
    const candidate = this.find(id);
    if (candidate.manifest) this.registry.disable(candidate.manifest.id, packageDigest(candidate.directory));
    else { const state = this.state(); delete state.enabledAgentSkills[id]; this.save(state); }
    return this.scan().find((item) => item.id === id)!;
  }

  enabledAgentSkills(): EnabledAgentSkill[] {
    const enabled = this.state().enabledAgentSkills; return this.candidates().filter((candidate) => candidate.kind === "agent-instructions" && enabled[candidate.id] === instructionDigest(candidate.directory)).map((candidate) => ({ name: candidate.name, description: candidate.description, path: resolve(candidate.directory, "SKILL.md") }));
  }

  private candidates(): Candidate[] { const candidates: Candidate[] = []; const warnings: string[] = []; let entries = 0; for (const configuredRoot of this.roots) { if (!existsSync(configuredRoot)) continue; try { const root = realpathSync(configuredRoot); if (lstatSync(root).isDirectory()) { const found: Candidate[] = []; this.walk(root, root, 0, found, warnings, () => { entries += 1; if (entries > maxEntries) throw new SkillError(`local Skill scan exceeds ${maxEntries} entries`); }); candidates.push(...found); } } catch { /* unavailable roots are reported by catalog */ } } return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]; }
  private find(id: string): Candidate { if (!/^local-skill-[a-f0-9]{24}$/.test(id)) throw new ValidationError("invalid local Skill id"); const candidate = this.candidates().find((item) => item.id === id); if (!candidate) throw new SkillError(`local Skill is no longer available: ${id}`); return candidate; }
  private walk(root: string, directory: string, depth: number, output: Candidate[], warnings: string[], count: () => void): void {
    if (depth > maxDepth) return; count();
    const manifestPath = resolve(directory, "skill.json"); const instructionsPath = resolve(directory, "SKILL.md");
    if (existsSync(manifestPath) && !lstatSync(manifestPath).isSymbolicLink()) {
      try { const manifest = this.registry.loadManifest(directory); output.push({ id: identifier("cjhx-package", directory), kind: "cjhx-package", directory, root, manifest, name: manifest.name, description: manifest.description }); } catch (error) { warnings.push(`${manifestPath}: ${errorMessage(error)}`); } return;
    }
    if (existsSync(instructionsPath) && !lstatSync(instructionsPath).isSymbolicLink()) {
      try { const metadata = frontmatter(instructionsPath); output.push({ id: identifier("agent-instructions", directory), kind: "agent-instructions", directory, root, name: metadata.name || directory.split(/[\\/]/).at(-1) || "Local Skill", description: metadata.description || "Local Agent instruction Skill" }); } catch (error) { warnings.push(`${instructionsPath}: ${errorMessage(error)}`); } return;
    }
    let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) { warnings.push(`${directory}: ${errorMessage(error)}`); return; }
    for (const entry of entries) { if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".git" || entry.name === ".cjhx") continue; this.walk(root, resolve(directory, entry.name), depth + 1, output, warnings, count); }
  }
  private state(): LocalSkillState { this.workspace.initialize(); if (!this.workspace.localSkillConfigExists()) return { schemaVersion: 1, enabledAgentSkills: {} }; const value = this.workspace.getLocalSkillConfig() as unknown as { enabledAgentSkills?: unknown }; const enabled = value.enabledAgentSkills; return { schemaVersion: 1, enabledAgentSkills: enabled && typeof enabled === "object" && !Array.isArray(enabled) ? Object.fromEntries(Object.entries(enabled).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^sha256:[a-f0-9]{64}$/.test(entry[1]))) : {} }; }
  private save(state: LocalSkillState): void { this.workspace.saveLocalSkillConfig(state as unknown as import("./models.js").JsonValue); }
}
