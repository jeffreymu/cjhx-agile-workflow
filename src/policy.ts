import { PolicyDenied } from "./errors.js";
import type { SkillManifest, SkillRisk } from "./models.js";

export const writePermissions = new Set([
  "jira.issue.create", "jira.issue.update", "jira.issue.transition",
  "confluence.page.create-draft", "confluence.page.update-draft",
  "scm.branch.create", "scm.change-request.create", "scm.commit-status.publish",
  "devops.validation.trigger", "devops.artifact.build", "devops.artifact.deploy",
]);

export interface PolicyOptions {
  maxAutomaticRisk?: SkillRisk;
  allowedExternalSources?: Iterable<string>;
  requireApprovalForWrite?: boolean;
  allowProcessSkills?: boolean;
  processTimeoutSeconds?: number;
}

export class Policy {
  readonly maxAutomaticRisk: SkillRisk;
  readonly allowedExternalSources: Set<string>;
  readonly requireApprovalForWrite: boolean;
  readonly allowProcessSkills: boolean;
  readonly processTimeoutSeconds: number;

  constructor(options: PolicyOptions = {}) {
    this.maxAutomaticRisk = options.maxAutomaticRisk ?? "S3";
    this.allowedExternalSources = new Set(options.allowedExternalSources ?? ["internal", "approved-external"]);
    this.requireApprovalForWrite = options.requireApprovalForWrite ?? true;
    this.allowProcessSkills = options.allowProcessSkills ?? false;
    this.processTimeoutSeconds = options.processTimeoutSeconds ?? 120;
  }

  checkInstall(manifest: SkillManifest): void {
    if (!this.allowedExternalSources.has(manifest.source)) throw new PolicyDenied(`skill source is not approved: ${manifest.source}`);
    if (manifest.entrypoint.type === "process" && !this.allowProcessSkills) throw new PolicyDenied("process skills are disabled");
  }

  checkRun(manifest: SkillManifest, approved: boolean): void {
    this.checkInstall(manifest);
    if (Number(manifest.riskLevel.slice(1)) > Number(this.maxAutomaticRisk.slice(1)) && !approved) {
      throw new PolicyDenied(`skill risk ${manifest.riskLevel} exceeds automatic limit ${this.maxAutomaticRisk}`);
    }
    const writes = manifest.permissions.some((permission) => writePermissions.has(permission));
    if ((manifest.requiresHumanConfirmation || (writes && this.requireApprovalForWrite)) && !approved) {
      throw new PolicyDenied("skill requires human approval before write operations");
    }
  }
}
