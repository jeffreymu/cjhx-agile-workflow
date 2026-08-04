import { TransitionError } from "./errors.js";
import type { Change, LifecycleState } from "./models.js";
import { utcNow } from "./models.js";

const allowed: Record<LifecycleState, Set<LifecycleState>> = {
  intent_draft: new Set(["intent_confirmed"]),
  intent_confirmed: new Set(["requirement_ready", "intent_draft"]),
  requirement_ready: new Set(["design_approved", "intent_confirmed"]),
  design_approved: new Set(["implementing", "requirement_ready"]),
  implementing: new Set(["reviewing", "requirement_ready"]),
  reviewing: new Set(["verified", "implementing"]),
  verified: new Set(["accepted", "implementing"]),
  accepted: new Set(["release_approved", "requirement_ready"]),
  release_approved: new Set(["deploying", "implementing"]),
  deploying: new Set(["operating", "implementing"]),
  operating: new Set(["outcome_validated", "implementing"]),
  outcome_validated: new Set(["requirement_ready"]),
};

const requiredEvidence: Partial<Record<LifecycleState, Set<string>>> = {
  intent_confirmed: new Set(["intent-approval"]),
  requirement_ready: new Set(["requirement-spec"]),
  design_approved: new Set(["technical-design", "design-approval"]),
  reviewing: new Set(["change-request"]),
  verified: new Set(["code-review", "quality-verification"]),
  accepted: new Set(["acceptance-approval"]),
  release_approved: new Set(["release-plan", "release-approval"]),
  operating: new Set(["deployment-record"]),
  outcome_validated: new Set(["outcome-validation"]),
};

export function missingEvidence(change: Change, target: LifecycleState): string[] {
  const present = new Set(change.evidence.filter((item) => ["passed", "approved", "valid"].includes(item.status.toLowerCase())).map((item) => item.kind));
  return [...(requiredEvidence[target] ?? [])].filter((kind) => !present.has(kind));
}

export function transition(change: Change, target: LifecycleState, options: {
  actor: string; reason: string; evidenceIds?: string[]; enforceGates?: boolean;
}): Change {
  if (!allowed[change.state].has(target)) throw new TransitionError(`cannot transition from ${change.state} to ${target}`);
  const missing = options.enforceGates === false ? [] : missingEvidence(change, target);
  if (missing.length) throw new TransitionError(`transition gate is missing evidence: ${missing.sort().join(", ")}`);
  const previous = change.state;
  change.state = target;
  change.updatedAt = utcNow();
  change.history.push({ fromState: previous, toState: target, actor: options.actor, reason: options.reason, at: utcNow(), evidenceIds: options.evidenceIds ?? [] });
  return change;
}
