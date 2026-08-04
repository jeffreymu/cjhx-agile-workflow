import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("CLI validates Harness engineering rule bundles fail closed", (t) => {
  const temporary = mkdtempSync(resolve(tmpdir(), "cjhx-cli-harness-")); t.after(() => rmSync(temporary, { recursive: true, force: true })); const valid = resolve(temporary, "valid.json"); const invalid = resolve(temporary, "invalid.json");
  writeFileSync(valid, JSON.stringify({ schemaVersion: 1, id: "engineering", version: "1.0.0", scope: "workspace", mode: "enforce", rules: [{ id: "quality", description: "Run checks", requiredChecks: ["npm.check"] }] })); writeFileSync(invalid, JSON.stringify({ schemaVersion: 1, id: "engineering", version: "1.0.0", scope: "workspace", mode: "enforce", rules: [{ id: "quality", description: "Run checks", requiredChecks: ["shell.anything"] }] }));
  const accepted = spawnSync(process.execPath, [compiledCli, "harness-validate", valid], { encoding: "utf8" }); assert.equal(accepted.status, 0, accepted.stderr); assert.match(accepted.stdout, /"valid": true/);
  const rejected = spawnSync(process.execPath, [compiledCli, "harness-validate", invalid], { encoding: "utf8" }); assert.equal(rejected.status, 2); assert.match(rejected.stderr, /unknown Harness check/i);
});
