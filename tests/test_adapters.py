import unittest

from cjhx_agile_workflow.adapters import InMemoryJiraAdapter, ToolBroker, ToolOperation
from cjhx_agile_workflow.errors import AdapterError, PolicyDenied


class AdapterTests(unittest.TestCase):
    def test_broker_enforces_declared_permission(self) -> None:
        broker = ToolBroker(jira=InMemoryJiraAdapter({"PAY-1": {"key": "PAY-1"}}))
        operation = ToolOperation("jira.issue.read", {"key": "PAY-1"})
        with self.assertRaises(PolicyDenied):
            broker.execute(operation, set())
        result = broker.execute(operation, {"jira.issue.read"})
        self.assertEqual(result["result"]["key"], "PAY-1")

    def test_broker_fails_when_adapter_is_not_configured(self) -> None:
        broker = ToolBroker()
        with self.assertRaisesRegex(AdapterError, "not configured"):
            broker.execute(
                ToolOperation("devops.validation.read", {"runId": "1"}),
                {"devops.validation.read"},
            )


if __name__ == "__main__":
    unittest.main()
