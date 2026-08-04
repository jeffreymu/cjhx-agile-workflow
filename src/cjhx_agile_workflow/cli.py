from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .errors import CJHXError
from .framework import CJHXFramework
from .models import LifecycleState, RiskLevel
from .policy import Policy
from .workflows import WorkflowDefinition


def load_payload(value: str) -> dict[str, Any]:
    if value.startswith("@"):
        raw = Path(value[1:]).read_text(encoding="utf-8")
    elif value.lstrip().startswith("{"):
        raw = value
    else:
        path = Path(value)
        raw = path.read_text(encoding="utf-8") if path.is_file() else value
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("payload must be a JSON object")
    return parsed


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="cjhx", description="CJHX Agile Workflow CLI")
    result.add_argument("--workspace", default=".cjhx", help="framework state directory")
    result.add_argument(
        "--allow-process-skills",
        action="store_true",
        help="explicitly allow approved external process Skills (use a sandbox in production)",
    )
    commands = result.add_subparsers(dest="command", required=True)

    commands.add_parser("init", help="initialize a workspace")

    change = commands.add_parser("change-create", help="create a lifecycle change")
    change.add_argument("id")
    change.add_argument("title")
    change.add_argument("--owner", required=True)
    change.add_argument("--description", default="")
    change.add_argument("--risk", choices=[item.value for item in RiskLevel], default="L1")

    show = commands.add_parser("change-show", help="show a change")
    show.add_argument("id")

    listing = commands.add_parser("change-list", help="list changes")
    listing.set_defaults(command="change-list")

    evidence = commands.add_parser("evidence-add", help="attach lifecycle evidence")
    evidence.add_argument("change_id")
    evidence.add_argument("kind")
    evidence.add_argument("--source", required=True)
    evidence.add_argument("--status", required=True)
    evidence.add_argument("--subject", required=True)
    evidence.add_argument("--uri")

    move = commands.add_parser("change-transition", help="transition a change")
    move.add_argument("id")
    move.add_argument("target", choices=[item.value for item in LifecycleState])
    move.add_argument("--actor", required=True)
    move.add_argument("--reason", required=True)
    move.add_argument("--skip-gates", action="store_true")

    install = commands.add_parser("skill-install", help="install and lock a skill package")
    install.add_argument("package")

    commands.add_parser("skill-list", help="list installed skills")

    run = commands.add_parser("skill-run", help="run an installed skill")
    run.add_argument("id")
    run.add_argument("--input", required=True, help="JSON object or path to a JSON file")
    run.add_argument("--change-id")
    run.add_argument("--approved", action="store_true")

    workflow = commands.add_parser("workflow-run", help="run a declarative skill workflow")
    workflow.add_argument("definition", help="path to workflow JSON")
    workflow.add_argument("--input", required=True, help="JSON object or path to a JSON file")
    workflow.add_argument("--change-id")
    workflow.add_argument(
        "--approve-step",
        action="append",
        default=[],
        help="approve a write/high-risk workflow step (repeatable)",
    )
    return result


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def execute(arguments: argparse.Namespace) -> Any:
    app = CJHXFramework(
        arguments.workspace,
        policy=Policy(allow_process_skills=arguments.allow_process_skills),
    )
    if arguments.command == "init":
        app.initialize()
        return {"workspace": str(app.workspace.root), "status": "initialized"}
    if arguments.command == "change-create":
        return app.create_change(
            arguments.id,
            arguments.title,
            arguments.owner,
            description=arguments.description,
            risk_level=RiskLevel(arguments.risk),
        ).to_dict()
    if arguments.command == "change-show":
        return app.workspace.get_change(arguments.id).to_dict()
    if arguments.command == "change-list":
        return [item.to_dict() for item in app.workspace.list_changes()]
    if arguments.command == "evidence-add":
        return app.add_evidence(
            arguments.change_id,
            kind=arguments.kind,
            source=arguments.source,
            status=arguments.status,
            subject_ref=arguments.subject,
            uri=arguments.uri,
        ).to_dict()
    if arguments.command == "change-transition":
        return app.transition_change(
            arguments.id,
            LifecycleState(arguments.target),
            actor=arguments.actor,
            reason=arguments.reason,
            enforce_gates=not arguments.skip_gates,
        ).to_dict()
    if arguments.command == "skill-install":
        return app.install_skill(arguments.package)
    if arguments.command == "skill-list":
        return app.registry.list()
    if arguments.command == "skill-run":
        return app.run_skill(
            arguments.id,
            load_payload(arguments.input),
            change_id=arguments.change_id,
            approved=arguments.approved,
        )
    if arguments.command == "workflow-run":
        return app.run_workflow(
            WorkflowDefinition.load(arguments.definition),
            load_payload(arguments.input),
            change_id=arguments.change_id,
            approved_steps=set(arguments.approve_step),
        )
    raise ValueError(f"unknown command: {arguments.command}")


def main(argv: list[str] | None = None) -> int:
    try:
        arguments = parser().parse_args(argv)
        emit(execute(arguments))
        return 0
    except (CJHXError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
