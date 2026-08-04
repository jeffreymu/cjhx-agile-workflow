import type { JsonValue } from "./models.js";

const sensitive = ["authorization", "credential", "password", "privatekey", "secret", "token", "apikey"];

export function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const normalized = key.toLowerCase().replaceAll(/[-_]/g, "");
      return [key, sensitive.some((part) => normalized.includes(part)) ? "[REDACTED]" : redact(item)];
    }));
  }
  return value;
}
