import type { AgentRun } from "./agents.js";

export const collaborationRoles = ["coordinator", "implementer", "reviewer", "tester", "researcher", "integrator"] as const;
export type CollaborationRole = typeof collaborationRoles[number];
export type CollaborationStatus = "draft" | "awaiting_approval" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";
export type AssignmentStatus = "proposed" | "awaiting_approval" | "ready" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export type AgentMessageType = "inform" | "request" | "response" | "handoff" | "review" | "blocked" | "escalation";

export interface CollaborationLimits { maxAssignments: number; maxDepth: number; maxParallel: number; maxMessages: number; timeoutMinutes: number; maxTokens?: number }
export interface CollaborationUsage { assignments: number; runningAssignments: number; messages: number; tokens: number }
export interface Collaboration {
  schemaVersion: 1; id: string; workspaceId: string; changeId: string; taskId: string; title: string; objective: string;
  status: CollaborationStatus; planSnapshotId?: string; planDigest?: string; rootAssignmentId?: string;
  limits: CollaborationLimits; usage: CollaborationUsage; createdBy: string; createdAt: string; updatedAt: string; completedAt?: string;
}
export interface CollaborationPlanSnapshot {
  schemaVersion: 1; id: string; digest: string; collaborationId: string; workspaceId: string; changeId: string; taskId: string;
  allowedAgentIds: string[]; allowedRoles: CollaborationRole[]; limits: CollaborationLimits;
  worktreePolicy: { writersRequireIsolatedWorktree: true; allowReadOnlySharedSnapshot: boolean; baseRevision: string; autoMerge: false; autoPush: false };
  delegationPolicy: { mode: "plan-bounded"; allowAgentDelegation: boolean; requireAcceptanceCriteria: true; requireKnownAgent: true };
  harnessRuleSnapshotDigest: string; createdAt: string;
}
export interface AssignmentOutput {
  summary: string; findings: string[]; artifactRefs: string[];
  git?: { baseCommit: string; headCommit?: string; branch: string; changedFiles: string[]; diffStat: string; clean: boolean };
  validation: { agentRunStatus: AgentRun["status"]; complianceStatus?: AgentRun["complianceStatus"]; complianceReportId?: string };
}
export interface AgentAssignment {
  schemaVersion: 1; id: string; collaborationId: string; parentAssignmentId?: string; depth: number;
  workspaceId: string; changeId: string; taskId: string; agentId: string; role: CollaborationRole;
  objective: string; acceptanceCriteria: string[]; mode: "read-only" | "write"; dependencyIds: string[]; status: AssignmentStatus;
  worktreeLeaseId?: string; agentRunId?: string;
  proposedBy: { kind: "human"; actor: string } | { kind: "agent"; agentId: string; runId: string };
  policyViolations?: string[]; output?: AssignmentOutput; createdAt: string; startedAt?: string; completedAt?: string;
}
export interface AgentMessage {
  schemaVersion: 1; id: string; collaborationId: string; workspaceId: string; changeId: string; taskId: string;
  senderAssignmentId: string; senderAgentId: string; senderRunId: string;
  recipient: { kind: "assignment" | "agent"; id: string } | { kind: "coordinator" };
  type: AgentMessageType; subject: string; body: string; artifactRefs: string[]; correlationId?: string; replyTo?: string;
  status: "pending" | "delivered" | "consumed" | "rejected"; digest: string; createdAt: string; consumedAt?: string;
}
export interface CollaborationCapability {
  schemaVersion: 1; id: string; tokenDigest: string; collaborationId: string; assignmentId: string; agentId: string; runId: string;
  permissions: ("message.send" | "message.read-own" | "assignment.delegate")[]; expiresAt: string; createdAt: string; revokedAt?: string;
}
export interface WorktreeLease {
  schemaVersion: 1; id: string; collaborationId: string; assignmentId: string; workspaceId: string;
  repositoryRoot: string; path: string; branch: string; baseRevision: string; baseCommit: string;
  status: "provisioning" | "active" | "completed" | "cleanup_pending" | "removed" | "failed";
  createdAt: string; completedAt?: string; removedAt?: string;
}
