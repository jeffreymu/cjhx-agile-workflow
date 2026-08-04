import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { CJHXFramework } from "../src/framework.js";
import { Policy } from "../src/policy.js";

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-local-skills-")); const catalog = resolve(root, "catalog"); mkdirSync(catalog);
  const instructions = resolve(catalog, "review-guide"); mkdirSync(instructions); writeFileSync(resolve(instructions, "SKILL.md"), `---\nname: review-guide\ndescription: >\n  Review changes against\n  repository standards.\n---\n\n# Review Guide\n`);
  const executable = resolve(catalog, "api-tests"); cpSync(resolve(process.cwd(), "examples/skills/api-test-generate"), executable, { recursive: true });
  const app = new CJHXFramework(resolve(root, ".cjhx"), { policy: new Policy({ allowProcessSkills: true }), localSkillRoots: [catalog] }); app.initialize();
  return { root, catalog, instructions, executable, app };
}

test("scans local CJHX packages and Agent instruction skills without following directory symlinks", (t) => {
  const { root, catalog, app, instructions, executable } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = resolve(root, "outside"); mkdirSync(outside); writeFileSync(resolve(outside, "SKILL.md"), "---\nname: outside\ndescription: must not be scanned\n---\n"); symlinkSync(outside, resolve(catalog, "linked-outside"));
  const skills = app.localSkills.scan(); assert.equal(skills.length, 2);
  const guide = skills.find((item) => item.kind === "agent-instructions"); const runtime = skills.find((item) => item.kind === "cjhx-package");
  assert.equal(guide?.name, "review-guide"); assert.equal(guide?.description, "Review changes against repository standards."); assert.equal(guide?.path, realpathSync(instructions)); assert.equal(guide?.enabled, false);
  assert.equal(runtime?.skillId, "api-test.generate"); assert.equal(runtime?.version, "1.0.0"); assert.equal(runtime?.path, realpathSync(executable)); assert.equal(runtime?.enabled, false);
});

test("enables and disables discovered skills without deleting their source", async (t) => {
  const { root, app, instructions, executable } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  let skills = app.localSkills.scan(); const guide = skills.find((item) => item.kind === "agent-instructions")!; const runtime = skills.find((item) => item.kind === "cjhx-package")!;
  app.localSkills.enable(guide.id); app.localSkills.enable(runtime.id);
  skills = app.localSkills.scan(); assert.equal(skills.every((item) => item.enabled), true); assert.equal(app.registry.list()[0]?.id, "api-test.generate");
  assert.deepEqual(app.localSkills.enabledAgentSkills(), [{ name: "review-guide", description: "Review changes against repository standards.", path: resolve(realpathSync(instructions), "SKILL.md") }]);
  assert.equal(statSync(resolve(root, ".cjhx/local-skills.json")).mode & 0o777, 0o600);
  const run = await app.runSkill("api-test.generate", { operation: { method: "GET", path: "/orders" } }); assert.equal(run.status, "succeeded");
  app.localSkills.disable(guide.id); app.localSkills.disable(runtime.id); assert.equal(app.localSkills.scan().every((item) => !item.enabled), true);
  assert.equal(app.registry.list().length, 0); assert.equal(existsSync(instructions), true); assert.equal(existsSync(executable), true);
});

test("changed Agent instructions require explicit re-enablement", (t) => {
  const { root, app, instructions } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true })); const guide = app.localSkills.scan().find((item) => item.kind === "agent-instructions")!;
  app.localSkills.enable(guide.id); assert.equal(app.localSkills.scan().find((item) => item.id === guide.id)?.enabled, true);
  writeFileSync(resolve(instructions, "SKILL.md"), "---\nname: review-guide\ndescription: changed instructions\n---\n"); assert.equal(app.localSkills.scan().find((item) => item.id === guide.id)?.enabled, false); assert.deepEqual(app.localSkills.enabledAgentSkills(), []);
  app.localSkills.enable(guide.id); assert.equal(app.localSkills.scan().find((item) => item.id === guide.id)?.enabled, true);
});

test("enabled Agent instruction skills are included in task prompts", async (t) => {
  const { root, app } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = resolve(root, "repository"); mkdirSync(repository); execFileSync("git", ["init", "-b", "main", repository]);
  const script = resolve(root, "agent.mjs"); writeFileSync(script, `if(process.argv.includes("--version")){console.log("agent 1");process.exit(0)}console.log(process.argv.at(-1));`); chmodSync(script, 0o700);
  const workspace = app.workspaceHub.addLocal({ path: repository }); const change = app.createChange("SKILL-1", "Use local skill", "developer", { workspaceId: workspace.id }); const task = app.createTask({ changeId: change.id, workspaceId: workspace.id, title: "Review implementation" });
  const guide = app.localSkills.scan().find((item) => item.kind === "agent-instructions")!; app.localSkills.enable(guide.id);
  await app.agents.save({ id: "agent", name: "Agent", kind: "custom", command: process.execPath, arguments: [script, "{prompt}"], versionArguments: [script, "--version"], promptTransport: "argument", timeoutMinutes: 1 }, { approved: true });
  const run = app.startAgentForTask(task.id, { approved: true }); await new Promise((accept) => setTimeout(accept, 80)); const completed = app.agents.getRun(run.id);
  assert.match(completed.stdout, /Enabled local CJHX Agent skills/); assert.match(completed.stdout, /review-guide/); assert.match(completed.stdout, /SKILL\.md/);
});
