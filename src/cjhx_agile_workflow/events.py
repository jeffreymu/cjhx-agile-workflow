from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from .errors import ValidationError
from .models import utc_now, validate_identifier
from .storage import Workspace


@dataclass(frozen=True)
class EventEnvelope:
    event_id: str
    event_type: str
    source: str
    change_id: str
    correlation_id: str
    payload: dict[str, Any]
    occurred_at: str = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        required = {
            "event_id": self.event_id,
            "event_type": self.event_type,
            "source": self.source,
            "change_id": self.change_id,
            "correlation_id": self.correlation_id,
        }
        missing = [name for name, value in required.items() if not value.strip()]
        if missing:
            raise ValidationError(f"event fields cannot be empty: {', '.join(missing)}")
        validate_identifier(
            self.event_id,
            "event id",
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
        )

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> EventEnvelope:
        mapping = {
            "eventId": "event_id",
            "eventType": "event_type",
            "source": "source",
            "changeId": "change_id",
            "correlationId": "correlation_id",
            "payload": "payload",
            "occurredAt": "occurred_at",
        }
        unknown = set(value) - set(mapping)
        if unknown:
            raise ValidationError(f"unknown event fields: {', '.join(sorted(unknown))}")
        normalized = {target: value[source] for source, target in mapping.items() if source in value}
        try:
            return cls(**normalized)
        except TypeError as error:
            raise ValidationError(f"invalid event envelope: {error}") from error

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        return {
            "eventId": value["event_id"],
            "eventType": value["event_type"],
            "source": value["source"],
            "changeId": value["change_id"],
            "correlationId": value["correlation_id"],
            "payload": value["payload"],
            "occurredAt": value["occurred_at"],
        }


class EventInbox:
    """Durable idempotency record for adapter/webhook consumers."""

    def __init__(self, workspace: Workspace) -> None:
        self.workspace = workspace
        self.path = workspace.root / "events" / "inbox"

    def accept(self, event: EventEnvelope) -> bool:
        self.workspace.initialize()
        record = self.path / f"{event.event_id}.json"
        if record.exists():
            existing = self.workspace.read_json(record)
            if existing != event.to_dict():
                raise ValidationError(
                    f"event id was reused with different content: {event.event_id}"
                )
            return False
        self.workspace.write_json(record, event.to_dict())
        return True
