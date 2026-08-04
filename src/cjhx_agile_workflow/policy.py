from __future__ import annotations

from dataclasses import dataclass, field

from .errors import PolicyDenied
from .models import SkillManifest, SkillRisk


WRITE_PERMISSIONS = {
    "jira.issue.create",
    "jira.issue.update",
    "jira.issue.transition",
    "confluence.page.create-draft",
    "confluence.page.update-draft",
    "scm.branch.create",
    "scm.change-request.create",
    "scm.commit-status.publish",
    "devops.validation.trigger",
    "devops.artifact.build",
    "devops.artifact.deploy",
}


@dataclass(frozen=True)
class Policy:
    max_automatic_risk: SkillRisk = SkillRisk.S3
    allowed_external_sources: frozenset[str] = field(
        default_factory=lambda: frozenset({"internal", "approved-external"})
    )
    require_approval_for_write: bool = True
    allow_process_skills: bool = False
    process_timeout_seconds: int = 120

    def check_install(self, manifest: SkillManifest) -> None:
        if manifest.source not in self.allowed_external_sources:
            raise PolicyDenied(f"skill source is not approved: {manifest.source}")
        if manifest.entrypoint.type == "process" and not self.allow_process_skills:
            raise PolicyDenied("process skills are disabled")

    def check_run(self, manifest: SkillManifest, *, approved: bool) -> None:
        self.check_install(manifest)
        if int(manifest.risk_level.value[1:]) > int(self.max_automatic_risk.value[1:]) and not approved:
            raise PolicyDenied(
                f"skill risk {manifest.risk_level.value} exceeds automatic limit "
                f"{self.max_automatic_risk.value}"
            )
        uses_write = bool(set(manifest.permissions) & WRITE_PERMISSIONS)
        if (manifest.requires_human_confirmation or (uses_write and self.require_approval_for_write)) and not approved:
            raise PolicyDenied("skill requires human approval before write operations")
