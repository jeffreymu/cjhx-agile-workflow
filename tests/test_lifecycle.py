import tempfile
import unittest
from pathlib import Path

from cjhx_agile_workflow.errors import TransitionError, ValidationError
from cjhx_agile_workflow.framework import CJHXFramework
from cjhx_agile_workflow.models import LifecycleState


class LifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.app = CJHXFramework(Path(self.temporary.name) / ".cjhx")
        self.app.create_change("PAY-128", "批量取消订单", "product-owner")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_transition_requires_evidence(self) -> None:
        with self.assertRaisesRegex(TransitionError, "intent-approval"):
            self.app.transition_change(
                "PAY-128",
                LifecycleState.INTENT_CONFIRMED,
                actor="owner",
                reason="confirmed",
            )

        self.app.add_evidence(
            "PAY-128",
            kind="intent-approval",
            source="jira",
            status="approved",
            subject_ref="jira://PAY-128",
        )
        changed = self.app.transition_change(
            "PAY-128",
            LifecycleState.INTENT_CONFIRMED,
            actor="owner",
            reason="confirmed",
        )
        self.assertEqual(changed.state, LifecycleState.INTENT_CONFIRMED)
        self.assertEqual(changed.history[-1].actor, "owner")

    def test_change_id_cannot_escape_workspace(self) -> None:
        with self.assertRaisesRegex(ValidationError, "unsupported characters"):
            self.app.create_change("../escape", "非法路径", "owner")

    def test_duplicate_change_does_not_overwrite_existing_state(self) -> None:
        with self.assertRaisesRegex(ValidationError, "already exists"):
            self.app.create_change("PAY-128", "覆盖", "other-owner")
        existing = self.app.workspace.get_change("PAY-128")
        self.assertEqual(existing.title, "批量取消订单")

    def test_invalid_transition_is_rejected(self) -> None:
        with self.assertRaisesRegex(TransitionError, "cannot transition"):
            self.app.transition_change(
                "PAY-128",
                LifecycleState.IMPLEMENTING,
                actor="agent",
                reason="skip stages",
                enforce_gates=False,
            )


if __name__ == "__main__":
    unittest.main()
