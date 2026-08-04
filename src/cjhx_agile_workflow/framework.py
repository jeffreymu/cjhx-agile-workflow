from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from .adapters import ToolBroker
from .lifecycle import transition
from .errors import ValidationError
from .models import Change, Evidence, LifecycleState, RiskLevel
from .policy import Policy
from .skills import SkillRegistry, SkillRuntime
from .storage import Workspace
from .workflows import WorkflowDefinition, WorkflowRuntime


class CJHXFramework:
    """Application facade for the CJHX Agile Workflow control plane."""

    def __init__(
        self,
        workspace: str | Path = ".cjhx",
        *,
        policy: Policy | None = None,
        tools: ToolBroker | None = None,
    ) -> None:
        self.workspace = Workspace(workspace)
        self.policy = policy or Policy()
        self.registry = SkillRegistry(self.workspace, self.policy)
        self.runtime = SkillRuntime(self.workspace, self.registry, self.policy, tools)
        self.workflows = WorkflowRuntime(self.workspace, self.runtime)

    def initialize(self) -> None:
        self.workspace.initialize()

    def create_change(
        self,
        change_id: str,
        title: str,
        owner: str,
        *,
        description: str = "",
        risk_level: RiskLevel = RiskLevel.L1,
    ) -> Change:
        self.workspace.initialize()
        if (self.workspace.changes / f"{change_id}.json").exists():
            raise ValidationError(f"change already exists: {change_id}")
        change = Change(
            id=change_id,
            title=title,
            owner=owner,
            description=description,
            risk_level=risk_level,
        )
        self.workspace.save_change(change)
        return change

    def add_evidence(
        self,
        change_id: str,
        *,
        kind: str,
        source: str,
        status: str,
        subject_ref: str,
        uri: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Evidence:
        change = self.workspace.get_change(change_id)
        evidence = Evidence(
            id=f"evidence-{uuid.uuid4().hex}",
            kind=kind,
            source=source,
            status=status,
            subject_ref=subject_ref,
            uri=uri,
            metadata=metadata or {},
        )
        change.evidence.append(evidence)
        self.workspace.save_change(change)
        return evidence

    def transition_change(
        self,
        change_id: str,
        target: LifecycleState,
        *,
        actor: str,
        reason: str,
        enforce_gates: bool = True,
    ) -> Change:
        change = self.workspace.get_change(change_id)
        transition(
            change,
            target,
            actor=actor,
            reason=reason,
            enforce_gates=enforce_gates,
        )
        self.workspace.save_change(change)
        return change

    def install_skill(self, package: str | Path) -> dict[str, Any]:
        return self.registry.install(package)

    def run_skill(
        self,
        skill_id: str,
        payload: dict[str, Any],
        *,
        change_id: str | None = None,
        approved: bool = False,
    ) -> dict[str, Any]:
        return self.runtime.run(
            skill_id,
            payload,
            change_id=change_id,
            approved=approved,
        ).to_dict()

    def run_workflow(
        self,
        definition: WorkflowDefinition,
        payload: dict[str, Any],
        *,
        change_id: str | None = None,
        approved_steps: set[str] | None = None,
    ) -> dict[str, Any]:
        return self.workflows.run(
            definition,
            payload,
            change_id=change_id,
            approved_steps=approved_steps,
        ).to_dict()
