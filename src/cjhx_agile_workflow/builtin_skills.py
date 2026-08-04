from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from .errors import SkillError


BuiltinHandler = Callable[[dict[str, Any]], dict[str, Any]]


def requirement_decompose(payload: dict[str, Any]) -> dict[str, Any]:
    requirement = str(payload.get("requirement", "")).strip()
    if not requirement:
        raise SkillError("requirement is required")
    fragments = [item.strip(" 。；;\n\t") for item in re.split(r"[。；;\n]+", requirement) if item.strip()]
    tasks = [
        {
            "id": f"TASK-{index:02d}",
            "title": fragment,
            "acceptanceCriteria": [f"已验证：{fragment}"],
            "dependencies": [],
        }
        for index, fragment in enumerate(fragments, start=1)
    ]
    return {
        "output": {
            "summary": f"需求已拆分为 {len(tasks)} 个可跟踪任务",
            "tasks": tasks,
            "unresolvedQuestions": payload.get("unresolvedQuestions", []),
        },
        "evidence": [],
        "operations": [],
    }


def test_case_generate(payload: dict[str, Any]) -> dict[str, Any]:
    feature = str(payload.get("feature", "")).strip()
    if not feature:
        raise SkillError("feature is required")
    acceptance = payload.get("acceptanceCriteria", [])
    if not isinstance(acceptance, list):
        raise SkillError("acceptanceCriteria must be an array")
    cases = [
        {
            "id": f"TC-{index:03d}",
            "type": "acceptance",
            "given": "系统处于可用状态且测试数据已准备",
            "when": str(criterion),
            "then": f"满足验收标准：{criterion}",
        }
        for index, criterion in enumerate(acceptance, start=1)
    ]
    cases.extend(
        [
            {
                "id": f"TC-{len(cases) + 1:03d}",
                "type": "boundary",
                "given": "输入处于允许范围边界",
                "when": f"执行 {feature}",
                "then": "系统返回明确且可验证的结果",
            },
            {
                "id": f"TC-{len(cases) + 2:03d}",
                "type": "failure",
                "given": "依赖不可用或输入非法",
                "when": f"执行 {feature}",
                "then": "系统安全失败并返回可诊断信息",
            },
        ]
    )
    return {"output": {"feature": feature, "testCases": cases}, "evidence": [], "operations": []}


def code_review(payload: dict[str, Any]) -> dict[str, Any]:
    changed_files = payload.get("changedFiles")
    if not isinstance(changed_files, list):
        raise SkillError("changedFiles must be an array")
    findings: list[dict[str, Any]] = []
    rules = (
        ("TODO", "minor", "maintainability", "变更中包含未完成的 TODO"),
        ("eval(", "blocker", "security", "避免执行未经验证的动态代码"),
        ("password =", "blocker", "security", "疑似硬编码凭据"),
    )
    for changed_file in changed_files:
        if not isinstance(changed_file, dict):
            raise SkillError("each changed file must be an object")
        path = str(changed_file.get("path", "unknown"))
        content = str(changed_file.get("content", changed_file.get("diff", "")))
        for line_number, line in enumerate(content.splitlines(), start=1):
            for marker, severity, category, message in rules:
                if marker.lower() in line.lower():
                    findings.append(
                        {
                            "severity": severity,
                            "category": category,
                            "file": path,
                            "line": line_number,
                            "description": message,
                            "evidence": line.strip()[:200],
                            "confidence": 0.9,
                        }
                    )
    return {
        "output": {
            "decision": "request-changes" if any(item["severity"] == "blocker" for item in findings) else "comment",
            "findings": findings,
            "note": "示例 Skill 仅演示契约；生产环境应安装组织批准的语义评审 Skill。",
        },
        "evidence": [],
        "operations": [],
    }


def api_test_execute(payload: dict[str, Any]) -> dict[str, Any]:
    change_id = str(payload.get("changeId", "")).strip()
    suite_ref = str(payload.get("suiteRef", "")).strip()
    environment = str(payload.get("environment", "")).strip()
    if not change_id or not suite_ref or not environment:
        raise SkillError("changeId, suiteRef, and environment are required")
    request = {
        "changeId": change_id,
        "validationType": "api",
        "suiteRef": suite_ref,
        "environment": environment,
        "subjectRef": payload.get("subjectRef"),
    }
    return {
        "output": {"status": "validation-requested", "changeId": change_id},
        "evidence": [],
        "operations": [
            {"tool": "devops.validation.trigger", "arguments": {"request": request}}
        ],
    }


def jira_confluence_sync(payload: dict[str, Any]) -> dict[str, Any]:
    issue = payload.get("issue")
    if not isinstance(issue, dict) or not issue.get("key") or not issue.get("summary"):
        raise SkillError("issue with key and summary is required")
    body = {
        "changeId": issue["key"],
        "title": f"{issue['key']} {issue['summary']}",
        "body": issue.get("description", ""),
        "source": f"jira://{issue['key']}",
    }
    return {
        "output": {"sync": "draft-requested", "changeId": issue["key"]},
        "evidence": [],
        "operations": [
            {"tool": "confluence.page.create-draft", "arguments": {"page": body}}
        ],
    }


BUILTINS: dict[str, BuiltinHandler] = {
    "requirement_decompose": requirement_decompose,
    "test_case_generate": test_case_generate,
    "code_review": code_review,
    "api_test_execute": api_test_execute,
    "jira_confluence_sync": jira_confluence_sync,
}
