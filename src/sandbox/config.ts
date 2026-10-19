import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ValidationError } from "../errors.js";

/** Administrator configuration, supplied at service startup, not editable by Agents. */
export interface SandboxConfig {
  schemaVersion: 1;
  readRoots: string[];
  modelHosts: string[];
  /** Absolute Node entry point of the approved Pi installation. No executable wrappers. */
  piEntry: string;
  model: string;
  credentialKeys: string[];
}
export function loadSandboxConfig(path: string): SandboxConfig {
  let raw: unknown; try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new ValidationError("Cannot read sandbox administrator configuration"); }
  return validateSandboxConfig(raw);
}
export function validateSandboxConfig(value: unknown): SandboxConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Invalid sandbox configuration");
  const item = value as Record<string, unknown>;
  const keys = ["schemaVersion", "readRoots", "modelHosts", "piEntry", "model", "credentialKeys"];
  if (Object.keys(item).some(key => !keys.includes(key)) || item.schemaVersion !== 1) throw new ValidationError("Unsupported sandbox configuration fields");
  for (const key of ["readRoots", "modelHosts", "credentialKeys"]) if (!Array.isArray(item[key]) || !(item[key] as unknown[]).every(v => typeof v === "string")) throw new ValidationError(`Invalid sandbox ${key}`);
  if (typeof item.piEntry !== "string" || !isAbsolute(item.piEntry) || typeof item.model !== "string" || !/^[A-Za-z0-9_.:/-]+$/.test(item.model)) throw new ValidationError("Sandbox requires an absolute Pi entry and explicit model");
  const allowed = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]);
  if ((item.credentialKeys as string[]).some(key => !allowed.has(key))) throw new ValidationError("Unsupported sandbox model credential key");
  return { schemaVersion: 1, readRoots: [...item.readRoots as string[]], modelHosts: [...item.modelHosts as string[]], credentialKeys: [...item.credentialKeys as string[]], piEntry: realpathSync(item.piEntry), model: item.model };
}
export function sandboxBinding(config: SandboxConfig, policies: unknown[], profileDigest: string): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ config, policies, profileDigest, piEntryDigest: createHash("sha256").update(readFileSync(config.piEntry)).digest("hex"), node: process.versions.node, platform: process.platform })).digest("hex")}`;
}
