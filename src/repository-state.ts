import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ValidationError } from "./errors.js";

const stateLimit = 32 * 1_048_576;

export function fingerprintRepositoryState(cwd: string, excludedRoot?: string): string {
  try {
    const root = realpathSync(cwd);
    const git = (arguments_: string[]): Buffer => execFileSync("git", arguments_, { cwd: root, encoding: "buffer", maxBuffer: stateLimit, stdio: ["ignore", "pipe", "ignore"] });
    const excludedRelative = excludedRoot ? relative(root, realpathSync(excludedRoot)).replaceAll("\\", "/") : undefined;
    const excludedPrefix = !excludedRelative || excludedRelative.startsWith("..") || isAbsolute(excludedRelative) ? undefined : excludedRelative;
    const pathspec = excludedPrefix ? ["--", ".", `:(exclude)${excludedPrefix}`, `:(exclude)${excludedPrefix}/**`] : [];
    let head: Buffer; try { head = git(["rev-parse", "--verify", "HEAD"]); } catch { head = Buffer.from("UNBORN-HEAD\n"); }
    const working = git(["diff", "--binary", "--no-ext-diff", ...pathspec]);
    const staged = git(["diff", "--cached", "--binary", "--no-ext-diff", ...pathspec]);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter((path) => path && (!excludedPrefix || path !== excludedPrefix && !path.startsWith(`${excludedPrefix}/`))).sort();
    const digest = createHash("sha256").update(head).update(working).update(staged); let total = head.length + working.length + staged.length;
    for (const relativePath of untracked) {
      if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) throw new ValidationError("repository state contains an unsafe path");
      const path = resolve(root, relativePath); const stat = lstatSync(path); if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path); total += Buffer.byteLength(relativePath) + content.length;
      if (total > stateLimit) throw new ValidationError("repository state exceeds 32 MB"); digest.update(relativePath).update("\0").update(content).update("\0");
    }
    return `sha256:${digest.digest("hex")}`;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`cannot fingerprint repository state: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}
