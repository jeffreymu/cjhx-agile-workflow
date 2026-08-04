import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ValidationError } from "./errors.js";
import type { JsonObject } from "./models.js";
import { utcNow, validateIdentifier } from "./models.js";
import { Workspace } from "./storage.js";

export interface EventEnvelope { eventId: string; eventType: string; source: string; changeId: string; correlationId: string; payload: JsonObject; occurredAt: string }
export function createEvent(input: Omit<EventEnvelope, "occurredAt"> & { occurredAt?: string }): EventEnvelope {
  validateIdentifier(input.eventId, "event id", /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  for (const value of [input.eventType, input.source, input.changeId, input.correlationId]) if (!value.trim()) throw new ValidationError("event fields cannot be empty");
  return { ...input, occurredAt: input.occurredAt ?? utcNow() };
}
export class EventInbox {
  private readonly path: string;
  constructor(private readonly workspace: Workspace) { this.path = resolve(workspace.root, "events", "inbox"); }
  accept(event: EventEnvelope): boolean {
    this.workspace.initialize(); const record = resolve(this.path, `${event.eventId}.json`);
    if (existsSync(record)) { if (JSON.stringify(this.workspace.readJson(record)) !== JSON.stringify(event)) throw new ValidationError(`event id was reused with different content: ${event.eventId}`); return false; }
    this.workspace.writeJson(record, event as unknown as JsonObject); return true;
  }
}
