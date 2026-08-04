import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryDevOpsAdapter, ToolBroker } from "../src/adapters.js";
import { DevOpsService } from "../src/devops.js";
import { PolicyDenied } from "../src/errors.js";

function fixture() {
  const adapter = new InMemoryDevOpsAdapter();
  adapter.pipelines.set("pay-ci", { id: "pay-ci", name: "支付服务 CI", kind: "ci", changeId: "PAY-1", status: "healthy" });
  adapter.pipelines.set("other-ci", { id: "other-ci", name: "其他 CI", kind: "ci", changeId: "OTHER", status: "healthy" });
  adapter.pipelineRuns.set("run-1", { runId: "run-1", pipelineId: "pay-ci", changeId: "PAY-1", status: "succeeded", startedAt: "2025-03-08T10:00:00.000Z" });
  adapter.artifacts.set("artifact-1", { artifactId: "artifact-1", name: "payment-api", version: "1.4.0", changeId: "PAY-1", status: "ready", createdAt: "2025-03-08T10:10:00.000Z" });
  adapter.services.set("payment-api", { id: "payment-api", name: "支付服务", environment: "test", changeId: "PAY-1", status: "running", version: "1.4.0" });
  return { adapter, service: new DevOpsService(new ToolBroker({ devops: adapter })) };
}

test("DevOps overview projects pipeline, artifact, run, and service state", async () => {
  const { service } = fixture(); const overview = await service.overview("PAY-1");
  assert.equal(overview.pipelines.length, 1); assert.equal(overview.runs.length, 1); assert.equal(overview.artifacts.length, 1); assert.equal(overview.services.length, 1);
});

test("DevOps pipeline and service writes require explicit approval", async () => {
  const { adapter, service } = fixture();
  await assert.rejects(service.triggerPipeline({ pipelineId: "pay-ci", kind: "ci", actor: "release-owner", reason: "validate", approved: false }), PolicyDenied);
  const run = await service.triggerPipeline({ pipelineId: "pay-ci", kind: "ci", changeId: "PAY-1", ref: "main", actor: "release-owner", reason: "validate", approved: true }); assert.equal(run.status, "running"); assert.equal(adapter.pipelineRuns.size, 2);
  await assert.rejects(service.controlService({ serviceId: "payment-api", action: "stop", actor: "operator", reason: "maintenance", approved: false }), PolicyDenied);
  const stopped = await service.controlService({ serviceId: "payment-api", action: "stop", actor: "operator", reason: "maintenance", approved: true }); assert.equal(stopped.status, "stopped");
});
