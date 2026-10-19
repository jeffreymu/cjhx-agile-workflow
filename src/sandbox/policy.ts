import { createHash } from "node:crypto";
import { existsSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PolicyDenied, ValidationError } from "../errors.js";
import type { RuleSnapshot } from "../harness.js";

export const sandboxRuntimeVersion = "0.0.80";
export interface SandboxPolicyInput {
  executionRoot: string;
  controlRoot: string;
  /** Explicit, administrator-approved runtime/toolchain read roots, never user HOME. */
  readRoots: string[];
  modelHosts: string[];
}
export interface SandboxPolicy {
  schemaVersion: 1;
  backend: "anthropic-srt";
  runtimeVersion: string;
  purpose: "agent" | "postflight";
  executionRoot: string;
  readRoots: string[];
  writeRoots: string[];
  deniedPaths: string[];
  allowedHosts: string[];
  ruleDigest: string;
  digest: string;
}

function canonical(path: string): string {
  if (!isAbsolute(path) || path.includes("\0") || /[*?\[\]{}]/.test(path)) throw new ValidationError("Sandbox paths must be absolute literal paths");
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new ValidationError("Sandbox policy root does not exist");
  return realpathSync(resolved);
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}
function host(value: string): string {
  const normalized = value.toLowerCase();
  if (value !== value.trim() || normalized.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(normalized) || normalized.endsWith(".localhost") || normalized.endsWith(".local")) throw new ValidationError("Sandbox model hosts must be explicit public DNS names without ports or wildcards");
  return normalized;
}
function sorted(values: string[]): string[] { return [...new Set(values)].sort(); }

/** Compile a conservative minimum policy, independently of upstream SDK config types.
 * This is not an enforcement mechanism: a Runner must apply it before launching a child.
 */
export function compileSandboxPolicy(input: SandboxPolicyInput, snapshot: RuleSnapshot, purpose: SandboxPolicy["purpose"]): SandboxPolicy {
  if (purpose !== "agent" && purpose !== "postflight") throw new ValidationError("Invalid Sandbox purpose");
  const executionRoot = canonical(input.executionRoot); const controlRoot = canonical(input.controlRoot);
  if (inside(controlRoot, executionRoot)) throw new PolicyDenied("Sandbox execution root overlaps control-plane storage");
  const readRoots = sorted([executionRoot, ...input.readRoots.map(canonical)]);
  if (readRoots.some(root => root === resolve(root, ".."))) throw new PolicyDenied("Sandbox cannot grant whole-filesystem read access");
  const home = realpathSync(homedir());
  if (readRoots.some(root => inside(root, home))) throw new PolicyDenied("Sandbox cannot grant user HOME or its ancestors");
  const capabilities = snapshot.effective.capabilities;
  // A sandbox filesystem policy is not a Git-command or tool permission broker.
  if (Object.values(capabilities.git).some(allowed => !allowed) || capabilities.tools.allowed !== null || capabilities.tools.denied.length) throw new PolicyDenied("Sandbox cannot enforce Git or tool-specific restrictions");
  const writeRoots = capabilities.filesystem.writeRoots === null ? [executionRoot] : sorted(capabilities.filesystem.writeRoots.map(path => {
    const resolved = canonical(resolve(executionRoot, path));
    if (!inside(executionRoot, resolved)) throw new PolicyDenied("Sandbox write root escapes the execution repository");
    return resolved;
  }));
  const deniedPaths = sorted([controlRoot, resolve(executionRoot, ".git"), resolve(executionRoot, ".cjhx"), resolve(executionRoot, ".pi"), resolve(executionRoot, ".env"), resolve(executionRoot, ".npmrc"), resolve(executionRoot, ".gitconfig"), resolve(executionRoot, "cjhx.harness.json"), ...readdirSync(executionRoot).filter(name => name.startsWith(".env.")).map(name => resolve(executionRoot, name)), ...capabilities.filesystem.deniedPaths.map(path => {
    if (path.includes("\0") || /[*?\[\]{}]/.test(path)) throw new ValidationError("Sandbox denied paths must be literal paths");
    const resolved = resolve(executionRoot, path);
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  })]);
  const configuredHosts = sorted(input.modelHosts.map(host));
  const allowedHosts = purpose === "postflight" || capabilities.network.mode === "none" ? [] : capabilities.network.mode === "allowlist" ? configuredHosts.filter(value => capabilities.network.allowedHosts.map(host).includes(value)) : configuredHosts;
  const policy = { schemaVersion: 1 as const, backend: "anthropic-srt" as const, runtimeVersion: sandboxRuntimeVersion, purpose, executionRoot, readRoots, writeRoots, deniedPaths, allowedHosts, ruleDigest: snapshot.digest };
  return { ...policy, digest: `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}` };
}

export function assertSandboxRuntimeHost(platform = process.platform, nodeVersion = process.versions.node): void {
  if (!["darwin", "linux", "win32"].includes(platform)) throw new PolicyDenied("Anthropic sandbox runtime does not support this platform");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(nodeVersion)) throw new ValidationError("Invalid Node.js version for sandbox runtime");
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new PolicyDenied("Anthropic sandbox runtime requires Node.js >=22.12.0; host fallback is disabled");
}
