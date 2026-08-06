import { createHash, randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";
import { utcNow, type Change } from "./models.js";
import type { Workspace } from "./storage.js";
import type { Task } from "./tasks.js";
import type { ManagedWorkspace } from "./workspace-hub.js";
import type { AutomationFinding } from "./automations.js";

export const goalStatuses = ["draft", "proposed", "active", "achieved", "abandoned", "archived"] as const;
export type GoalStatus = typeof goalStatuses[number];
export const goalPriorities = ["low", "medium", "high", "critical"] as const;
export type GoalPriority = typeof goalPriorities[number];
export const goalHealthStatuses = ["unknown", "on-track", "at-risk", "off-track", "achieved"] as const;
export type GoalHealth = typeof goalHealthStatuses[number];
export const goalCriterionTypes = ["metric", "milestone", "evidence"] as const;
export type GoalCriterionType = typeof goalCriterionTypes[number];
export const goalCriterionStatuses = ["unknown", "on-track", "at-risk", "met"] as const;
export type GoalCriterionStatus = typeof goalCriterionStatuses[number];
export const goalSourceKinds = ["jira", "confluence", "devops", "source-control", "manual-evidence"] as const;
export type GoalSourceKind = typeof goalSourceKinds[number];

export interface GoalCriterion {
  id: string; name: string; type: GoalCriterionType; status: GoalCriterionStatus;
  baseline?: number; current?: number; target?: number; unit?: string; direction?: "increase" | "decrease" | "maintain";
  source: GoalSourceKind; sourceRef?: string; verificationDescription: string; observedAt?: string;
}
export interface GoalSourceReference { kind: GoalSourceKind; id: string; uri?: string }
export interface Goal {
  schemaVersion: 1; id: string; workspaceId: string; title: string; statement: string; rationale: string; owner: string;
  status: GoalStatus; priority: GoalPriority; successCriteria: GoalCriterion[]; inScope: string[]; outOfScope: string[];
  constraints: string[]; sourceRefs: GoalSourceReference[]; linkedChangeIds: string[]; targetDate?: string; reviewCadence?: string;
  currentSnapshotId: string; currentSnapshotDigest: string; createdAt: string; updatedAt: string; activatedAt?: string; achievedAt?: string;
}
export interface GoalSnapshot { schemaVersion: 1; id: string; digest: string; goalId: string; reason: "created" | "updated" | "activated" | "status-changed"; goal: Omit<Goal, "currentSnapshotId" | "currentSnapshotDigest">; createdAt: string }
export interface GoalAssessment {
  goal: Goal; health: GoalHealth; readiness: { ready: boolean; issues: string[] }; linkedChanges: Change[]; linkedTasks: Task[];
  findings: AutomationFinding[]; criteria: GoalCriterion[]; progress: { met: number; total: number }; assessedAt: string;
}
export interface GoalPortfolio { goals: GoalAssessment[]; counts: { statuses: Record<GoalStatus, number>; health: Record<GoalHealth, number> } }

interface GoalDependencies { workspace(id: string): ManagedWorkspace; changes(): Change[]; tasks(): Task[]; findings(): AutomationFinding[] }
export type GoalCriterionInput = Omit<GoalCriterion, "id" | "status"> & { id?: string; status?: GoalCriterionStatus };
export interface GoalInput {
  workspaceId: string; title: string; statement: string; rationale?: string; owner: string; priority?: GoalPriority;
  successCriteria: GoalCriterionInput[]; inScope?: string[]; outOfScope?: string[]; constraints?: string[];
  sourceRefs?: GoalSourceReference[]; linkedChangeIds?: string[]; targetDate?: string; reviewCadence?: string;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function required(value: unknown, key: string, max = 500): string { if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${key} is required`); const result = value.trim(); if (result.length > max) throw new ValidationError(`${key} exceeds ${max} characters`); return result; }
function strings(value: string[] | undefined, key: string): string[] { const result = (value ?? []).map((item) => required(item, key, 1000)); if (result.length > 50) throw new ValidationError(`${key} exceeds 50 entries`); return [...new Set(result)]; }
function validDate(value: string | undefined): string | undefined { if (!value) return undefined; if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError("targetDate must use YYYY-MM-DD"); const parsed = new Date(`${value}T00:00:00Z`); if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ValidationError("targetDate must be a valid calendar date"); return value; }

export class GoalService {
  constructor(readonly storage: Workspace, private readonly dependencies: GoalDependencies) {}
  list(): Goal[] { return this.storage.listGoals<Goal>().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string): Goal { return this.storage.getGoal<Goal>(id); }
  snapshots(goalId?: string): GoalSnapshot[] { return this.storage.listGoalSnapshots<GoalSnapshot>().filter((item) => !goalId || item.goalId === goalId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  getSnapshot(id: string): GoalSnapshot { return this.storage.getGoalSnapshot<GoalSnapshot>(id); }

  create(input: GoalInput): Goal { const id = `goal-${randomUUID().replaceAll("-", "")}`; const now = utcNow(); const normalized = this.normalize(input); const base = { schemaVersion: 1 as const, id, ...normalized, status: "draft" as const, createdAt: now, updatedAt: now }; return this.persist(base, "created"); }
  update(id: string, input: GoalInput): Goal { const current = this.get(id); if (["achieved", "abandoned", "archived"].includes(current.status)) throw new ValidationError("closed Goal cannot be edited"); const normalized = this.normalize(input); if (current.status === "active" && normalized.workspaceId !== current.workspaceId) throw new ValidationError("active Goal Workspace cannot be changed"); const candidate = { ...current, ...normalized, updatedAt: utcNow() }; if (current.status === "active") { const issues = this.readiness(candidate).issues; if (issues.length) throw new ValidationError(`active Goal update is missing: ${issues.join(", ")}`); } return this.persist(candidate, "updated"); }
  setStatus(id: string, status: GoalStatus): Goal {
    if (!goalStatuses.includes(status)) throw new ValidationError("invalid Goal status"); const current = this.get(id);
    const allowed: Record<GoalStatus, GoalStatus[]> = { draft: ["proposed", "active", "archived"], proposed: ["draft", "active", "archived"], active: ["achieved", "abandoned", "archived"], achieved: ["archived"], abandoned: ["active", "archived"], archived: [] };
    if (!allowed[current.status].includes(status)) throw new ValidationError(`cannot transition Goal from ${current.status} to ${status}`);
    if (status === "active") { const issues = this.readiness(current).issues; if (issues.length) throw new ValidationError(`Goal activation is missing: ${issues.join(", ")}`); }
    if (status === "achieved" && (!current.successCriteria.length || current.successCriteria.some((criterion) => criterion.status !== "met"))) throw new ValidationError("Goal achievement requires every success criterion to be met");
    const now = utcNow(); return this.persist({ ...current, status, updatedAt: now, ...(status === "active" ? { activatedAt: now } : {}), ...(status === "achieved" ? { achievedAt: now } : {}) }, status === "active" ? "activated" : "status-changed");
  }
  remove(id: string): void { const goal = this.get(id); if (goal.status !== "draft") throw new ValidationError("only draft Goals can be deleted"); this.storage.removeGoal(id); }

  assess(id: string): GoalAssessment { return this.assessGoal(this.get(id)); }
  portfolio(): GoalPortfolio {
    const goals = this.list().map((goal) => this.assessGoal(goal)); const statuses = Object.fromEntries(goalStatuses.map((value) => [value, 0])) as Record<GoalStatus, number>; const health = Object.fromEntries(goalHealthStatuses.map((value) => [value, 0])) as Record<GoalHealth, number>;
    for (const item of goals) { statuses[item.goal.status] += 1; health[item.health] += 1; } return { goals, counts: { statuses, health } };
  }

  private normalize(input: GoalInput): Omit<Goal, "schemaVersion" | "id" | "status" | "currentSnapshotId" | "currentSnapshotDigest" | "createdAt" | "updatedAt" | "activatedAt" | "achievedAt"> {
    const workspace = this.dependencies.workspace(required(input.workspaceId, "workspaceId", 200)); const priority = input.priority ?? "medium"; if (!goalPriorities.includes(priority)) throw new ValidationError("invalid Goal priority");
    if (!Array.isArray(input.successCriteria) || input.successCriteria.length > 20) throw new ValidationError("successCriteria must contain at most 20 entries");
    const successCriteria = input.successCriteria.map((item): GoalCriterion => { const type = item.type; const status = item.status ?? "unknown"; const source = item.source; if (!goalCriterionTypes.includes(type)) throw new ValidationError("invalid Goal criterion type"); if (!goalCriterionStatuses.includes(status)) throw new ValidationError("invalid Goal criterion status"); if (!goalSourceKinds.includes(source)) throw new ValidationError("invalid Goal criterion source"); if (item.direction && !["increase", "decrease", "maintain"].includes(item.direction)) throw new ValidationError("invalid Goal criterion direction"); const id = item.id ?? `criterion-${randomUUID().replaceAll("-", "")}`; if (!identifier.test(id)) throw new ValidationError("Goal criterion id contains unsupported characters"); for (const value of [item.baseline, item.current, item.target]) if (value !== undefined && !Number.isFinite(value)) throw new ValidationError("Goal criterion values must be finite numbers"); return { id, name: required(item.name, "criterion name", 200), type, status, ...(item.baseline !== undefined ? { baseline: item.baseline } : {}), ...(item.current !== undefined ? { current: item.current } : {}), ...(item.target !== undefined ? { target: item.target } : {}), ...(item.unit ? { unit: required(item.unit, "criterion unit", 40) } : {}), ...(item.direction ? { direction: item.direction } : {}), source, ...(item.sourceRef ? { sourceRef: required(item.sourceRef, "criterion sourceRef", 500) } : {}), verificationDescription: required(item.verificationDescription, "criterion verification", 1000), ...(item.observedAt ? { observedAt: required(item.observedAt, "criterion observedAt", 100) } : {}) }; });
    if (new Set(successCriteria.map((item) => item.id)).size !== successCriteria.length) throw new ValidationError("Goal criterion ids must be unique");
    const linkedChangeIds = strings(input.linkedChangeIds, "linkedChangeIds"); for (const changeId of linkedChangeIds) { const change = this.dependencies.changes().find((item) => item.id === changeId); if (!change) throw new ValidationError(`Goal Change does not exist: ${changeId}`); if (change.workspaceId !== workspace.id) throw new ValidationError("Goal Change must belong to the Goal Workspace"); }
    if ((input.sourceRefs ?? []).length > 50) throw new ValidationError("Goal sourceRefs exceeds 50 entries"); const sourceRefs = (input.sourceRefs ?? []).map((item) => { if (!goalSourceKinds.includes(item.kind)) throw new ValidationError("invalid Goal source kind"); return { kind: item.kind, id: required(item.id, "source id", 500), ...(item.uri ? { uri: required(item.uri, "source uri", 2000) } : {}) }; });
    return { workspaceId: workspace.id, title: required(input.title, "Goal title", 200), statement: required(input.statement, "Goal statement", 2000), rationale: input.rationale?.trim().slice(0, 4000) ?? "", owner: required(input.owner, "Goal owner", 200), priority, successCriteria, inScope: strings(input.inScope, "inScope"), outOfScope: strings(input.outOfScope, "outOfScope"), constraints: strings(input.constraints, "constraints"), sourceRefs, linkedChangeIds, ...(validDate(input.targetDate) ? { targetDate: input.targetDate } : {}), ...(input.reviewCadence?.trim() ? { reviewCadence: required(input.reviewCadence, "reviewCadence", 100) } : {}) };
  }
  private readiness(goal: Goal): GoalAssessment["readiness"] { const issues: string[] = []; if (!goal.workspaceId) issues.push("Workspace"); if (!goal.owner) issues.push("Owner"); if (!goal.successCriteria.length) issues.push("at least one success criterion"); for (const criterion of goal.successCriteria) { if (!criterion.verificationDescription) issues.push(`${criterion.name} verification`); if (!criterion.source) issues.push(`${criterion.name} source`); } return { ready: issues.length === 0, issues }; }
  private assessGoal(goal: Goal): GoalAssessment {
    const linkedChanges = this.dependencies.changes().filter((change) => goal.linkedChangeIds.includes(change.id)); const linkedTasks = this.dependencies.tasks().filter((task) => goal.linkedChangeIds.includes(task.changeId)); const taskIds = new Set(linkedTasks.map((task) => task.id)); const findings = this.dependencies.findings().filter((finding) => finding.workspaceId === goal.workspaceId && finding.lifecycle !== "resolved" && (finding.changeId ? goal.linkedChangeIds.includes(finding.changeId) : finding.taskId ? taskIds.has(finding.taskId) : true));
    let health: GoalHealth = "unknown"; if (goal.status === "achieved") health = "achieved"; else if (goal.status === "active") { const statuses = goal.successCriteria.map((item) => item.status); const pastDue = !!goal.targetDate && Date.parse(`${goal.targetDate}T23:59:59Z`) < Date.now(); if (linkedTasks.some((task) => task.status === "blocked") || findings.some((item) => item.severity === "critical")) health = "off-track"; else if (pastDue || statuses.includes("at-risk") || findings.some((item) => item.severity === "high")) health = "at-risk"; else if ((statuses.length > 0 && statuses.every((status) => status === "met")) || statuses.some((status) => status === "on-track" || status === "met")) health = "on-track"; }
    return { goal, health, readiness: this.readiness(goal), linkedChanges, linkedTasks, findings, criteria: goal.successCriteria, progress: { met: goal.successCriteria.filter((item) => item.status === "met").length, total: goal.successCriteria.length }, assessedAt: utcNow() };
  }
  private persist(value: Omit<Goal, "currentSnapshotId" | "currentSnapshotDigest"> | Goal, reason: GoalSnapshot["reason"]): Goal {
    const withoutPointer = { ...value } as Partial<Goal>; delete withoutPointer.currentSnapshotId; delete withoutPointer.currentSnapshotDigest; const createdAt = utcNow(); const snapshotBase = { schemaVersion: 1 as const, id: `goal-snapshot-${randomUUID().replaceAll("-", "")}`, goalId: value.id, reason, goal: withoutPointer as GoalSnapshot["goal"], createdAt }; const snapshot: GoalSnapshot = { ...snapshotBase, digest: digest(snapshotBase) }; const goal = { ...value, currentSnapshotId: snapshot.id, currentSnapshotDigest: snapshot.digest } as Goal; this.storage.saveGoalSnapshot(snapshot); this.storage.saveGoal(goal); return goal;
  }
}
