import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute, sep } from "node:path";
import type { AgentExecutor, AgentExecutionPlan } from "../agents.js";
import type { HarnessCheckExecutor, HarnessCheckRequest, HarnessCheckExecution, RuleSnapshot } from "../harness.js";
import { PolicyDenied } from "../errors.js";
import { compileSandboxPolicy, type SandboxPolicy } from "./policy.js";
import type { SandboxConfig } from "./config.js";
import type { RunnerEvent, RunnerRequest } from "./runner.js";

export class SandboxExecutor implements AgentExecutor, HarnessCheckExecutor {
  readonly id = "anthropic-srt-0.0.80";
  private approvedPostflight = new Map<string, string>();
  constructor(readonly config: SandboxConfig, readonly controlRoot: string) {}
  capabilities(): Set<string> { return new Set(["process.arguments", "process.timeout", "process.output-limit", "network.none", "network.allowlist", "filesystem.restricted"]); }
  policy(cwd: string, snapshot: RuleSnapshot, purpose: SandboxPolicy["purpose"]): SandboxPolicy {
    const installation = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
    const part = relative(realpathSync(cwd), installation);
    if (part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))) throw new PolicyDenied("Sandbox execution repository must not contain the control-plane installation");
    const piPart = relative(realpathSync(cwd), this.config.piEntry);
    if (piPart === "" || (!isAbsolute(piPart) && piPart !== ".." && !piPart.startsWith(`..${sep}`))) throw new PolicyDenied("Sandbox Pi installation must be outside the execution repository");
    return compileSandboxPolicy({ executionRoot: cwd, controlRoot: this.controlRoot, readRoots: this.config.readRoots, modelHosts: this.config.modelHosts }, snapshot, purpose);
  }
  start(plan: AgentExecutionPlan): ChildProcessWithoutNullStreams {
    if (!plan.ruleSnapshot || plan.executionMode || plan.tokenLimit) throw new PolicyDenied("Sandbox supports only single Workspace Agent executions");
    const postflight = this.policy(plan.cwd, plan.ruleSnapshot, "postflight");
    this.approvedPostflight.set(`${postflight.executionRoot}:${plan.ruleSnapshot.digest}`, postflight.digest);
    const environment: Record<string, string> = {};
    for (const key of ["PATH", "LANG", ...this.config.credentialKeys]) if (typeof plan.environment[key] === "string") environment[key] = plan.environment[key]!;
    return this.launch({ policy: this.policy(plan.cwd, plan.ruleSnapshot, "agent"), command: process.execPath, arguments: [this.config.piEntry, "--print", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline", "--model", this.config.model, "--tools", "read,bash,edit,write,grep,find,ls", "--", plan.prompt ?? ""], environment, timeoutMs: 120 * 60_000, outputLimit: 1_048_576 });
  }
  private launch(request: RunnerRequest): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./runner.js", import.meta.url))], { env: { PATH: process.env.PATH, LANG: process.env.LANG, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ["pipe", "pipe", "pipe", "ipc"], shell: false, detached: process.platform !== "win32" }) as ChildProcessWithoutNullStreams;
    child.send(request, error => { if (error) child.kill(); });
    const watchdog = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } }, request.timeoutMs + 10_000);
    watchdog.unref(); child.once("close", () => clearTimeout(watchdog));
    return child;
  }
  async execute(request: HarnessCheckRequest): Promise<HarnessCheckExecution> {
    const script = { "npm.typecheck": "typecheck", "npm.test": "test", "npm.check": "check" }[request.checkId];
    if (!script || request.command !== "npm" || JSON.stringify(request.arguments) !== JSON.stringify(["run", script])) throw new PolicyDenied("Sandbox Postflight only supports the fixed npm catalog");
    const policy = this.policy(request.cwd, request.ruleSnapshot, "postflight");
    if (this.approvedPostflight.get(`${policy.executionRoot}:${request.ruleSnapshot.digest}`) !== policy.digest) throw new PolicyDenied("Postflight permissions differ from the approved Sandbox execution");
    const child = this.launch({ policy, command: "npm", arguments: ["run", script], environment: { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C" }, timeoutMs: request.timeoutMs, outputLimit: request.outputLimit });
    child.stdin.end();
    return await new Promise((accept, reject) => {
      let stdout = ""; let stderr = ""; let completed = false;
      child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString("utf8")).slice(0, request.outputLimit); });
      child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(0, request.outputLimit); });
      child.on("message", (value: RunnerEvent) => { if (value && value.kind === "completed" && value.cleanup === "completed") completed = true; });
      child.on("error", () => reject(new Error("Sandbox Runner failed")));
      child.on("close", code => accept({ exitCode: completed && code === 0 ? 0 : -1, stdout, stderr }));
    });
  }
}
