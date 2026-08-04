import type { SourceControlAdapter, ToolBroker } from "./adapters.js";
import { ValidationError } from "./errors.js";
import { isRecord, type JsonValue } from "./models.js";
import type { Workspace } from "./storage.js";

export const sourceControlProviders = ["gitlab", "github"] as const;
export type SourceControlProvider = typeof sourceControlProviders[number];
export interface SourceControlSummary { configured: boolean; activeProvider?: SourceControlProvider; source: "none" | "runtime" | "workspace" }

export class SourceControlIntegrationManager {
  private readonly fallback: SourceControlAdapter | undefined;
  private active: SourceControlProvider | undefined;
  constructor(private readonly workspace: Workspace, private readonly tools: ToolBroker) { this.fallback = tools.getAdapter("sourceControl"); this.active = this.readActive(); }
  summary(): SourceControlSummary { return { configured: this.tools.hasAdapter("sourceControl"), ...(this.active ? { activeProvider: this.active } : {}), source: this.active ? "workspace" : this.fallback ? "runtime" : "none" }; }
  isActive(provider: SourceControlProvider): boolean { return this.active === provider; }
  activate(provider: SourceControlProvider, adapter: SourceControlAdapter, persist = true): SourceControlSummary { this.active = provider; this.tools.setAdapter("sourceControl", adapter); if (persist) this.workspace.saveIntegrationConfig("source-control", { schemaVersion: 1, activeProvider: provider, updatedAt: new Date().toISOString() }); return this.summary(); }
  remove(provider: SourceControlProvider): SourceControlSummary { if (this.active !== provider) return this.summary(); this.active = undefined; this.workspace.removeIntegrationConfig("source-control"); if (this.fallback) this.tools.setAdapter("sourceControl", this.fallback); else this.tools.removeAdapter("sourceControl"); return this.summary(); }
  private readActive(): SourceControlProvider | undefined { if (!this.workspace.integrationExists("source-control")) return undefined; const raw: JsonValue = this.workspace.getIntegrationConfig("source-control"); if (!isRecord(raw) || typeof raw.activeProvider !== "string" || !sourceControlProviders.includes(raw.activeProvider as SourceControlProvider)) throw new ValidationError("invalid source-control integration selection"); return raw.activeProvider as SourceControlProvider; }
}
