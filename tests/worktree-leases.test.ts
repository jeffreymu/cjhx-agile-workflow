import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { PolicyDenied } from "../src/errors.js";
import { Workspace } from "../src/storage.js";
import { WorktreeLeaseService } from "../src/worktree-leases.js";

function fixture(t: test.TestContext) { const root = mkdtempSync(resolve(tmpdir(), "cjhx-worktree-lease-")); t.after(() => rmSync(root, { recursive: true, force: true })); const repository = resolve(root, "repo"); execFileSync("git", ["init", "-b", "main", repository]); writeFileSync(resolve(repository, "README.md"), "base\n"); execFileSync("git", ["-C", repository, "add", "."]); execFileSync("git", ["-C", repository, "-c", "user.name=CJHX", "-c", "user.email=cjhx@example.com", "commit", "-m", "initial"]); const storage = new Workspace(resolve(root, ".cjhx")); const service = new WorktreeLeaseService(storage, { workspace: () => ({ id: "workspace-1", kind: "local", rootPath: repository }) }); return { root, repository, storage, service }; }

test("write assignments receive unique managed worktree leases", (t) => {
  const { repository, service } = fixture(t); assert.throws(() => service.provision({ collaborationId: "collaboration-1", assignmentId: "assignment-1", workspaceId: "workspace-1", baseRevision: "HEAD", approved: false }), PolicyDenied);
  const first = service.provision({ collaborationId: "collaboration-1", assignmentId: "assignment-1", workspaceId: "workspace-1", baseRevision: "HEAD", approved: true }); const duplicate = service.provision({ collaborationId: "collaboration-1", assignmentId: "assignment-1", workspaceId: "workspace-1", baseRevision: "HEAD", approved: true }); const second = service.provision({ collaborationId: "collaboration-1", assignmentId: "assignment-2", workspaceId: "workspace-1", baseRevision: "HEAD", approved: true });
  assert.equal(first.id, duplicate.id); assert.notEqual(first.path, second.path); assert.notEqual(first.branch, second.branch); assert.equal(first.repositoryRoot, realpathSync(repository)); assert.equal(first.status, "active"); assert.equal(existsSync(first.path), true); assert.equal(service.list("collaboration-1").length, 2);
  assert.throws(() => service.remove(first.id, { approved: false }), PolicyDenied); assert.throws(() => service.remove(first.id, { approved: true }), /active worktree/); service.complete(first.id); const removed = service.remove(first.id, { approved: true }); assert.equal(removed.status, "removed"); assert.equal(existsSync(first.path), false); service.complete(second.id); service.remove(second.id, { approved: true });
});

test("dirty worktrees are retained for explicit recovery", (t) => {
  const { service } = fixture(t); const lease = service.provision({ collaborationId: "collaboration-2", assignmentId: "assignment-dirty", workspaceId: "workspace-1", baseRevision: "HEAD", approved: true }); writeFileSync(resolve(lease.path, "work.ts"), "export const dirty = true;\n"); service.complete(lease.id); assert.throws(() => service.remove(lease.id, { approved: true }), /uncommitted changes/); assert.equal(service.get(lease.id).status, "cleanup_pending"); assert.equal(existsSync(lease.path), true); execFileSync("git", ["-C", lease.path, "add", "."]); execFileSync("git", ["-C", lease.path, "-c", "user.name=CJHX", "-c", "user.email=cjhx@example.com", "commit", "-m", "preserve work"]); assert.equal(service.remove(lease.id, { approved: true }).status, "removed");
});

test("worktree lease inputs cannot select arbitrary paths or option revisions", (t) => {
  const { service } = fixture(t); assert.throws(() => service.provision({ collaborationId: "../escape", assignmentId: "assignment-1", workspaceId: "workspace-1", baseRevision: "HEAD", approved: true }), /unsupported/); assert.throws(() => service.provision({ collaborationId: "collaboration-3", assignmentId: "assignment-1", workspaceId: "workspace-1", baseRevision: "--help", approved: true }), /invalid Git revision/);
});
