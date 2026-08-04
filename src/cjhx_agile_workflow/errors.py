class CJHXError(Exception):
    """Base error for the framework."""


class ValidationError(CJHXError):
    """Input or persisted data does not satisfy a contract."""


class TransitionError(CJHXError):
    """A lifecycle transition is invalid or its gate is not met."""


class SkillError(CJHXError):
    """A skill could not be installed, resolved, or executed."""


class PolicyDenied(SkillError):
    """A policy denied a skill operation."""


class AdapterError(CJHXError):
    """An external platform adapter failed."""
