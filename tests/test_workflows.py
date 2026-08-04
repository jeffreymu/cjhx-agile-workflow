import tempfile
import unittest
from pathlib import Path

from cjhx_agile_workflow.errors import ValidationError
from cjhx_agile_workflow.framework import CJHXFramework
from cjhx_agile_workflow.workflows import WorkflowDefinition


ROOT = Path(__file__).resolve().parents[1]


class WorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.app = CJHXFramework(Path(self.temporary.name) / ".cjhx")
        self.app.install_skill(ROOT / "examples/skills/requirement-decompose")
        self.app.install_skill(ROOT / "examples/skills/test-case-generate")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_composes_installed_skills_and_resolves_references(self) -> None:
        definition = WorkflowDefinition.load(ROOT / "examples/requirement-to-tests.workflow.json")
        run = self.app.run_workflow(
            definition,
            {
                "requirement": "支持批量取消；记录审计日志",
                "feature": "批量取消订单",
                "acceptanceCriteria": ["返回每个订单的处理结果"],
            },
            change_id="PAY-128",
        )
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(len(run["steps"]), 2)
        self.assertEqual(run["steps"][1]["output"]["feature"], "批量取消订单")

    def test_missing_reference_fails_closed(self) -> None:
        definition = WorkflowDefinition.load(ROOT / "examples/requirement-to-tests.workflow.json")
        with self.assertRaisesRegex(ValidationError, "reference not found"):
            self.app.run_workflow(definition, {"requirement": "only"})


if __name__ == "__main__":
    unittest.main()
