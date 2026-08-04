from __future__ import annotations

from collections.abc import Iterable

from .errors import TransitionError
from .models import Change, LifecycleState, TransitionRecord, utc_now


ALLOWED_TRANSITIONS: dict[LifecycleState, set[LifecycleState]] = {
    LifecycleState.INTENT_DRAFT: {LifecycleState.INTENT_CONFIRMED},
    LifecycleState.INTENT_CONFIRMED: {LifecycleState.REQUIREMENT_READY, LifecycleState.INTENT_DRAFT},
    LifecycleState.REQUIREMENT_READY: {LifecycleState.DESIGN_APPROVED, LifecycleState.INTENT_CONFIRMED},
    LifecycleState.DESIGN_APPROVED: {LifecycleState.IMPLEMENTING, LifecycleState.REQUIREMENT_READY},
    LifecycleState.IMPLEMENTING: {LifecycleState.REVIEWING, LifecycleState.REQUIREMENT_READY},
    LifecycleState.REVIEWING: {LifecycleState.VERIFIED, LifecycleState.IMPLEMENTING},
    LifecycleState.VERIFIED: {LifecycleState.ACCEPTED, LifecycleState.IMPLEMENTING},
    LifecycleState.ACCEPTED: {LifecycleState.RELEASE_APPROVED, LifecycleState.REQUIREMENT_READY},
    LifecycleState.RELEASE_APPROVED: {LifecycleState.DEPLOYING, LifecycleState.IMPLEMENTING},
    LifecycleState.DEPLOYING: {LifecycleState.OPERATING, LifecycleState.IMPLEMENTING},
    LifecycleState.OPERATING: {LifecycleState.OUTCOME_VALIDATED, LifecycleState.IMPLEMENTING},
    LifecycleState.OUTCOME_VALIDATED: {LifecycleState.REQUIREMENT_READY},
}

REQUIRED_EVIDENCE: dict[LifecycleState, set[str]] = {
    LifecycleState.INTENT_CONFIRMED: {"intent-approval"},
    LifecycleState.REQUIREMENT_READY: {"requirement-spec"},
    LifecycleState.DESIGN_APPROVED: {"technical-design", "design-approval"},
    LifecycleState.REVIEWING: {"change-request"},
    LifecycleState.VERIFIED: {"code-review", "quality-verification"},
    LifecycleState.ACCEPTED: {"acceptance-approval"},
    LifecycleState.RELEASE_APPROVED: {"release-plan", "release-approval"},
    LifecycleState.OPERATING: {"deployment-record"},
    LifecycleState.OUTCOME_VALIDATED: {"outcome-validation"},
}


def missing_evidence(change: Change, target: LifecycleState) -> set[str]:
    present = {item.kind for item in change.evidence if item.status.lower() in {"passed", "approved", "valid"}}
    return REQUIRED_EVIDENCE.get(target, set()) - present


def transition(
    change: Change,
    target: LifecycleState,
    *,
    actor: str,
    reason: str,
    evidence_ids: Iterable[str] = (),
    enforce_gates: bool = True,
) -> Change:
    target = LifecycleState(target)
    if target not in ALLOWED_TRANSITIONS[change.state]:
        raise TransitionError(f"cannot transition from {change.state.value} to {target.value}")
    missing = missing_evidence(change, target) if enforce_gates else set()
    if missing:
        raise TransitionError(f"transition gate is missing evidence: {', '.join(sorted(missing))}")
    previous = change.state
    change.state = target
    change.updated_at = utc_now()
    change.history.append(
        TransitionRecord(
            from_state=previous.value,
            to_state=target.value,
            actor=actor,
            reason=reason,
            evidence_ids=list(evidence_ids),
        )
    )
    return change
