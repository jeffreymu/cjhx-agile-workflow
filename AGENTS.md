# CJHX Agile Workflow contributor guide

- Keep the core platform-neutral: use `SourceControlAdapter`, never a vendor name in lifecycle contracts.
- Jira owns work-item state; Confluence owns long-form requirements/design; DevOps owns verification, artifacts, and deployment.
- Skills never receive platform credentials. All platform access must pass through `ToolBroker` permissions.
- Every externally supplied skill is untrusted. Preserve digest locking, timeout, minimal environment, and fail-closed behavior.
- Add or update `unittest` coverage for behavior changes.
- Run `PYTHONPATH=src python3 -m unittest discover -s tests -v` before committing.
