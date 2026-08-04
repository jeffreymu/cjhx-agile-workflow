import { ValidationError } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export const lifecycleStates = [
  "intent_draft", "intent_confirmed", "requirement_ready", "design_approved",
  "implementing", "reviewing", "verified", "accepted", "release_approved",
  "deploying", "operating", "outcome_validated",
] as const;
export type LifecycleState = (typeof lifecycleStates)[number];

export const riskLevels = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type RiskLevel = (typeof riskLevels)[number];
export const skillRisks = ["S0", "S1", "S2", "S3", "S4", "S5", "S6"] as const;
export type SkillRisk = (typeof skillRisks)[number];

export interface Evidence {
  id: string;
  kind: string;
  source: string;
  status: string;
  subjectRef: string;
  uri?: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface TransitionRecord {
  fromState: LifecycleState;
  toState: LifecycleState;
  actor: string;
  reason: string;
  at: string;
  evidenceIds: string[];
}

export interface Change {
  id: string;
  title: string;
  owner: string;
  riskLevel: RiskLevel;
  state: LifecycleState;
  description: string;
  links: Record<string, string>;
  metadata: JsonObject;
  evidence: Evidence[];
  history: TransitionRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface Entrypoint {
  type: "builtin" | "process";
  target: string;
}

export interface SkillManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  owner: string;
  source: string;
  riskLevel: SkillRisk;
  entrypoint: Entrypoint;
  permissions: string[];
  tags: string[];
  timeoutSeconds: number;
  requiresHumanConfirmation: boolean;
}

export interface SkillRun {
  id: string;
  skillId: string;
  skillVersion: string;
  changeId?: string;
  status: "succeeded" | "failed";
  startedAt: string;
  completedAt: string;
  input: JsonObject;
  output: JsonObject;
  evidence: JsonObject[];
  error?: string;
}

export const utcNow = (): string => new Date().toISOString();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateIdentifier(value: string, label: string, pattern: RegExp): void {
  if (!value || !pattern.test(value)) throw new ValidationError(`${label} contains unsupported characters`);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result) throw new ValidationError(`missing skill manifest field: ${key}`);
  return result;
}

export function parseSkillManifest(value: unknown): SkillManifest {
  if (!isRecord(value)) throw new ValidationError("skill manifest must be a JSON object");
  const id = requiredString(value, "id");
  const version = requiredString(value, "version");
  validateIdentifier(id, "skill id", /^[a-z0-9][a-z0-9._-]*$/);
  validateIdentifier(version, "skill version", /^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
  const rawEntrypoint = value.entrypoint;
  if (!isRecord(rawEntrypoint)) throw new ValidationError("missing skill manifest field: entrypoint");
  const type = rawEntrypoint.type;
  const target = rawEntrypoint.target;
  if ((type !== "builtin" && type !== "process") || typeof target !== "string") {
    throw new ValidationError("entrypoint requires type builtin/process and a target");
  }
  const riskLevel = requiredString(value, "riskLevel");
  if (!skillRisks.includes(riskLevel as SkillRisk)) throw new ValidationError(`invalid skill risk: ${riskLevel}`);
  const permissions = value.permissions ?? [];
  const tags = value.tags ?? [];
  if (!Array.isArray(permissions) || !permissions.every((item) => typeof item === "string")) {
    throw new ValidationError("permissions must be an array of strings");
  }
  if (!Array.isArray(tags) || !tags.every((item) => typeof item === "string")) {
    throw new ValidationError("tags must be an array of strings");
  }
  const timeoutSeconds = value.timeoutSeconds === undefined ? 120 : Number(value.timeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new ValidationError("timeoutSeconds must be positive");
  return {
    id, version,
    name: requiredString(value, "name"),
    description: requiredString(value, "description"),
    owner: requiredString(value, "owner"),
    source: requiredString(value, "source"),
    riskLevel: riskLevel as SkillRisk,
    entrypoint: { type, target }, permissions: [...permissions], tags: [...tags], timeoutSeconds,
    requiresHumanConfirmation: value.requiresHumanConfirmation === true,
  };
}

export function createChange(input: {
  id: string; title: string; owner: string; description?: string; riskLevel?: RiskLevel;
}): Change {
  validateIdentifier(input.id, "change id", /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  if (!input.title.trim() || !input.owner.trim()) throw new ValidationError("change title and owner are required");
  const now = utcNow();
  return {
    id: input.id, title: input.title, owner: input.owner,
    riskLevel: input.riskLevel ?? "L1", state: "intent_draft",
    description: input.description ?? "", links: {}, metadata: {}, evidence: [], history: [],
    createdAt: now, updatedAt: now,
  };
}
