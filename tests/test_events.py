import tempfile
import unittest
from pathlib import Path

from cjhx_agile_workflow.errors import ValidationError
from cjhx_agile_workflow.events import EventEnvelope, EventInbox
from cjhx_agile_workflow.storage import Workspace


class EventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.inbox = EventInbox(Workspace(Path(self.temporary.name) / ".cjhx"))
        self.event = EventEnvelope(
            event_id="evt-1",
            event_type="devops.validation.completed",
            source="devops",
            change_id="PAY-128",
            correlation_id="corr-1",
            payload={"runId": "run-1"},
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_event_id_cannot_escape_workspace(self) -> None:
        with self.assertRaisesRegex(ValidationError, "unsupported characters"):
            EventEnvelope(
                event_id="../escape",
                event_type="test",
                source="test",
                change_id="PAY-128",
                correlation_id="corr",
                payload={},
            )

    def test_duplicate_event_is_idempotent(self) -> None:
        self.assertTrue(self.inbox.accept(self.event))
        self.assertFalse(self.inbox.accept(self.event))

    def test_reused_event_id_with_different_content_is_rejected(self) -> None:
        self.inbox.accept(self.event)
        conflicting = EventEnvelope(
            event_id="evt-1",
            event_type="devops.validation.failed",
            source="devops",
            change_id="PAY-128",
            correlation_id="corr-1",
            payload={},
        )
        with self.assertRaisesRegex(ValidationError, "reused"):
            self.inbox.accept(conflicting)


if __name__ == "__main__":
    unittest.main()
