from __future__ import annotations

from typing import Any


SENSITIVE_KEY_PARTS = (
    "authorization",
    "credential",
    "password",
    "privatekey",
    "secret",
    "token",
    "apikey",
    "api_key",
)


def redact(value: Any) -> Any:
    """Create a JSON-compatible audit copy with common credential fields removed."""
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "").replace("_", "")
            sensitive = any(
                part.replace("_", "") in normalized for part in SENSITIVE_KEY_PARTS
            )
            result[str(key)] = "[REDACTED]" if sensitive else redact(item)
        return result
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return [redact(item) for item in value]
    return value
