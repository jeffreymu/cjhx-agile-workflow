from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from .errors import AdapterError, PolicyDenied


class JiraAdapter(Protocol):
    def get_issue(self, key: str) -> dict[str, Any]: ...
    def create_issue(self, fields: dict[str, Any]) -> dict[str, Any]: ...
    def update_issue(self, key: str, fields: dict[str, Any]) -> dict[str, Any]: ...
    def transition_issue(self, key: str, state: str) -> dict[str, Any]: ...


class ConfluenceAdapter(Protocol):
    def get_page(self, page_id: str) -> dict[str, Any]: ...
    def create_draft(self, page: dict[str, Any]) -> dict[str, Any]: ...
    def update_draft(self, page_id: str, page: dict[str, Any]) -> dict[str, Any]: ...


class SourceControlAdapter(Protocol):
    def get_repository(self, repository_id: str) -> dict[str, Any]: ...
    def create_branch(self, repository_id: str, name: str, revision: str) -> dict[str, Any]: ...
    def create_change_request(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def publish_commit_status(self, status: dict[str, Any]) -> dict[str, Any]: ...


class DevOpsAdapter(Protocol):
    def trigger_validation(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def get_validation_result(self, run_id: str) -> dict[str, Any]: ...
    def build_artifact(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def deploy_artifact(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def get_deployment_status(self, deployment_id: str) -> dict[str, Any]: ...


class ObservabilityAdapter(Protocol):
    def get_deployment_health(self, deployment_id: str) -> dict[str, Any]: ...
    def get_related_incidents(self, service_id: str) -> list[dict[str, Any]]: ...


@dataclass(frozen=True)
class ToolOperation:
    tool: str
    arguments: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> ToolOperation:
        if not isinstance(value, dict) or not isinstance(value.get("tool"), str):
            raise AdapterError("tool operation requires a string 'tool'")
        arguments = value.get("arguments", {})
        if not isinstance(arguments, dict):
            raise AdapterError("tool operation arguments must be an object")
        return cls(tool=value["tool"], arguments=arguments)


@dataclass
class ToolBroker:
    """Permission-checking gateway used by skills to reach authoritative platforms."""

    jira: JiraAdapter | None = None
    confluence: ConfluenceAdapter | None = None
    source_control: SourceControlAdapter | None = None
    devops: DevOpsAdapter | None = None
    observability: ObservabilityAdapter | None = None

    def execute(self, operation: ToolOperation, permissions: set[str]) -> dict[str, Any]:
        if operation.tool not in permissions:
            raise PolicyDenied(f"skill has no permission for tool: {operation.tool}")
        handlers = {
            "jira.issue.read": (self.jira, "get_issue", ("key",)),
            "jira.issue.create": (self.jira, "create_issue", ("fields",)),
            "jira.issue.update": (self.jira, "update_issue", ("key", "fields")),
            "jira.issue.transition": (self.jira, "transition_issue", ("key", "state")),
            "confluence.page.read": (self.confluence, "get_page", ("pageId",)),
            "confluence.page.create-draft": (self.confluence, "create_draft", ("page",)),
            "confluence.page.update-draft": (self.confluence, "update_draft", ("pageId", "page")),
            "scm.repository.read": (self.source_control, "get_repository", ("repositoryId",)),
            "scm.branch.create": (self.source_control, "create_branch", ("repositoryId", "name", "revision")),
            "scm.change-request.create": (self.source_control, "create_change_request", ("request",)),
            "scm.commit-status.publish": (self.source_control, "publish_commit_status", ("status",)),
            "devops.validation.trigger": (self.devops, "trigger_validation", ("request",)),
            "devops.validation.read": (self.devops, "get_validation_result", ("runId",)),
            "devops.artifact.build": (self.devops, "build_artifact", ("request",)),
            "devops.artifact.deploy": (self.devops, "deploy_artifact", ("request",)),
            "devops.deployment.read": (self.devops, "get_deployment_status", ("deploymentId",)),
            "observability.deployment-health.read": (self.observability, "get_deployment_health", ("deploymentId",)),
            "observability.incidents.read": (self.observability, "get_related_incidents", ("serviceId",)),
        }
        definition = handlers.get(operation.tool)
        if definition is None:
            raise AdapterError(f"unknown tool: {operation.tool}")
        adapter, method_name, argument_names = definition
        if adapter is None:
            raise AdapterError(f"adapter is not configured for tool: {operation.tool}")
        try:
            values = [operation.arguments[name] for name in argument_names]
        except KeyError as error:
            raise AdapterError(f"missing tool argument: {error.args[0]}") from error
        result = getattr(adapter, method_name)(*values)
        if not isinstance(result, (dict, list)):
            raise AdapterError(f"adapter returned unsupported value for {operation.tool}")
        return {"tool": operation.tool, "result": result}


@dataclass
class InMemoryJiraAdapter:
    issues: dict[str, dict[str, Any]] = field(default_factory=dict)

    def get_issue(self, key: str) -> dict[str, Any]:
        if key not in self.issues:
            raise AdapterError(f"Jira issue not found: {key}")
        return dict(self.issues[key])

    def create_issue(self, fields: dict[str, Any]) -> dict[str, Any]:
        key = str(fields.get("key") or f"LOCAL-{len(self.issues) + 1}")
        self.issues[key] = {"key": key, **fields}
        return dict(self.issues[key])

    def update_issue(self, key: str, fields: dict[str, Any]) -> dict[str, Any]:
        current = self.get_issue(key)
        current.update(fields)
        self.issues[key] = current
        return dict(current)

    def transition_issue(self, key: str, state: str) -> dict[str, Any]:
        return self.update_issue(key, {"status": state})


@dataclass
class InMemoryDevOpsAdapter:
    validations: dict[str, dict[str, Any]] = field(default_factory=dict)
    artifacts: dict[str, dict[str, Any]] = field(default_factory=dict)
    deployments: dict[str, dict[str, Any]] = field(default_factory=dict)

    def trigger_validation(self, request: dict[str, Any]) -> dict[str, Any]:
        run_id = str(request.get("runId") or f"validation-{len(self.validations) + 1}")
        self.validations[run_id] = {"runId": run_id, "status": "requested", **request}
        return dict(self.validations[run_id])

    def get_validation_result(self, run_id: str) -> dict[str, Any]:
        if run_id not in self.validations:
            raise AdapterError(f"validation not found: {run_id}")
        return dict(self.validations[run_id])

    def build_artifact(self, request: dict[str, Any]) -> dict[str, Any]:
        artifact_id = str(request.get("artifactId") or f"artifact-{len(self.artifacts) + 1}")
        self.artifacts[artifact_id] = {"artifactId": artifact_id, "status": "built", **request}
        return dict(self.artifacts[artifact_id])

    def deploy_artifact(self, request: dict[str, Any]) -> dict[str, Any]:
        deployment_id = str(request.get("deploymentId") or f"deployment-{len(self.deployments) + 1}")
        self.deployments[deployment_id] = {
            "deploymentId": deployment_id,
            "status": "requested",
            **request,
        }
        return dict(self.deployments[deployment_id])

    def get_deployment_status(self, deployment_id: str) -> dict[str, Any]:
        if deployment_id not in self.deployments:
            raise AdapterError(f"deployment not found: {deployment_id}")
        return dict(self.deployments[deployment_id])


@dataclass
class InMemoryConfluenceAdapter:
    pages: dict[str, dict[str, Any]] = field(default_factory=dict)

    def get_page(self, page_id: str) -> dict[str, Any]:
        if page_id not in self.pages:
            raise AdapterError(f"Confluence page not found: {page_id}")
        return dict(self.pages[page_id])

    def create_draft(self, page: dict[str, Any]) -> dict[str, Any]:
        page_id = str(page.get("id") or len(self.pages) + 1)
        self.pages[page_id] = {"id": page_id, "status": "draft", **page}
        return dict(self.pages[page_id])

    def update_draft(self, page_id: str, page: dict[str, Any]) -> dict[str, Any]:
        current = self.get_page(page_id)
        if current.get("status") != "draft":
            raise AdapterError("only draft pages may be updated by this adapter")
        current.update(page)
        self.pages[page_id] = current
        return dict(current)
