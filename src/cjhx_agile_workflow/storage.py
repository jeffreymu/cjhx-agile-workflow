from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .errors import ValidationError
from .models import Change, SkillRun


class Workspace:
    """File-backed state store. Business facts remain in their authoritative platforms."""

    def __init__(self, root: str | Path = ".cjhx") -> None:
        self.root = Path(root).resolve()
        self.changes = self.root / "changes"
        self.skills = self.root / "skills"
        self.runs = self.root / "runs"
        self.lockfile = self.root / "skills-lock.json"

    def initialize(self) -> None:
        for path in (self.root, self.changes, self.skills, self.runs):
            path.mkdir(parents=True, exist_ok=True)
        if not self.lockfile.exists():
            self.write_json(self.lockfile, {"schemaVersion": 1, "skills": {}})

    @staticmethod
    def write_json(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
                stream.write("\n")
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @staticmethod
    def read_json(path: Path) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise ValidationError(f"not found: {path}") from error
        except json.JSONDecodeError as error:
            raise ValidationError(f"invalid JSON in {path}: {error}") from error

    def save_change(self, change: Change) -> None:
        self.initialize()
        self.write_json(self.changes / f"{change.id}.json", change.to_dict())

    def get_change(self, change_id: str) -> Change:
        return Change.from_dict(self.read_json(self.changes / f"{change_id}.json"))

    def list_changes(self) -> list[Change]:
        self.initialize()
        return [Change.from_dict(self.read_json(path)) for path in sorted(self.changes.glob("*.json"))]

    def save_run(self, run: SkillRun) -> None:
        self.initialize()
        self.write_json(self.runs / f"{run.id}.json", run.to_dict())

    def get_lock(self) -> dict[str, Any]:
        self.initialize()
        return self.read_json(self.lockfile)

    def save_lock(self, value: dict[str, Any]) -> None:
        self.write_json(self.lockfile, value)
