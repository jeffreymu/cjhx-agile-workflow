import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import test from "node:test";
import { localCheckProcess } from "../src/local-check-process.js";

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "cjhx-npm launch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = resolve(root, "repo"); mkdirSync(repo);
  const installation = resolve(root, "Node 安装 & tools"); mkdirSync(installation);
  const entry = (directory: string) => {
    const bin = resolve(directory, "node_modules/npm/bin"); mkdirSync(bin, { recursive: true });
    const path = resolve(bin, "npm-cli.js"); writeFileSync(path, "console.log(JSON.stringify(process.argv.slice(2)))"); return path;
  };
  return { root, repo, installation, entry };
}

test("Windows local checks use Node argv, preserve required OS env and omit credentials", (t) => {
  const { repo, installation, entry } = fixture(t); const npm = entry(installation);
  const launch = localCheckProcess(repo, "win32", { Path: `"${installation}"`, SYSTEMROOT: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", TEMP: "temp", TMP: "tmp", USERPROFILE: "user", PATHEXT: ".EXE;.CMD", SECRET_TOKEN: "not-forwarded", NODE_OPTIONS: "not-forwarded" }, process.execPath);
  assert.equal(launch.command, process.execPath);
  // A standard npm beside Node takes priority when installed on the test host.
  assert.equal(launch.arguments.length, 1); assert.ok(launch.arguments[0]!.endsWith("npm-cli.js"));
  assert.equal(launch.environment.SystemRoot, "C:\\Windows"); assert.equal(launch.environment.SECRET_TOKEN, undefined); assert.equal(launch.environment.NODE_OPTIONS, undefined);
  // Force the synthetic installation to prove spaces, Unicode and '&' stay argv, not shell text.
  const synthetic = localCheckProcess(repo, "win32", { PATH: installation }, resolve(installation, "node.exe"));
  assert.deepEqual(synthetic.arguments, [npm]);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [...synthetic.arguments, "run", "typecheck"], { encoding: "utf8", shell: false })), ["run", "typecheck"]);
});

test("Windows npm lookup rejects repo-local and relative PATH candidates without shell fallback", (t) => {
  const { root, repo, entry } = fixture(t); entry(repo);
  assert.throws(() => localCheckProcess(repo, "win32", { PATH: [repo, ".", "relative"].join(delimiter) }, resolve(root, "missing/node.exe")), /Cannot locate npm-cli/);
});

test("Windows npm lookup rejects external junctions resolving into the execution repository", (t) => {
  const { root, repo, entry } = fixture(t); entry(repo); const alias = resolve(root, "external-alias");
  symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => localCheckProcess(repo, "win32", { PATH: alias }, resolve(root, "missing/node.exe")), /Cannot locate npm-cli/);
});

test("non-Windows local checks preserve npm catalog launch and minimal environment", () => {
  const launch = localCheckProcess("/unused", "linux", { PATH: "/usr/bin", HOME: "/home/test", TMPDIR: "/tmp/test", SECRET_TOKEN: "hidden" });
  assert.equal(launch.command, "npm"); assert.deepEqual(launch.arguments, []);
  assert.deepEqual(launch.environment, { PATH: "/usr/bin", HOME: "/home/test", LANG: "C.UTF-8", TMPDIR: "/tmp/test" });
});
