import { SkillError } from "./errors.js";
import type { JsonObject } from "./models.js";

export interface SkillResponse { output: JsonObject; evidence: JsonObject[]; operations: { tool: string; arguments: JsonObject }[] }
export type BuiltinHandler = (payload: JsonObject) => SkillResponse;

const requirementDecompose: BuiltinHandler = (payload) => {
  const requirement = typeof payload.requirement === "string" ? payload.requirement.trim() : "";
  if (!requirement) throw new SkillError("requirement is required");
  const fragments = requirement.split(/[。；;\n]+/).map((item) => item.trim()).filter(Boolean);
  return { output: { summary: `需求已拆分为 ${fragments.length} 个可跟踪任务`, tasks: fragments.map((title, index) => ({ id: `TASK-${String(index + 1).padStart(2, "0")}`, title, acceptanceCriteria: [`已验证：${title}`], dependencies: [] })) }, evidence: [], operations: [] };
};

const testCaseGenerate: BuiltinHandler = (payload) => {
  const feature = typeof payload.feature === "string" ? payload.feature.trim() : "";
  if (!feature) throw new SkillError("feature is required");
  const criteria = Array.isArray(payload.acceptanceCriteria) ? payload.acceptanceCriteria : [];
  const cases = criteria.map((item, index) => ({ id: `TC-${String(index + 1).padStart(3, "0")}`, type: "acceptance", given: "系统可用且测试数据已准备", when: String(item), then: `满足验收标准：${String(item)}` }));
  cases.push({ id: `TC-${String(cases.length + 1).padStart(3, "0")}`, type: "boundary", given: "输入处于允许范围边界", when: `执行 ${feature}`, then: "系统返回明确且可验证的结果" });
  return { output: { feature, testCases: cases }, evidence: [], operations: [] };
};

const jiraConfluenceSync: BuiltinHandler = (payload) => {
  const issue = payload.issue;
  if (typeof issue !== "object" || issue === null || Array.isArray(issue) || typeof issue.key !== "string" || typeof issue.summary !== "string") throw new SkillError("issue with key and summary is required");
  return { output: { sync: "draft-requested", changeId: issue.key }, evidence: [], operations: [{ tool: "confluence.page.create-draft", arguments: { page: { changeId: issue.key, title: `${issue.key} ${issue.summary}`, body: issue.description ?? "", source: `jira://${issue.key}` } } }] };
};

const codeReview: BuiltinHandler = (payload) => {
  if (!Array.isArray(payload.changedFiles)) throw new SkillError("changedFiles must be an array");
  const findings: JsonObject[] = [];
  const rules: [string, string, string, string][] = [["TODO", "minor", "maintainability", "变更中包含未完成的 TODO"], ["eval(", "blocker", "security", "避免执行未经验证的动态代码"], ["password =", "blocker", "security", "疑似硬编码凭据"]];
  for (const raw of payload.changedFiles) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const path = String(raw.path ?? "unknown"); const content = String(raw.content ?? raw.diff ?? "");
    content.split("\n").forEach((line, index) => rules.forEach(([marker, severity, category, description]) => { if (line.toLowerCase().includes(marker.toLowerCase())) findings.push({ severity, category, file: path, line: index + 1, description, evidence: line.trim().slice(0, 200), confidence: 0.9 }); }));
  }
  return { output: { decision: findings.some((item) => item.severity === "blocker") ? "request-changes" : "comment", findings }, evidence: [], operations: [] };
};

const apiTestExecute: BuiltinHandler = (payload) => {
  const changeId = payload.changeId;
  const suiteRef = payload.suiteRef;
  const environment = payload.environment;
  if (typeof changeId !== "string" || typeof suiteRef !== "string" || typeof environment !== "string" || !changeId || !suiteRef || !environment) {
    throw new SkillError("changeId, suiteRef, and environment are required");
  }
  return { output: { status: "validation-requested", changeId }, evidence: [], operations: [{ tool: "devops.validation.trigger", arguments: { request: { changeId, validationType: "api", suiteRef, environment, subjectRef: payload.subjectRef ?? null } } }] };
};

export const builtins: Record<string, BuiltinHandler> = { requirement_decompose: requirementDecompose, test_case_generate: testCaseGenerate, jira_confluence_sync: jiraConfluenceSync, code_review: codeReview, api_test_execute: apiTestExecute };
