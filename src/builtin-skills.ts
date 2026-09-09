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
  const request = requestObject(payload); const feature = typeof request.feature === "string" ? request.feature.trim() : "";
  if (!feature) throw new SkillError("feature is required");
  const criteria = Array.isArray(request.acceptanceCriteria) ? request.acceptanceCriteria : [];
  const cases = criteria.map((item, index) => ({ id: `TC-${String(index + 1).padStart(3, "0")}`, type: "acceptance", given: "系统可用且测试数据已准备", when: String(item), then: `满足验收标准：${String(item)}` }));
  cases.push({ id: `TC-${String(cases.length + 1).padStart(3, "0")}`, type: "boundary", given: "输入处于允许范围边界", when: `执行 ${feature}`, then: "系统返回明确且可验证的结果" });
  return { output: { feature, testCases: cases, knowledgeSourcesUsed: knowledgeSourceCount(payload), previous: payload.previous ?? null }, evidence: [], operations: [] };
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
  const request = requestObject(payload); const changeId = request.changeId; const suiteRef = request.suiteRef; const environment = request.environment;
  if (typeof changeId !== "string" || typeof suiteRef !== "string" || typeof environment !== "string" || !changeId || !suiteRef || !environment) {
    throw new SkillError("changeId, suiteRef, and environment are required");
  }
  return { output: { status: "validation-requested", changeId, knowledgeSourcesUsed: knowledgeSourceCount(payload), previous: payload.previous ?? null }, evidence: [], operations: [{ tool: "devops.validation.trigger", arguments: { request: { changeId, validationType: "api", suiteRef, environment, subjectRef: request.subjectRef ?? null } } }] };
};

function requestObject(payload: JsonObject): JsonObject { const request = payload.request; return typeof request === "object" && request !== null && !Array.isArray(request) ? request : payload; }
function knowledgeSourceCount(payload: JsonObject): number { return Array.isArray(payload.knowledge) ? payload.knowledge.length : 0; }
const defectAnalyze: BuiltinHandler = (payload) => { const request = requestObject(payload); const defect = String(request.defect ?? request.description ?? "").trim(); if (!defect) throw new SkillError("defect or description is required"); return { output: { summary: `已分析缺陷：${defect}`, likelyCauses: ["待结合执行结果与日志验证"], knowledgeSourcesUsed: knowledgeSourceCount(payload), previous: payload.previous ?? null }, evidence: [], operations: [] }; };
const logAnalyze: BuiltinHandler = (payload) => { const request = requestObject(payload); const logs = String(request.logs ?? "").trim(); if (!logs) throw new SkillError("logs is required"); const errorLines = logs.split("\n").filter((line) => /error|exception|fail/i.test(line)); return { output: { summary: `发现 ${errorLines.length} 条异常日志`, errorLines: errorLines.slice(0, 50), knowledgeSourcesUsed: knowledgeSourceCount(payload), previous: payload.previous ?? null }, evidence: [], operations: [] }; };
const sqlAnalyze: BuiltinHandler = (payload) => { const request = requestObject(payload); const sql = String(request.sql ?? "").trim(); if (!sql) throw new SkillError("sql is required"); const findings: JsonObject[] = []; if (/select\s+\*/i.test(sql)) findings.push({ severity: "warning", rule: "avoid-select-star" }); if (!/\bwhere\b/i.test(sql) && /\b(update|delete)\b/i.test(sql)) findings.push({ severity: "blocker", rule: "mutation-without-where" }); return { output: { summary: `${findings.length} 个 SQL 风险`, findings, knowledgeSourcesUsed: knowledgeSourceCount(payload), previous: payload.previous ?? null }, evidence: [], operations: [] }; };
const testReportGenerate: BuiltinHandler = (payload) => { const request = requestObject(payload); return { output: { title: String(request.title ?? "AI 测试报告"), status: "generated", summary: String(request.summary ?? "已汇总测试流程输入和上一步结果"), previous: payload.previous ?? null, knowledgeSourcesUsed: knowledgeSourceCount(payload) }, evidence: [], operations: [] }; };

export const builtins: Record<string, BuiltinHandler> = { requirement_decompose: requirementDecompose, test_case_generate: testCaseGenerate, jira_confluence_sync: jiraConfluenceSync, code_review: codeReview, api_test_execute: apiTestExecute, test_defect_analyze: defectAnalyze, test_log_analyze: logAnalyze, test_sql_analyze: sqlAnalyze, test_report_generate: testReportGenerate };
