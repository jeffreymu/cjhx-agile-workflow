import assert from "node:assert/strict";
import test from "node:test";
import { AdapterError, PolicyDenied } from "../src/errors.js";
import { ToolBroker, type JiraAdapter } from "../src/adapters.js";

const jira: JiraAdapter = {
  getIssue: (key) => ({ key }),
  createIssue: (fields) => fields,
  updateIssue: (key, fields) => ({ key, ...fields }),
  transitionIssue: (key, state) => ({ key, state }),
};

test("tool broker enforces manifest permissions", async () => {
  const broker = new ToolBroker({ jira });
  await assert.rejects(broker.execute({ tool: "jira.issue.read", arguments: { key: "PAY-1" } }, new Set()), PolicyDenied);
  const result = await broker.execute({ tool: "jira.issue.read", arguments: { key: "PAY-1" } }, new Set(["jira.issue.read"]));
  assert.equal((result.result as { key: string }).key, "PAY-1");
});

test("tool broker fails closed when adapter is missing", async () => {
  const broker = new ToolBroker();
  await assert.rejects(broker.execute({ tool: "devops.validation.read", arguments: { runId: "1" } }, new Set(["devops.validation.read"])), AdapterError);
});
