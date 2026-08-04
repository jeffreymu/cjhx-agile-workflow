from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .audit import redact
from .errors import ValidationError
from .models import utc_now
from .skills import SkillRuntime
from .storage import Workspace


@dataclass(frozen=True)
class WorkflowStep:
    id: str
    skill: str
    input: dict[str, Any]


@dataclass(frozen=True)
class WorkflowDefinition:
    id: str
    version: str
    name: str
    steps: tuple[WorkflowStep, ...]

    @classmethod
    def load(cls, path: str | Path) -> WorkflowDefinition:
        source = Path(path)
        try:
            value = json.loads(source.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise ValidationError(f"workflow not found: {source}") from error
        except json.JSONDecodeError as error:
            raise ValidationError(f"invalid workflow JSON: {error}") from error
        if not isinstance(value, dict):
            raise ValidationError("workflow must be a JSON object")
        missing = [key for key in ("id", "version", "name", "steps") if key not in value]
        if missing:
            raise ValidationError(f"missing workflow fields: {', '.join(missing)}")
        if not isinstance(value["steps"], list) or not value["steps"]:
            raise ValidationError("workflow steps must be a non-empty array")
        steps: list[WorkflowStep] = []
        seen: set[str] = set()
        for raw in value["steps"]:
            if not isinstance(raw, dict) or not all(key in raw for key in ("id", "skill", "input")):
                raise ValidationError("each workflow step requires id, skill, and input")
            if raw["id"] in seen:
                raise ValidationError(f"duplicate workflow step id: {raw['id']}")
            if not isinstance(raw["input"], dict):
                raise ValidationError(f"workflow step input must be an object: {raw['id']}")
            seen.add(raw["id"])
            steps.append(WorkflowStep(str(raw["id"]), str(raw["skill"]), raw["input"]))
        return cls(str(value["id"]), str(value["version"]), str(value["name"]), tuple(steps))


@dataclass(frozen=True)
class WorkflowRun:
    id: str
    workflow_id: str
    workflow_version: str
    change_id: str | None
    status: str
    started_at: str
    completed_at: str
    input: dict[str, Any]
    steps: list[dict[str, Any]] = field(default_factory=list)
    output: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class WorkflowRuntime:
    def __init__(self, workspace: Workspace, skills: SkillRuntime) -> None:
        self.workspace = workspace
        self.skills = skills

    def run(
        self,
        definition: WorkflowDefinition,
        payload: dict[str, Any],
        *,
        change_id: str | None = None,
        approved_steps: set[str] | None = None,
    ) -> WorkflowRun:
        run_id = f"workflow-run-{uuid.uuid4().hex}"
        started = utc_now()
        context: dict[str, Any] = {"input": payload, "steps": {}}
        records: list[dict[str, Any]] = []
        approved_steps = approved_steps or set()
        try:
            for step in definition.steps:
                resolved = self._resolve(step.input, context)
                skill_run = self.skills.run(
                    step.skill,
                    resolved,
                    change_id=change_id,
                    approved=step.id in approved_steps,
                )
                context["steps"][step.id] = {"output": skill_run.output, "runId": skill_run.id}
                records.append(
                    {
                        "id": step.id,
                        "skill": step.skill,
                        "skillRunId": skill_run.id,
                        "status": skill_run.status,
                        "output": skill_run.output,
                    }
                )
            run = WorkflowRun(
                id=run_id,
                workflow_id=definition.id,
                workflow_version=definition.version,
                change_id=change_id,
                status="succeeded",
                started_at=started,
                completed_at=utc_now(),
                input=redact(payload),
                steps=redact(records),
                output=redact(context["steps"][definition.steps[-1].id]["output"]),
            )
        except Exception as error:
            run = WorkflowRun(
                id=run_id,
                workflow_id=definition.id,
                workflow_version=definition.version,
                change_id=change_id,
                status="failed",
                started_at=started,
                completed_at=utc_now(),
                input=redact(payload),
                steps=redact(records),
                error=f"{type(error).__name__}: {error}",
            )
            self.workspace.initialize()
            self.workspace.write_json(self.workspace.runs / f"{run.id}.json", run.to_dict())
            raise
        self.workspace.write_json(self.workspace.runs / f"{run.id}.json", run.to_dict())
        return run

    @classmethod
    def _resolve(cls, value: Any, context: dict[str, Any]) -> Any:
        if isinstance(value, dict) and set(value) == {"$ref"}:
            reference = value["$ref"]
            if not isinstance(reference, str):
                raise ValidationError("workflow $ref must be a string")
            return cls._lookup(context, reference)
        if isinstance(value, dict):
            return {key: cls._resolve(item, context) for key, item in value.items()}
        if isinstance(value, list):
            return [cls._resolve(item, context) for item in value]
        return value

    @staticmethod
    def _lookup(context: dict[str, Any], reference: str) -> Any:
        current: Any = context
        for part in reference.split("."):
            if not isinstance(current, dict) or part not in current:
                raise ValidationError(f"workflow reference not found: {reference}")
            current = current[part]
        return current
