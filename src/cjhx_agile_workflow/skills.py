from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from .adapters import ToolBroker, ToolOperation
from .audit import redact
from .builtin_skills import BUILTINS
from .errors import SkillError, ValidationError
from .models import SkillManifest, SkillRun, utc_now
from .policy import Policy
from .storage import Workspace

MANIFEST_NAME = "skill.json"


def package_digest(path: Path) -> str:
    digest = hashlib.sha256()
    files = sorted(
        item
        for item in path.rglob("*")
        if item.is_file()
        and "__pycache__" not in item.parts
        and item.suffix not in {".pyc", ".pyo"}
    )
    for item in files:
        relative = item.relative_to(path).as_posix().encode()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        content = item.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"


class SkillRegistry:
    def __init__(self, workspace: Workspace, policy: Policy) -> None:
        self.workspace = workspace
        self.policy = policy

    @staticmethod
    def load_manifest(package: Path) -> SkillManifest:
        manifest_path = package / MANIFEST_NAME
        try:
            value = json.loads(manifest_path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise ValidationError(f"skill package requires {MANIFEST_NAME}: {package}") from error
        except json.JSONDecodeError as error:
            raise ValidationError(f"invalid {MANIFEST_NAME}: {error}") from error
        if not isinstance(value, dict):
            raise ValidationError("skill manifest must be a JSON object")
        return SkillManifest.from_dict(value)

    def install(self, package: str | Path) -> dict[str, Any]:
        source = Path(package).resolve()
        if not source.is_dir():
            raise SkillError(f"skill package is not a directory: {source}")
        manifest = self.load_manifest(source)
        symlinks = [item for item in source.rglob("*") if item.is_symlink()]
        if symlinks:
            raise SkillError(
                "skill packages cannot contain symbolic links: "
                + ", ".join(str(item.relative_to(source)) for item in symlinks)
            )
        self.policy.check_install(manifest)
        digest = package_digest(source)
        target = self.workspace.skills / manifest.id / manifest.version
        self.workspace.initialize()
        if target.exists():
            existing = package_digest(target)
            if existing != digest:
                raise SkillError(
                    f"{manifest.id}@{manifest.version} is already installed with a different digest"
                )
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
            shutil.copytree(source, temporary)
            os.replace(temporary, target)
        lock = self.workspace.get_lock()
        lock["skills"][manifest.id] = {
            "version": manifest.version,
            "digest": digest,
            "path": str(target.relative_to(self.workspace.root)),
            "source": manifest.source,
        }
        self.workspace.save_lock(lock)
        return {"manifest": manifest.to_dict(), "digest": digest, "path": str(target)}

    def list(self) -> list[dict[str, Any]]:
        lock = self.workspace.get_lock()
        return [{"id": skill_id, **value} for skill_id, value in sorted(lock["skills"].items())]

    def resolve(self, skill_id: str) -> tuple[SkillManifest, Path, str]:
        lock = self.workspace.get_lock()
        record = lock["skills"].get(skill_id)
        if record is None:
            raise SkillError(f"skill is not installed: {skill_id}")
        package = self.workspace.root / record["path"]
        manifest = self.load_manifest(package)
        actual = package_digest(package)
        if actual != record["digest"]:
            raise SkillError(f"installed skill digest mismatch: {skill_id}")
        return manifest, package, actual


class SkillRuntime:
    def __init__(
        self,
        workspace: Workspace,
        registry: SkillRegistry,
        policy: Policy,
        tools: ToolBroker | None = None,
    ) -> None:
        self.workspace = workspace
        self.registry = registry
        self.policy = policy
        self.tools = tools or ToolBroker()

    def run(
        self,
        skill_id: str,
        payload: dict[str, Any],
        *,
        change_id: str | None = None,
        approved: bool = False,
    ) -> SkillRun:
        manifest, package, _ = self.registry.resolve(skill_id)
        self.policy.check_run(manifest, approved=approved)
        started = utc_now()
        run_id = f"skill-run-{uuid.uuid4().hex}"
        try:
            response = self._invoke(manifest, package, payload)
            output, evidence, operations = self._validate_response(response)
            tool_results = [
                self.tools.execute(ToolOperation.from_dict(item), set(manifest.permissions))
                for item in operations
            ]
            if tool_results:
                output = {**output, "toolResults": tool_results}
            run = SkillRun(
                id=run_id,
                skill_id=manifest.id,
                skill_version=manifest.version,
                change_id=change_id,
                status="succeeded",
                started_at=started,
                completed_at=utc_now(),
                input=redact(payload),
                output=redact(output),
                evidence=redact(evidence),
            )
        except Exception as error:
            run = SkillRun(
                id=run_id,
                skill_id=manifest.id,
                skill_version=manifest.version,
                change_id=change_id,
                status="failed",
                started_at=started,
                completed_at=utc_now(),
                input=redact(payload),
                output={},
                error=f"{type(error).__name__}: {error}",
            )
            self.workspace.save_run(run)
            raise
        self.workspace.save_run(run)
        return run

    def _invoke(
        self, manifest: SkillManifest, package: Path, payload: dict[str, Any]
    ) -> dict[str, Any]:
        if manifest.entrypoint.type == "builtin":
            handler = BUILTINS.get(manifest.entrypoint.target)
            if handler is None:
                raise SkillError(f"unknown builtin skill: {manifest.entrypoint.target}")
            return handler(payload)
        target = Path(manifest.entrypoint.target)
        if target.is_absolute() or ".." in target.parts:
            raise SkillError("process entrypoint must stay inside its skill package")
        executable = (package / target).resolve()
        if package.resolve() not in executable.parents or not executable.is_file():
            raise SkillError(f"process entrypoint not found: {target}")
        command = [sys.executable, str(executable)] if executable.suffix == ".py" else [str(executable)]
        timeout = min(manifest.timeout_seconds, self.policy.process_timeout_seconds)
        try:
            completed = subprocess.run(
                command,
                input=json.dumps(payload, ensure_ascii=False),
                capture_output=True,
                text=True,
                cwd=package,
                timeout=timeout,
                check=False,
                env={"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8"},
            )
        except subprocess.TimeoutExpired as error:
            raise SkillError(f"skill timed out after {timeout} seconds") from error
        if completed.returncode != 0:
            detail = completed.stderr.strip()[-1000:]
            raise SkillError(f"skill process exited {completed.returncode}: {detail}")
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise SkillError("skill process did not return valid JSON") from error
        if not isinstance(response, dict):
            raise SkillError("skill process response must be an object")
        return response

    @staticmethod
    def _validate_response(
        response: dict[str, Any],
    ) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
        output = response.get("output", {})
        evidence = response.get("evidence", [])
        operations = response.get("operations", [])
        if not isinstance(output, dict):
            raise SkillError("skill output must be an object")
        if not isinstance(evidence, list) or not all(isinstance(item, dict) for item in evidence):
            raise SkillError("skill evidence must be an array of objects")
        if not isinstance(operations, list) or not all(isinstance(item, dict) for item in operations):
            raise SkillError("skill operations must be an array of objects")
        return output, evidence, operations
