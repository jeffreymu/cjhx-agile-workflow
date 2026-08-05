import { createHash, randomUUID } from "node:crypto";
import { PolicyDenied, ValidationError } from "./errors.js";
import { normalizeAgentResponse, type AgentProfile, type AgentRun, type AgentService } from "./agents.js";
import type { RuleSnapshot } from "./harness.js";
import type { MemoryService, MemorySnapshot, PriorSessionOutcome, RecalledTurn } from "./memory.js";
import { utcNow } from "./models.js";
import type { Workspace } from "./storage.js";
import type { Task } from "./tasks.js";

export type AgentSessionStatus = "active" | "archived";
export type AgentTurnStatus = "running" | "succeeded" | "failed" | "timed_out";
export interface AgentSession {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  changeId: string;
  taskId: string;
  title: string;
  status: AgentSessionStatus;
  nextTurnSequence: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface AgentTurn {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  sequence: number;
  userMessage: string;
  agentId: string;
  agentRunId?: string;
  assistantResponse?: string;
  status: AgentTurnStatus;
  memorySnapshotId: string;
  memorySnapshotDigest: string;
  executionContextId: string;
  executionContextDigest: string;
  createdAt: string;
  completedAt?: string;
}
export interface ExecutionContextSnapshot {
  schemaVersion: 1;
  id: string;
  digest: string;
  sessionId: string;
  taskId: string;
  taskDigest: string;
  task: Pick<Task, "id" | "changeId" | "workspaceId" | "title" | "description" | "owner" | "priority" | "riskLevel" | "status" | "authority" | "acceptanceCriteria" | "dependencies" | "evidenceRefs" | "updatedAt">;
  agentId: string;
  agentProfileDigest: string;
  agentProfile: Pick<AgentProfile, "id" | "name" | "kind" | "command" | "arguments" | "promptTransport" | "timeoutMinutes" | "environmentKeys" | "version">;
  ruleSnapshotId?: string;
  ruleSnapshotDigest?: string;
  ruleSnapshot?: RuleSnapshot;
  memorySnapshotId: string;
  memorySnapshotDigest: string;
  memorySnapshot: MemorySnapshot;
  additionalInstructionsDigest: string;
  additionalInstructions: string;
  userMessageDigest: string;
  userMessage: string;
  promptDigest: string;
  renderedPrompt: string;
  createdAt: string;
}
export interface AgentSessionDetail { session: AgentSession; turns: AgentTurn[] }
export interface SessionFilter { workspaceId?: string; changeId?: string; taskId?: string; status?: AgentSessionStatus }
export interface CreateSessionInput { taskId: string; title?: string; actor: string }
export interface TurnInput { userMessage: string; agentId?: string; instructions?: string }
export interface ApprovedTurnInput extends TurnInput { approved: boolean; approvedContextDigest: string }
export interface ExecutionContextPreview { session: AgentSession; memorySnapshot: MemorySnapshot; executionContext: ExecutionContextSnapshot; agent: { id: string; name: string }; harness: { ruleSnapshotId?: string; ruleSnapshotDigest?: string; mode?: string; preflight: ReturnType<AgentService["harnessPreview"]>["preflight"]; executor: ReturnType<AgentService["harnessPreview"]>["executor"] } }
interface ConversationDependencies { task(id: string): Task; agents: AgentService; memory: MemoryService }

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function hash(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function required(value: unknown, name: string, max = 65_536): string { if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${name} is required`); if (value.includes("\0")) throw new ValidationError(`${name} contains unsupported characters`); const normalized = value.trim(); if (Buffer.byteLength(normalized) > max) throw new ValidationError(`${name} exceeds ${max} bytes`); return normalized; }
function id(value: string, name: string): string { const normalized = required(value, name, 256); if (!identifier.test(normalized)) throw new ValidationError(`${name} contains unsupported characters`); return normalized; }

export class ConversationService {
  constructor(readonly storage: Workspace, private readonly dependencies: ConversationDependencies) { this.recoverInterruptedTurns(); }

  createSession(input: CreateSessionInput): AgentSession {
    const task = this.dependencies.task(id(input.taskId, "task id")); if (!task.workspaceId) throw new ValidationError("conversation session requires a Task Workspace"); const now = utcNow(); const session: AgentSession = { schemaVersion: 1, id: `agent-session-${randomUUID().replaceAll("-", "")}`, workspaceId: task.workspaceId, changeId: task.changeId, taskId: task.id, title: input.title?.trim() || task.title, status: "active", nextTurnSequence: 1, createdBy: required(input.actor, "actor", 256), createdAt: now, updatedAt: now }; if (Buffer.byteLength(session.title) > 512 || session.title.includes("\0")) throw new ValidationError("session title exceeds 512 bytes or contains unsupported characters"); this.storage.saveAgentSession(session); return session;
  }

  listSessions(filter: SessionFilter = {}): AgentSession[] { return this.storage.listAgentSessions().filter((session) => (!filter.workspaceId || session.workspaceId === filter.workspaceId) && (!filter.changeId || session.changeId === filter.changeId) && (!filter.taskId || session.taskId === filter.taskId) && (!filter.status || session.status === filter.status)); }
  getSession(sessionId: string): AgentSessionDetail { const session = this.storage.getAgentSession(id(sessionId, "agent session id")); return { session, turns: this.storage.listAgentTurns(session.id) }; }
  getExecutionContext(contextId: string): ExecutionContextSnapshot { return this.storage.getExecutionContext(id(contextId, "execution context id")); }

  archiveSession(sessionId: string, actor: string): AgentSession { const session = this.getSession(sessionId).session; required(actor, "actor", 256); session.status = "archived"; session.updatedAt = utcNow(); this.storage.saveAgentSession(session); return session; }

  previewTurn(sessionId: string, input: TurnInput): ExecutionContextPreview {
    const detail = this.getSession(sessionId); const session = detail.session; if (session.status !== "active") throw new ValidationError("archived sessions cannot start new turns"); if (detail.turns.some((turn) => turn.status === "running")) throw new PolicyDenied("conversation session already has a running turn"); const task = this.dependencies.task(session.taskId); this.assertScope(session, task); const userMessage = required(input.userMessage, "user message"); const recentTurns: RecalledTurn[] = detail.turns.filter((turn) => turn.status !== "running").slice(-6).map((turn) => ({ id: turn.id, sequence: turn.sequence, userMessage: turn.userMessage, ...(turn.assistantResponse ? { assistantResponse: turn.assistantResponse } : {}) })); const priorSessionOutcomes = this.priorOutcomes(session);
    const memorySnapshot = this.dependencies.memory.recall({ sessionId: session.id, taskId: task.id, query: userMessage, recentTurns, priorSessionOutcomes }); const prepared = this.dependencies.agents.prepareTask(task.id, { ...(input.agentId ? { agentId: input.agentId } : {}), ...(input.instructions ? { instructions: input.instructions } : {}), userMessage, historicalContext: memorySnapshot.renderedContext });
    const taskSnapshot: ExecutionContextSnapshot["task"] = { id: task.id, changeId: task.changeId, ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}), title: task.title, description: task.description, owner: task.owner, priority: task.priority, riskLevel: task.riskLevel, status: task.status, authority: task.authority, acceptanceCriteria: [...task.acceptanceCriteria], dependencies: [...task.dependencies], evidenceRefs: [...task.evidenceRefs], updatedAt: task.updatedAt };
    const agentProfile: ExecutionContextSnapshot["agentProfile"] = { id: prepared.profile.id, name: prepared.profile.name, kind: prepared.profile.kind, command: prepared.profile.command, arguments: [...prepared.profile.arguments], promptTransport: prepared.profile.promptTransport, timeoutMinutes: prepared.profile.timeoutMinutes, ...(prepared.profile.environmentKeys ? { environmentKeys: [...prepared.profile.environmentKeys] } : {}), ...(prepared.profile.version ? { version: prepared.profile.version } : {}) };
    const additionalInstructions = input.instructions?.trim() ?? ""; const taskDigest = hash(taskSnapshot); const additionalInstructionsDigest = hash(additionalInstructions); const userMessageDigest = hash(userMessage); const promptDigest = hash(prepared.prompt); const digestBasis = { sessionId: session.id, taskId: task.id, taskDigest, task: taskSnapshot, agentId: prepared.profile.id, agentProfileDigest: prepared.agentProfileDigest, agentProfile, ruleSnapshotDigest: prepared.ruleSnapshot?.digest, memorySnapshotDigest: memorySnapshot.digest, additionalInstructionsDigest, additionalInstructions, userMessageDigest, userMessage, promptDigest, renderedPrompt: prepared.prompt };
    const executionContext: ExecutionContextSnapshot = { schemaVersion: 1, id: `execution-context-${randomUUID().replaceAll("-", "")}`, digest: hash(digestBasis), sessionId: session.id, taskId: task.id, taskDigest, task: taskSnapshot, agentId: prepared.profile.id, agentProfileDigest: prepared.agentProfileDigest, agentProfile, ...(prepared.ruleSnapshot ? { ruleSnapshotId: prepared.ruleSnapshot.id, ruleSnapshotDigest: prepared.ruleSnapshot.digest, ruleSnapshot: prepared.ruleSnapshot } : {}), memorySnapshotId: memorySnapshot.id, memorySnapshotDigest: memorySnapshot.digest, memorySnapshot, additionalInstructionsDigest, additionalInstructions, userMessageDigest, userMessage, promptDigest, renderedPrompt: prepared.prompt, createdAt: utcNow() }; this.storage.saveExecutionContext(executionContext);
    let harness: ExecutionContextPreview["harness"] = { preflight: [], executor: { id: "local-process", evaluations: [] } }; if (prepared.ruleSnapshot) { const preview = this.dependencies.agents.harnessPreview(task.id, prepared.profile.id); harness = { ruleSnapshotId: preview.snapshot.id, ruleSnapshotDigest: preview.snapshot.digest, mode: preview.snapshot.effective.mode, preflight: preview.preflight, executor: preview.executor }; }
    return { session, memorySnapshot, executionContext, agent: { id: prepared.profile.id, name: prepared.profile.name }, harness };
  }

  startTurn(sessionId: string, input: ApprovedTurnInput): AgentTurn {
    if (!input.approved) throw new PolicyDenied("Agent turn execution requires explicit human approval"); const preview = this.previewTurn(sessionId, input); if (preview.executionContext.digest !== input.approvedContextDigest) throw new PolicyDenied("Agent approval does not match the current execution context snapshot"); const session = preview.session; const sequence = session.nextTurnSequence; const turnId = `agent-turn-${randomUUID().replaceAll("-", "")}`; const now = utcNow(); const turn: AgentTurn = { schemaVersion: 1, id: turnId, sessionId: session.id, sequence, userMessage: required(input.userMessage, "user message"), agentId: preview.agent.id, status: "running", memorySnapshotId: preview.memorySnapshot.id, memorySnapshotDigest: preview.memorySnapshot.digest, executionContextId: preview.executionContext.id, executionContextDigest: preview.executionContext.digest, createdAt: now };
    this.storage.createAgentTurn(turn); session.nextTurnSequence += 1; session.updatedAt = now; try { this.storage.saveAgentSession(session); } catch (error) { this.storage.removeAgentTurn(session.id, sequence); throw error; }
    try {
      const run = this.dependencies.agents.startTask(session.taskId, { agentId: preview.agent.id, ...(input.instructions ? { instructions: input.instructions } : {}), userMessage: turn.userMessage, historicalContext: preview.memorySnapshot.renderedContext, approved: true, ...(preview.executionContext.ruleSnapshotDigest ? { approvedRuleDigest: preview.executionContext.ruleSnapshotDigest } : {}), context: { sessionId: session.id, turnId: turn.id, memorySnapshotId: turn.memorySnapshotId, memorySnapshotDigest: turn.memorySnapshotDigest, executionContextId: turn.executionContextId, executionContextDigest: turn.executionContextDigest, promptDigest: preview.executionContext.promptDigest }, onCompleted: (completed) => this.completeTurn(turn, completed) }); turn.agentRunId = run.id; this.storage.saveAgentTurn(turn); return turn;
    } catch (error) { turn.status = "failed"; turn.completedAt = utcNow(); this.storage.saveAgentTurn(turn); throw error; }
  }

  private recoverInterruptedTurns(): void { for (const session of this.storage.listAgentSessions()) { const turns = this.storage.listAgentTurns(session.id); let changed = false; const expectedSequence = (turns.at(-1)?.sequence ?? 0) + 1; if (session.nextTurnSequence !== expectedSequence) { session.nextTurnSequence = expectedSequence; changed = true; } for (const turn of turns.filter((item) => item.status === "running")) { let run: AgentRun | undefined; try { run = turn.agentRunId ? this.dependencies.agents.getRun(turn.agentRunId) : undefined; } catch { run = undefined; } if (run?.status === "running") continue; turn.status = run?.status ?? "failed"; turn.completedAt = run?.completedAt ?? utcNow(); if (run) { const response = normalizeAgentResponse(run.stdout, run.agentKind); if (response) turn.assistantResponse = response; } this.storage.saveAgentTurn(turn); session.updatedAt = turn.completedAt; changed = true; } if (changed) this.storage.saveAgentSession(session); } }
  private completeTurn(turn: AgentTurn, run: AgentRun): void { turn.status = run.status; turn.completedAt = run.completedAt ?? utcNow(); const response = normalizeAgentResponse(run.stdout, run.agentKind); if (response) turn.assistantResponse = response; this.storage.saveAgentTurn(turn); const session = this.storage.getAgentSession(turn.sessionId); session.updatedAt = turn.completedAt; this.storage.saveAgentSession(session); }
  private priorOutcomes(current: AgentSession): PriorSessionOutcome[] { return this.listSessions({ taskId: current.taskId }).filter((session) => session.id !== current.id).flatMap((session): PriorSessionOutcome[] => { const latest = this.storage.listAgentTurns(session.id).filter((turn) => turn.status !== "running").at(-1); if (!latest) return []; const run = latest.agentRunId ? this.dependencies.agents.getRun(latest.agentRunId) : undefined; return [{ sessionId: session.id, lastUserIntent: latest.userMessage, runStatus: run?.status ?? latest.status, ...(run?.complianceStatus ? { complianceStatus: run.complianceStatus } : {}), updatedAt: session.updatedAt }]; }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3); }
  private assertScope(session: AgentSession, task: Task): void { if (task.id !== session.taskId || task.changeId !== session.changeId || task.workspaceId !== session.workspaceId) throw new PolicyDenied("conversation session scope no longer matches its Task"); }
}
