import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { TransitionError, ValidationError } from "../src/errors.js";
import { CJHXFramework } from "../src/framework.js";

function fixture(): { app: CJHXFramework; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-lifecycle-"));
  const app = new CJHXFramework(resolve(root, ".cjhx"));
  app.createChange("PAY-128", "批量取消订单", "product-owner");
  return { app, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("transition requires typed evidence", (t) => {
  const { app, cleanup } = fixture(); t.after(cleanup);
  assert.throws(() => app.transitionChange("PAY-128", "intent_confirmed", { actor: "owner", reason: "confirmed" }), (error) => error instanceof TransitionError && error.message.includes("intent-approval"));
  app.addEvidence("PAY-128", { kind: "intent-approval", source: "jira", status: "approved", subjectRef: "jira://PAY-128" });
  const changed = app.transitionChange("PAY-128", "intent_confirmed", { actor: "owner", reason: "confirmed" });
  assert.equal(changed.state, "intent_confirmed");
  assert.equal(changed.history.at(-1)?.actor, "owner");
});

test("invalid lifecycle transition is rejected", (t) => {
  const { app, cleanup } = fixture(); t.after(cleanup);
  assert.throws(() => app.transitionChange("PAY-128", "implementing", { actor: "agent", reason: "skip", enforceGates: false }), TransitionError);
});

test("duplicate change does not overwrite existing state", (t) => {
  const { app, cleanup } = fixture(); t.after(cleanup);
  assert.throws(() => app.createChange("PAY-128", "覆盖", "other"), ValidationError);
  assert.equal(app.workspace.getChange("PAY-128").title, "批量取消订单");
});

test("change id cannot escape workspace", (t) => {
  const { app, cleanup } = fixture(); t.after(cleanup);
  assert.throws(() => app.createChange("../escape", "非法", "owner"), ValidationError);
});
