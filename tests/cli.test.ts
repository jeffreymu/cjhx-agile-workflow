import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = process.cwd();
const compiledCli = resolve(projectRoot, "dist/src/cli.js");

test("CLI executes when launched through a package-manager style symlink", (t) => {
  const temporary = mkdtempSync(resolve(tmpdir(), "cjhx-cli-")); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bin = resolve(temporary, "cjhx"); const workspace = resolve(temporary, "workspace");
  symlinkSync(compiledCli, bin);
  const result = spawnSync(process.execPath, [bin, "--workspace", workspace, "init"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status": "initialized"/);
  assert.equal(existsSync(resolve(workspace, "skills-lock.json")), true);
});
