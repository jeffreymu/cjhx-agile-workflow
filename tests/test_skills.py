import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from cjhx_agile_workflow.adapters import (
    InMemoryConfluenceAdapter,
    InMemoryDevOpsAdapter,
    ToolBroker,
)
from cjhx_agile_workflow.errors import PolicyDenied, SkillError
from cjhx_agile_workflow.framework import CJHXFramework
from cjhx_agile_workflow.policy import Policy


ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples" / "skills"


class SkillTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temporary.name) / ".cjhx"
        self.confluence = InMemoryConfluenceAdapter()
        self.devops = InMemoryDevOpsAdapter()
        self.app = CJHXFramework(
            self.workspace,
            tools=ToolBroker(confluence=self.confluence, devops=self.devops),
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_installs_locks_and_runs_builtin_skill(self) -> None:
        installed = self.app.install_skill(EXAMPLES / "requirement-decompose")
        self.assertTrue(installed["digest"].startswith("sha256:"))

        run = self.app.run_skill(
            "requirement.decompose",
            {"requirement": "支持批量取消订单；记录审计日志"},
            change_id="PAY-128",
        )
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(len(run["output"]["tasks"]), 2)
        lock = json.loads((self.workspace / "skills-lock.json").read_text())
        self.assertEqual(lock["skills"]["requirement.decompose"]["version"], "1.0.0")

    def test_write_skill_requires_approval_and_uses_tool_broker(self) -> None:
        self.app.install_skill(EXAMPLES / "jira-confluence-sync")
        payload = {"issue": {"key": "PAY-128", "summary": "批量取消", "description": "需求"}}
        with self.assertRaisesRegex(PolicyDenied, "approval"):
            self.app.run_skill("sync.jira-requirement-to-confluence", payload)

        run = self.app.run_skill(
            "sync.jira-requirement-to-confluence",
            payload,
            approved=True,
        )
        created = run["output"]["toolResults"][0]["result"]
        self.assertEqual(created["changeId"], "PAY-128")
        self.assertEqual(created["status"], "draft")

    def test_external_process_skill_must_be_explicitly_enabled(self) -> None:
        with self.assertRaisesRegex(PolicyDenied, "process skills are disabled"):
            self.app.install_skill(EXAMPLES / "api-test-generate")

        enabled = CJHXFramework(
            Path(self.temporary.name) / ".external-cjhx",
            policy=Policy(allow_process_skills=True),
        )
        enabled.install_skill(EXAMPLES / "api-test-generate")
        run = enabled.run_skill(
            "api-test.generate",
            {"operation": {"method": "POST", "path": "/orders/cancel"}},
        )
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(len(run["output"]["cases"]), 3)

    def test_code_review_returns_structured_findings(self) -> None:
        self.app.install_skill(EXAMPLES / "code-review")
        run = self.app.run_skill(
            "review.code.basic",
            {"changedFiles": [{"path": "app.py", "content": "password = 'secret'"}]},
        )
        self.assertEqual(run["output"]["decision"], "request-changes")
        self.assertEqual(run["output"]["findings"][0]["category"], "security")

    def test_api_test_uses_devops_adapter_after_approval(self) -> None:
        self.app.install_skill(EXAMPLES / "api-test-execute")
        run = self.app.run_skill(
            "api-test.execute",
            {
                "changeId": "PAY-128",
                "suiteRef": "artifact://tests/api",
                "environment": "test",
            },
            approved=True,
        )
        requested = run["output"]["toolResults"][0]["result"]
        self.assertEqual(requested["validationType"], "api")
        self.assertEqual(requested["status"], "requested")

    def test_redacts_credentials_from_audit_record(self) -> None:
        self.app.install_skill(EXAMPLES / "requirement-decompose")
        run = self.app.run_skill(
            "requirement.decompose",
            {"requirement": "测试", "apiToken": "do-not-persist"},
        )
        persisted = json.loads((self.workspace / "runs" / f"{run['id']}.json").read_text())
        self.assertEqual(persisted["input"]["apiToken"], "[REDACTED]")

    @unittest.skipUnless(hasattr(os, "symlink"), "symbolic links are not supported")
    def test_rejects_skill_package_with_symbolic_link(self) -> None:
        package = Path(self.temporary.name) / "linked-skill"
        shutil.copytree(EXAMPLES / "requirement-decompose", package)
        os.symlink("/etc/passwd", package / "escape")
        with self.assertRaisesRegex(SkillError, "symbolic links"):
            self.app.install_skill(package)

    def test_detects_installed_package_tampering(self) -> None:
        installed = self.app.install_skill(EXAMPLES / "test-case-generate")
        (Path(installed["path"]) / "tampered.txt").write_text("bad", encoding="utf-8")
        with self.assertRaisesRegex(SkillError, "digest mismatch"):
            self.app.run_skill("test.case.generate", {"feature": "登录"})


if __name__ == "__main__":
    unittest.main()
