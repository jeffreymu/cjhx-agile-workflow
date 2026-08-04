from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from .errors import ValidationError


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def validate_identifier(value: str, label: str, allowed: str) -> None:
    if not value or any(char not in allowed for char in value):
        raise ValidationError(f"{label} contains unsupported characters")


class LifecycleState(StrEnum):
    INTENT_DRAFT = "intent_draft"
    INTENT_CONFIRMED = "intent_confirmed"
    REQUIREMENT_READY = "requirement_ready"
    DESIGN_APPROVED = "design_approved"
    IMPLEMENTING = "implementing"
    REVIEWING = "reviewing"
    VERIFIED = "verified"
    ACCEPTED = "accepted"
    RELEASE_APPROVED = "release_approved"
    DEPLOYING = "deploying"
    OPERATING = "operating"
    OUTCOME_VALIDATED = "outcome_validated"


class RiskLevel(StrEnum):
    L0 = "L0"
    L1 = "L1"
    L2 = "L2"
    L3 = "L3"
    L4 = "L4"
    L5 = "L5"


class SkillRisk(StrEnum):
    S0 = "S0"
    S1 = "S1"
    S2 = "S2"
    S3 = "S3"
    S4 = "S4"
    S5 = "S5"
    S6 = "S6"


@dataclass(frozen=True)
class Evidence:
    id: str
    kind: str
    source: str
    status: str
    subject_ref: str
    uri: str | None = None
    created_at: str = field(default_factory=utc_now)
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Evidence:
        return cls(**value)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class TransitionRecord:
    from_state: str
    to_state: str
    actor: str
    reason: str
    at: str = field(default_factory=utc_now)
    evidence_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> TransitionRecord:
        return cls(**value)


@dataclass
class Change:
    id: str
    title: str
    owner: str
    risk_level: RiskLevel = RiskLevel.L1
    state: LifecycleState = LifecycleState.INTENT_DRAFT
    description: str = ""
    links: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    evidence: list[Evidence] = field(default_factory=list)
    history: list[TransitionRecord] = field(default_factory=list)
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        if not self.id.strip() or not self.title.strip() or not self.owner.strip():
            raise ValidationError("change id, title, and owner are required")
        validate_identifier(
            self.id,
            "change id",
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
        )
        self.risk_level = RiskLevel(self.risk_level)
        self.state = LifecycleState(self.state)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Change:
        data = dict(value)
        data["evidence"] = [Evidence.from_dict(item) for item in data.get("evidence", [])]
        data["history"] = [TransitionRecord.from_dict(item) for item in data.get("history", [])]
        return cls(**data)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["risk_level"] = self.risk_level.value
        data["state"] = self.state.value
        return data


@dataclass(frozen=True)
class Entrypoint:
    type: str
    target: str

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Entrypoint:
        try:
            entrypoint = cls(type=value["type"], target=value["target"])
        except KeyError as error:
            raise ValidationError(f"missing entrypoint field: {error.args[0]}") from error
        if entrypoint.type not in {"builtin", "process"}:
            raise ValidationError("entrypoint.type must be builtin or process")
        return entrypoint


@dataclass(frozen=True)
class SkillManifest:
    id: str
    version: str
    name: str
    description: str
    owner: str
    source: str
    risk_level: SkillRisk
    entrypoint: Entrypoint
    permissions: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    timeout_seconds: int = 120
    requires_human_confirmation: bool = False

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> SkillManifest:
        required = ("id", "version", "name", "description", "owner", "source", "riskLevel", "entrypoint")
        missing = [key for key in required if key not in value]
        if missing:
            raise ValidationError(f"missing skill manifest fields: {', '.join(missing)}")
        skill_id = str(value["id"])
        if (
            not skill_id
            or skill_id in {".", ".."}
            or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789.-_" for char in skill_id)
        ):
            raise ValidationError("skill id must use lowercase letters, digits, '.', '-', or '_'")
        version = str(value["version"])
        if version in {".", ".."}:
            raise ValidationError("skill version contains unsupported characters")
        validate_identifier(
            version,
            "skill version",
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_+",
        )
        timeout = int(value.get("timeoutSeconds", 120))
        if timeout < 1:
            raise ValidationError("timeoutSeconds must be positive")
        return cls(
            id=skill_id,
            version=version,
            name=str(value["name"]),
            description=str(value["description"]),
            owner=str(value["owner"]),
            source=str(value["source"]),
            risk_level=SkillRisk(value["riskLevel"]),
            entrypoint=Entrypoint.from_dict(value["entrypoint"]),
            permissions=tuple(value.get("permissions", [])),
            tags=tuple(value.get("tags", [])),
            timeout_seconds=timeout,
            requires_human_confirmation=bool(value.get("requiresHumanConfirmation", False)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "version": self.version,
            "name": self.name,
            "description": self.description,
            "owner": self.owner,
            "source": self.source,
            "riskLevel": self.risk_level.value,
            "entrypoint": asdict(self.entrypoint),
            "permissions": list(self.permissions),
            "tags": list(self.tags),
            "timeoutSeconds": self.timeout_seconds,
            "requiresHumanConfirmation": self.requires_human_confirmation,
        }


@dataclass(frozen=True)
class SkillRun:
    id: str
    skill_id: str
    skill_version: str
    change_id: str | None
    status: str
    started_at: str
    completed_at: str
    input: dict[str, Any]
    output: dict[str, Any]
    evidence: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
