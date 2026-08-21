import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { WorktreeLease } from "./collaboration.js";
import { PolicyDenied, ValidationError } from "./errors.js";
import type { Workspace } from "./storage.js";

interface LeaseWorkspace { id: string; kind: "local" | "virtual"; rootPath?: string }
interface WorktreeLeaseDependencies { workspace(id: string): LeaseWorkspace }
export interface ProvisionWorktreeInput { collaborationId: string; assignmentId: string; workspaceId: string; baseRevision: string; expectedBaseCommit?: string; approved: boolean }

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function requiredId(value: string, label: string): string { const normalized = value.trim(); if (!identifier.test(normalized)) throw new ValidationError(`${label} contains unsupported characters`); return normalized; }
function revision(value: string): string { const normalized = value.trim(); if (!normalized || normalized.startsWith("-") || normalized.includes("\0") || normalized.includes("\n")) throw new ValidationError("invalid Git revision"); return normalized; }
function segment(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-20) || "item"; }

export class WorktreeLeaseService {
  constructor(readonly storage: Workspace, private readonly dependencies: WorktreeLeaseDependencies) {}

  list(collaborationId?: string): WorktreeLease[] { return this.storage.listWorktreeLeases().filter((lease) => !collaborationId || lease.collaborationId === collaborationId); }
  get(id: string): WorktreeLease { return this.storage.getWorktreeLease(requiredId(id, "worktree lease id")); }
  resolveBaseCommit(workspaceId_: string, baseRevision_: string): string { const workspace = this.dependencies.workspace(requiredId(workspaceId_, "workspace id")); if (workspace.kind !== "local" || !workspace.rootPath) throw new ValidationError("worktree leases require a local Workspace"); return this.git(realpathSync(workspace.rootPath), ["rev-parse", "--verify", `${revision(baseRevision_)}^{commit}`]).trim(); }

  provision(input: ProvisionWorktreeInput): WorktreeLease {
    if (!input.approved) throw new PolicyDenied("worktree lease provisioning requires approved collaboration context");
    const collaborationId = requiredId(input.collaborationId, "collaboration id"); const assignmentId = requiredId(input.assignmentId, "assignment id"); const workspaceId = requiredId(input.workspaceId, "workspace id");
    const existing = this.list().find((lease) => lease.assignmentId === assignmentId && !["removed", "failed"].includes(lease.status)); if (existing) return existing;
    const workspace = this.dependencies.workspace(workspaceId); if (workspace.kind !== "local" || !workspace.rootPath) throw new ValidationError("worktree leases require a local Workspace");
    const repositoryRoot = realpathSync(workspace.rootPath); const baseRevision = revision(input.baseRevision); const approvedCommit = input.expectedBaseCommit ? revision(input.expectedBaseCommit) : baseRevision; const baseCommit = this.git(repositoryRoot, ["rev-parse", "--verify", `${approvedCommit}^{commit}`]).trim(); if (input.expectedBaseCommit !== undefined && input.expectedBaseCommit !== baseCommit) throw new PolicyDenied("approved Collaboration base commit is not a valid commit");
    const branch = `cjhx/${segment(collaborationId)}/${segment(assignmentId)}`; this.git(repositoryRoot, ["check-ref-format", `refs/heads/${branch}`]);
    const managedRoot = resolve(dirname(repositoryRoot), ".cjhx-worktrees", segment(basename(repositoryRoot)), segment(collaborationId)); mkdirSync(managedRoot, { recursive: true });
    const path = resolve(managedRoot, segment(assignmentId)); const relation = relative(managedRoot, path); if (relation === ".." || relation.startsWith(`..${sep}`)) throw new ValidationError("worktree lease path escapes managed root");
    if (existsSync(path)) throw new ValidationError("worktree lease path already exists");
    const now = new Date().toISOString(); const lease: WorktreeLease = { schemaVersion: 1, id: `worktree-lease-${randomUUID().replaceAll("-", "")}`, collaborationId, assignmentId, workspaceId, repositoryRoot, path, branch, baseRevision, baseCommit, status: "provisioning", createdAt: now }; this.storage.saveWorktreeLease(lease);
    try { this.git(repositoryRoot, ["worktree", "add", "-b", branch, path, baseCommit]); lease.status = "active"; this.storage.saveWorktreeLease(lease); return lease; }
    catch (error) { lease.status = "failed"; this.storage.saveWorktreeLease(lease); throw error; }
  }

  complete(id: string): WorktreeLease { const lease = this.get(id); if (lease.status !== "active") throw new ValidationError("only active worktree leases can complete"); lease.status = "completed"; lease.completedAt = new Date().toISOString(); this.storage.saveWorktreeLease(lease); return lease; }

  remove(id: string, options: { approved: boolean }): WorktreeLease {
    if (!options.approved) throw new PolicyDenied("worktree lease removal requires human approval"); const lease = this.get(id); if (lease.status === "removed") return lease; if (lease.status === "active" || lease.status === "provisioning") throw new PolicyDenied("active worktree leases cannot be removed"); if (!existsSync(lease.path)) { lease.status = "removed"; lease.removedAt = new Date().toISOString(); this.storage.saveWorktreeLease(lease); return lease; }
    const actual = realpathSync(lease.path); if (actual === realpathSync(lease.repositoryRoot)) throw new ValidationError("main worktree cannot be removed");
    const registered = this.git(lease.repositoryRoot, ["worktree", "list", "--porcelain"]).split("\n").some((line) => line === `worktree ${actual}`); if (!registered) throw new ValidationError("worktree lease path is not registered");
    const dirty = this.git(actual, ["status", "--porcelain=v1"]).trim(); if (dirty) { lease.status = "cleanup_pending"; this.storage.saveWorktreeLease(lease); throw new PolicyDenied("worktree lease has uncommitted changes and cannot be removed"); }
    this.git(lease.repositoryRoot, ["worktree", "remove", actual]); lease.status = "removed"; lease.removedAt = new Date().toISOString(); this.storage.saveWorktreeLease(lease); return lease;
  }

  private git(root: string, args: string[]): string { try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { throw new ValidationError(`Git operation failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); } }
}
