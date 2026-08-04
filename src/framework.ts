import { randomUUID } from "node:crypto";
import type { ToolBroker } from "./adapters.js";
import { AgentService } from "./agents.js";
import { DevOpsIntegrationManager } from "./devops-config.js";
import { DevOpsService } from "./devops.js";
import { ValidationError } from "./errors.js";
import { GitHubIntegrationManager } from "./github-config.js";
import { GitLabIntegrationManager } from "./gitlab-config.js";
import { JiraIntegrationManager } from "./jira-config.js";
import { transition } from "./lifecycle.js";
import { LocalSkillService } from "./local-skills.js";
import { createChange, type Change, type Evidence, type JsonObject, type LifecycleState, type RiskLevel, utcNow } from "./models.js";
import { Policy } from "./policy.js";
import { SkillRegistry, SkillRuntime } from "./skills.js";
import { SourceControlIntegrationManager } from "./source-control-config.js";
import { Workspace } from "./storage.js";
import { TaskService, type TaskPriority, type TaskStatus } from "./tasks.js";
import { WorkflowRuntime, type WorkflowDefinition, type WorkflowRun } from "./workflows.js";
import { WorkspaceHub } from "./workspace-hub.js";

export class CJHXFramework {
  readonly workspace: Workspace; readonly policy: Policy; readonly registry: SkillRegistry; readonly localSkills: LocalSkillService; readonly runtime: SkillRuntime; readonly workflows: WorkflowRuntime; readonly tasks: TaskService; readonly devops: DevOpsService; readonly devopsIntegration: DevOpsIntegrationManager; readonly jiraIntegration: JiraIntegrationManager; readonly sourceControlIntegration: SourceControlIntegrationManager; readonly gitLabIntegration: GitLabIntegrationManager; readonly gitHubIntegration: GitHubIntegrationManager; readonly workspaceHub: WorkspaceHub; readonly agents: AgentService;
  constructor(workspace = ".cjhx", options: { policy?: Policy; tools?: ToolBroker; localSkillRoots?: string[] } = {}) {
    this.workspace = new Workspace(workspace); this.policy = options.policy ?? new Policy(); this.registry = new SkillRegistry(this.workspace, this.policy); this.localSkills = new LocalSkillService(this.workspace, this.registry, this.policy, options.localSkillRoots); this.runtime = new SkillRuntime(this.workspace, this.registry, this.policy, options.tools); this.workflows = new WorkflowRuntime(this.workspace, this.runtime); this.tasks = new TaskService(this.workspace, this.runtime.tools); this.devops = new DevOpsService(this.runtime.tools); this.devopsIntegration = new DevOpsIntegrationManager(this.workspace, this.runtime.tools); this.jiraIntegration = new JiraIntegrationManager(this.workspace, this.runtime.tools); this.sourceControlIntegration = new SourceControlIntegrationManager(this.workspace, this.runtime.tools); this.gitLabIntegration = new GitLabIntegrationManager(this.workspace, this.sourceControlIntegration); this.gitHubIntegration = new GitHubIntegrationManager(this.workspace, this.sourceControlIntegration); this.workspaceHub = new WorkspaceHub(this.workspace, { remote: (provider) => provider === "gitlab" ? this.gitLabIntegration.browser() : this.gitHubIntegration.browser(), changes: () => this.workspace.listChanges(), tasks: () => this.tasks.list(), runs: () => [...this.workspace.listRuns(), ...this.workspace.listAgentRuns() as unknown as JsonObject[]] }); this.agents = new AgentService(this.workspace, { task: (id) => this.tasks.get(id), workspace: (id) => this.workspaceHub.get(id), enabledSkills: () => this.localSkills.enabledAgentSkills() });
  }
  initialize(): void { this.workspace.initialize(); }
  createChange(id: string, title: string, owner: string, options: { workspaceId?: string; description?: string; riskLevel?: RiskLevel } = {}): Change {
    this.workspace.initialize(); if (options.workspaceId) this.workspaceHub.get(options.workspaceId); if (this.workspace.changeExists(id)) throw new ValidationError(`change already exists: ${id}`);
    const change = createChange({ id, title, owner, ...options }); this.workspace.saveChange(change); return change;
  }
  addEvidence(changeId: string, input: { kind: string; source: string; status: string; subjectRef: string; uri?: string; metadata?: JsonObject }): Evidence {
    const change = this.workspace.getChange(changeId); const evidence: Evidence = { id: `evidence-${randomUUID().replaceAll("-", "")}`, kind: input.kind, source: input.source, status: input.status, subjectRef: input.subjectRef, ...(input.uri ? { uri: input.uri } : {}), createdAt: utcNow(), metadata: input.metadata ?? {} };
    change.evidence.push(evidence); this.workspace.saveChange(change); return evidence;
  }
  transitionChange(changeId: string, target: LifecycleState, options: { actor: string; reason: string; enforceGates?: boolean }): Change { const change = this.workspace.getChange(changeId); transition(change, target, options); this.workspace.saveChange(change); return change; }
  installSkill(packagePath: string): ReturnType<SkillRegistry["install"]> { return this.registry.install(packagePath); }
  async runSkill(id: string, input: JsonObject, options: { changeId?: string; workspaceId?: string; approved?: boolean } = {}) { if (options.workspaceId) this.workspaceHub.get(options.workspaceId); return await this.runtime.run(id, input, options); }
  async runWorkflow(definition: WorkflowDefinition, input: JsonObject, options: { changeId?: string; workspaceId?: string; approvedSteps?: Set<string> } = {}): Promise<WorkflowRun> { if (options.workspaceId) this.workspaceHub.get(options.workspaceId); return await this.workflows.run(definition, input, options); }
  createTask(input: { changeId: string; workspaceId?: string; title: string; description?: string; owner?: string; priority?: TaskPriority; riskLevel?: RiskLevel; status?: TaskStatus; acceptanceCriteria?: string[]; dependencies?: string[]; evidenceRefs?: string[] }) { if (input.workspaceId) this.workspaceHub.get(input.workspaceId); return this.tasks.create(input); }
  listTasks(changeId?: string) { return this.tasks.list(changeId); }
  importTasksFromRun(runId: string, changeId: string) { return this.tasks.importFromRun(runId, changeId); }
  transitionTask(id: string, target: TaskStatus, options: { actor: string; reason: string }) { return this.tasks.transition(id, target, options); }
  async transitionTaskInAuthority(id: string, target: TaskStatus, options: { actor: string; reason: string; approved: boolean }) { return await this.tasks.transitionInAuthority(id, target, options); }
  async publishTaskToJira(id: string, options: { approved: boolean }) { return await this.tasks.publishToJira(id, options); }
  async syncTaskFromJira(id: string) { return await this.tasks.syncFromJira(id); }
  startAgentForTask(taskId: string, options: { agentId?: string; instructions?: string; approved: boolean }) { return this.agents.startTask(taskId, options); }
}
