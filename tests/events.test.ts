import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ValidationError } from "../src/errors.js";
import { createEvent, EventInbox } from "../src/events.js";
import { Workspace } from "../src/storage.js";

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "cjhx-event-"));
  const inbox = new EventInbox(new Workspace(resolve(root, ".cjhx")));
  const event = createEvent({ eventId: "evt-1", eventType: "devops.validation.completed", source: "devops", changeId: "PAY-128", correlationId: "corr-1", payload: { runId: "run-1" }, occurredAt: "2025-03-08T10:00:00.000Z" });
  return { root, inbox, event };
}

test("duplicate event is idempotent", (t) => {
  const { root, inbox, event } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(inbox.accept(event), true);
  assert.equal(inbox.accept(event), false);
});

test("reused event id with different content is rejected", (t) => {
  const { root, inbox, event } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  inbox.accept(event);
  const conflict = { ...event, eventType: "devops.validation.failed" };
  assert.throws(() => inbox.accept(conflict), ValidationError);
});

test("event id cannot escape workspace", () => {
  assert.throws(() => createEvent({ eventId: "../escape", eventType: "test", source: "test", changeId: "PAY-128", correlationId: "corr", payload: {} }), ValidationError);
});
