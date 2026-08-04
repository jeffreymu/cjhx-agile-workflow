import { randomUUID } from "node:crypto";
import type { ToolBroker } from "./adapters.js";
import { PolicyDenied, ValidationError } from "./errors.js";
import type { JsonObject, JsonValue, RiskLevel } from "./models.js";
import { isRecord, riskLevels, utcNow } from "./models.js";
import type { Workspace } from "./storage.js";

export const taskStatuses = ["clarification", "todo", "in_progress", "review", "verification", "done", "blocked"] as const;
export type TaskStatus = typeof taskStatuses[number];
export const taskPriorities = ["P0", "P1", "P2", "P3", "P4"] as const;
export type TaskPriority = typeof taskPriorities[number];
export type TaskAuthority = "local-draft" | "jira";

export interface TaskHistory {
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  actor: string;
  reason: string;
  at: string;
  authority: TaskAuthority;
}

export interface Task {
  id: string;
  changeId: string;
  workspaceId?: string;
  title: string;
  description: string;
  owner: string;
  priority: TaskPriority;
  riskLevel: RiskLevel;
  status: TaskStatus;
  authority: TaskAuthority;
  acceptanceCriteria: string[];
  dependencies: string[];
  evidenceRefs: string[];
  sourceRunId?: string;
  sourceTaskId?: string;
  jiraIssueKey?: string;
  jiraStatus?: string;
  jiraUrl?: string;
  lastSyncedAt?: string;
  history: TaskHistory[];
  createdAt: string;
  updatedAt: string;
}

const allowed: Record<TaskStatus, Set<TaskStatus>> = {
  clarification: new Set(["todo", "blocked"]),
  todo: new Set(["clarification", "in_progress", "blocked"]),
  in_progress: new Set(["todo", "review", "blocked"]),
  review: new Set(["in_progress", "verification", "blocked"]),
  verification: new Set(["in_progress", "done", "blocked"]),
  done: new Set(["in_progress"]),
  blocked: new Set(["clarification", "todo", "in_progress", "review", "verification"]),
};

