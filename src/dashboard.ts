import type { AgentRun } from "./agents.js";
import type { AutomationFinding, AutomationReport, AutomationRun } from "./automations.js";
import type { GoalPortfolio } from "./goals.js";
import type { Change } from "./models.js";
import type { Task } from "./tasks.js";

export interface DashboardAgentRun { id: string; taskId: string; changeId: string; workspaceId: string; agentId: string; agentName: string; status: AgentRun["status"]; startedAt: string }
export interface DashboardProjection {
  generatedAt: string;
  kpis: { activeGoals: number; atRiskGoals: number; blockedTasks: number; pendingAttention: number };
  goals: GoalPortfolio["goals"];
  attention: Array<{ kind: "goal" | "task" | "automation" | "harness"; severity: "critical" | "high" | "medium"; title: string; description: string; referenceId: string }>;
  running: { agents: DashboardAgentRun[]; automations: AutomationRun[] };
  engineeringHealth: { latestReport?: AutomationReport; openFindings: AutomationFinding[]; staleReports: number };
  activity: Array<{ kind: string; title: string; at: string; referenceId: string }>;
}

interface DashboardDependencies {
  goals(): GoalPortfolio; changes(): Change[]; tasks(): Task[]; agentRuns(): AgentRun[]; automationRuns(): AutomationRun[];
  automationReports(): Array<AutomationReport & { stale?: boolean }>; findings(): AutomationFinding[];
}

export class DashboardService {
  constructor(private readonly dependencies: DashboardDependencies) {}
  view(): DashboardProjection {
    const portfolio = this.dependencies.goals(); const tasks = this.dependencies.tasks(); const agentRuns = this.dependencies.agentRuns(); const automationRuns = this.dependencies.automationRuns(); const reports = this.dependencies.automationReports(); const findings = this.dependencies.findings().filter((item) => item.lifecycle !== "resolved");
    const attention: DashboardProjection["attention"] = [];
    for (const item of portfolio.goals.filter((goal) => goal.goal.status === "active" && (goal.health === "off-track" || goal.health === "at-risk" || goal.health === "unknown")).slice(0, 8)) attention.push({ kind: "goal", severity: item.health === "off-track" ? "critical" : item.health === "at-risk" ? "high" : "medium", title: item.goal.title, description: item.health === "unknown" ? "缺少足够的成功标准进展事实" : `目标健康状态为 ${item.health}`, referenceId: item.goal.id });
    for (const task of tasks.filter((item) => item.status === "blocked").slice(0, 8)) attention.push({ kind: "task", severity: "high", title: task.title, description: `${task.changeId} · ${task.owner || "未分配 Owner"}`, referenceId: task.id });
    for (const report of reports.filter((item) => item.stale).slice(0, 4)) attention.push({ kind: "automation", severity: "medium", title: "工程审计报告已过期", description: report.deterministicSummary, referenceId: report.id });
    const activity: DashboardProjection["activity"] = [
      ...agentRuns.filter((item) => item.completedAt).map((item) => ({ kind: "agent", title: `${item.agentName} ${item.status === "succeeded" ? "完成" : "结束"} Task ${item.taskId}`, at: item.completedAt!, referenceId: item.id })),
      ...automationRuns.filter((item) => item.completedAt).map((item) => ({ kind: "automation", title: `工程审计运行 ${item.status}`, at: item.completedAt!, referenceId: item.reportId ?? item.id })),
      ...this.dependencies.changes().map((item) => ({ kind: "change", title: `${item.id} · ${item.title}`, at: item.updatedAt, referenceId: item.id })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
    const pendingAttention = portfolio.goals.filter((goal) => goal.goal.status === "active" && ["unknown", "at-risk", "off-track"].includes(goal.health)).length + tasks.filter((item) => item.status === "blocked").length + reports.filter((item) => item.stale).length;
    return { generatedAt: new Date().toISOString(), kpis: { activeGoals: portfolio.counts.statuses.active, atRiskGoals: portfolio.counts.health["at-risk"] + portfolio.counts.health["off-track"], blockedTasks: tasks.filter((item) => item.status === "blocked").length, pendingAttention }, goals: portfolio.goals.filter((item) => item.goal.status === "active").slice(0, 6), attention: attention.slice(0, 12), running: { agents: agentRuns.filter((item) => item.status === "running").map(({ id, taskId, changeId, workspaceId, agentId, agentName, status, startedAt }) => ({ id, taskId, changeId, workspaceId, agentId, agentName, status, startedAt })), automations: automationRuns.filter((item) => item.status === "running") }, engineeringHealth: { ...(reports[0] ? { latestReport: reports[0] } : {}), openFindings: findings.slice(0, 8), staleReports: reports.filter((item) => item.stale).length }, activity };
  }
}
