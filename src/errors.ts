export class CJHXError extends Error {
  override readonly name: string = "CJHXError";
}

export class ValidationError extends CJHXError {
  override readonly name: string = "ValidationError";
}

export class TransitionError extends CJHXError {
  override readonly name: string = "TransitionError";
}

export class SkillError extends CJHXError {
  override readonly name: string = "SkillError";
}

export class PolicyDenied extends SkillError {
  override readonly name: string = "PolicyDenied";
}

export class AdapterError extends CJHXError {
  override readonly name: string = "AdapterError";
}