const jiraNames: Record<TaskStatus, string> = { clarification: "Clarification", todo: "To Do", in_progress: "In Progress", review: "Review", verification: "Verification", done: "Done", blocked: "Blocked" };
function statusFromJira(value: string): TaskStatus {
  const normalized = value.trim().toLowerCase().replaceAll(/[_-]+/g, " ");
  const mappings: [RegExp, TaskStatus][] = [[/block|阻塞/, "blocked"], [/clarif|澄清/, "clarification"], [/review|评审/, "review"], [/verif|test|验证|测试/, "verification"], [/done|closed|完成|关闭/, "done"], [/progress|进行/, "in_progress"], [/todo|to do|open|待办|未开始/, "todo"]];
  return mappings.find(([pattern]) => pattern.test(normalized))?.[1] ?? "todo";
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : []; }
function required(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${name} is required`); return value.trim(); }
function resultOf(value: JsonObject): JsonObject { const result = value.result; if (!isRecord(result)) throw new ValidationError("tool result must be an object"); return result as JsonObject; }

export class TaskService {
  private transitionGate?: (taskId: string, target: TaskStatus) => void;
  constructor(readonly workspace: Workspace, readonly tools: ToolBroker) {}
  setTransitionGate(gate: (taskId: string, target: TaskStatus) => void): void { if (this.transitionGate) throw new ValidationError("task transition gate is already configured"); this.transitionGate = gate; }

  list(changeId?: string): Task[] { return this.workspace.listTasks().filter((task) => !changeId || task.changeId === changeId); }
  get(id: string): Task { return this.workspace.getTask(id); }

  create(input: { changeId: string; workspaceId?: string; title: string; description?: string; owner?: string; priority?: TaskPriority; riskLevel?: RiskLevel; status?: TaskStatus; acceptanceCriteria?: string[]; dependencies?: string[]; evidenceRefs?: string[]; sourceRunId?: string; sourceTaskId?: string }): Task {
    this.workspace.getChange(input.changeId);
    if (input.priority && !taskPriorities.includes(input.priority)) throw new ValidationError(`invalid task priority: ${input.priority}`);
    if (input.riskLevel && !riskLevels.includes(input.riskLevel)) throw new ValidationError(`invalid task risk level: ${input.riskLevel}`);
    if (input.status && !taskStatuses.includes(input.status)) throw new ValidationError(`invalid task status: ${input.status}`);
    const now = utcNow(); const task: Task = { id: `task-${randomUUID().replaceAll("-", "")}`, changeId: input.changeId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), title: required(input.title, "task title"), description: input.description?.trim() ?? "", owner: input.owner?.trim() || "unassigned", priority: input.priority ?? "P2", riskLevel: input.riskLevel ?? "L1", status: input.status ?? "todo", authority: "local-draft", acceptanceCriteria: input.acceptanceCriteria ?? [], dependencies: input.dependencies ?? [], evidenceRefs: input.evidenceRefs ?? [], ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}), ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}), history: [], createdAt: now, updatedAt: now };
    this.workspace.saveTask(task); return task;
  }

  importFromRun(runId: string, changeId: string): Task[] {
    this.workspace.getChange(changeId); const run = this.workspace.getRun(runId);
    if (!isRecord(run) || run.status !== "succeeded" || !isRecord(run.output) || !Array.isArray(run.output.tasks)) throw new ValidationError("run output does not contain decomposed tasks");
    if (run.changeId !== changeId) throw new ValidationError("task import change does not match the source run");
    const existing = this.list(changeId).filter((task) => task.sourceRunId === runId); if (existing.length) return existing;
    return run.output.tasks.map((raw, index) => {
      if (!isRecord(raw)) throw new ValidationError("decomposed task must be an object");
      return this.create({ changeId, ...(typeof run.workspaceId === "string" ? { workspaceId: run.workspaceId } : {}), title: required(raw.title, "task title"), description: typeof raw.description === "string" ? raw.description : "", owner: typeof raw.owner === "string" ? raw.owner : undefined, priority: taskPriorities.includes(raw.priority as TaskPriority) ? raw.priority as TaskPriority : "P2", riskLevel: riskLevels.includes(raw.riskLevel as RiskLevel) ? raw.riskLevel as RiskLevel : "L1", acceptanceCriteria: strings(raw.acceptanceCriteria), dependencies: strings(raw.dependencies), sourceRunId: runId, sourceTaskId: typeof raw.id === "string" ? raw.id : `TASK-${index + 1}` });
    });
  }

  transition(id: string, target: TaskStatus, options: { actor: string; reason: string }): Task {
    const task = this.get(id); if (task.authority === "jira") throw new ValidationError("Jira-owned task status must be changed through its authority"); return this.applyTransition(task, target, options);
  }

  async transitionInAuthority(id: string, target: TaskStatus, options: { actor: string; reason: string; approved: boolean }): Promise<Task> {
    const task = this.get(id); if (task.authority === "local-draft") return this.transition(id, target, options);
    this.ensureTransition(task, target); if (!options.approved) throw new PolicyDenied("Jira task transition requires explicit approval");
    const key = required(task.jiraIssueKey, "Jira issue key"); await this.tools.execute({ tool: "jira.issue.transition", arguments: { key, state: jiraNames[target] } }, new Set(["jira.issue.transition"]));
    const moved = this.applyTransition(task, target, options, false); moved.jiraStatus = jiraNames[target]; moved.lastSyncedAt = utcNow(); this.workspace.saveTask(moved); return moved;
  }

  async publishToJira(id: string, options: { approved: boolean }): Promise<Task> {
    if (!options.approved) throw new PolicyDenied("publishing a task to Jira requires explicit approval"); const task = this.get(id); if (task.authority === "jira") return task;
    const operation = await this.tools.execute({ tool: "jira.issue.create", arguments: { fields: { parent: task.changeId, summary: task.title, description: task.description, assignee: task.owner, priority: task.priority, labels: ["cjhx-task"], acceptanceCriteria: task.acceptanceCriteria, dependencies: task.dependencies } } }, new Set(["jira.issue.create"]));
    const result = resultOf(operation); const key = typeof result.key === "string" ? result.key : typeof result.id === "string" ? result.id : undefined; if (!key) throw new ValidationError("Jira create response does not contain an issue key");
    task.authority = "jira"; task.jiraIssueKey = key; task.jiraStatus = typeof result.status === "string" ? result.status : jiraNames[task.status]; if (typeof result.url === "string") task.jiraUrl = result.url; task.lastSyncedAt = utcNow(); task.updatedAt = utcNow(); this.workspace.saveTask(task); return task;
  }

  async syncFromJira(id: string): Promise<Task> {
    const task = this.get(id); if (task.authority !== "jira") throw new ValidationError("only Jira-owned tasks can be synchronized"); const key = required(task.jiraIssueKey, "Jira issue key");
    const operation = await this.tools.execute({ tool: "jira.issue.read", arguments: { key } }, new Set(["jira.issue.read"])); const result = resultOf(operation); const rawStatus = typeof result.status === "string" ? result.status : isRecord(result.fields) && typeof result.fields.status === "string" ? result.fields.status : task.jiraStatus ?? "To Do";
    task.status = statusFromJira(rawStatus); task.jiraStatus = rawStatus; if (typeof result.summary === "string") task.title = result.summary; if (typeof result.assignee === "string") task.owner = result.assignee; if (typeof result.url === "string") task.jiraUrl = result.url; task.lastSyncedAt = utcNow(); task.updatedAt = utcNow(); this.workspace.saveTask(task); return task;
  }

  private ensureTransition(task: Task, target: TaskStatus): void { if (!taskStatuses.includes(target)) throw new ValidationError(`invalid task status: ${target}`); if (!allowed[task.status].has(target)) throw new ValidationError(`cannot transition task from ${task.status} to ${target}`); this.transitionGate?.(task.id, target); }
  private applyTransition(task: Task, target: TaskStatus, options: { actor: string; reason: string }, enforceDynamicGate = true): Task {
    if (enforceDynamicGate) this.ensureTransition(task, target); else { if (!taskStatuses.includes(target)) throw new ValidationError(`invalid task status: ${target}`); if (!allowed[task.status].has(target)) throw new ValidationError(`cannot transition task from ${task.status} to ${target}`); }
    const previous = task.status; task.status = target; task.updatedAt = utcNow(); task.history.push({ fromStatus: previous, toStatus: target, actor: required(options.actor, "actor"), reason: required(options.reason, "reason"), at: utcNow(), authority: task.authority }); this.workspace.saveTask(task); return task;
  }
}

export function taskAsJson(task: Task): JsonValue { return task as unknown as JsonValue; }
