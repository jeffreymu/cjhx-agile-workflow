import assert from "node:assert/strict";
import { lstatSync, symlinkSync } from "node:fs";
import type { TestContext } from "node:test";

/** POSIX modes are not NTFS ACLs. Windows checks existence/type, not privacy. */
export function assertPrivateMode(path: string, mode: number): void {
  const info = lstatSync(path);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(mode === 0o700 ? info.isDirectory() : info.isFile(), true);
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, mode);
}

/** Only file links need Windows Developer Mode/admin. Directory tests use junctions. */
export function fileSymlink(t: TestContext, target: string, path: string): boolean {
  try { symlinkSync(target, path, "file"); return true; } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("File symlinks require Windows Developer Mode or administrator privileges; link rejection not verified");
      return false;
    }
    throw error;
  }
}
