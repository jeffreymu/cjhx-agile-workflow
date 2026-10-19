import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSandboxRuntimeHost, sandboxRuntimeVersion, type SandboxPolicy } from "./policy.js";

export interface RunnerRequest { policy: SandboxPolicy; command: string; arguments: string[]; environment: Record<string, string>; timeoutMs: number; outputLimit: number }
export interface RunnerEvent { kind: "ready" | "completed" | "failed"; policyDigest: string; cleanup?: "completed" | "failed"; exitCode?: number }

// This module is a host-side supervisor. It is never loaded from Agent-controlled files.
async function main(): Promise<void> {
  let manager: { reset(): Promise<void> } | undefined; let child: ChildProcess | undefined;
  let stage = "host-check";
  let privateRoot: string | undefined; let finished = false; let timer: NodeJS.Timeout | undefined;
  const send = (event: RunnerEvent) => { if (process.connected) process.send?.(event); };
  const request = await new Promise<RunnerRequest>(accept => process.once("message", value => accept(value as RunnerRequest)));
  const finish = async (code: number, failed: boolean) => {
    if (finished) return; finished = true; if (timer) clearTimeout(timer);
    let cleanup: "completed" | "failed" = "completed";
    try { if (child?.pid) { if (process.platform === "win32") throw new Error("Unsupported cleanup"); try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } } catch { cleanup = "failed"; }
    try { await manager?.reset(); } catch { cleanup = "failed"; }
    try { if (privateRoot) rmSync(privateRoot, { recursive: true, force: true }); } catch { cleanup = "failed"; }
    send({ kind: failed || cleanup === "failed" ? "failed" : "completed", policyDigest: request.policy.digest, cleanup, exitCode: code });
    process.exitCode = failed || cleanup === "failed" ? 1 : code === 0 ? 0 : 1;
    process.disconnect?.();
  };
  process.on("SIGTERM", () => { void finish(-1, true); });
  process.on("disconnect", () => { if (!finished) void finish(-1, true); });
  timer = setTimeout(() => { void finish(-1, true); }, request.timeoutMs);
  try {
    assertSandboxRuntimeHost();
    if (request.policy.runtimeVersion !== sandboxRuntimeVersion || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || !Number.isSafeInteger(request.outputLimit) || request.outputLimit < 1) throw new Error("Invalid Runner request");
    // Windows needs an independently verified job-object cancellation contract. Never use a host fallback.
    if (process.platform === "win32") throw new Error("Windows sandbox Runner verification pending");
    stage = "runtime-load";
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@anthropic-ai/sandbox-runtime");
    const meta = JSON.parse(readFileSync(resolve(dirname(entry), "../package.json"), "utf8")) as { version: string };
    if (meta.version !== sandboxRuntimeVersion) throw new Error("Sandbox runtime version mismatch");
    const sdk = await import("@anthropic-ai/sandbox-runtime"); manager = sdk.SandboxManager;
    stage = "dependency-check";
    if ((await sdk.SandboxManager.checkDependenciesAsync()).errors.length) throw new Error("Sandbox dependencies unavailable");
    if (finished) return;
    stage = "private-directory";
    privateRoot = realpathSync(mkdtempSync(resolve(process.platform === "darwin" ? "/private/tmp" : "/tmp", "cjhx-srt-")));
    const home = resolve(privateRoot, "home"); const temp = resolve(privateRoot, "tmp"); mkdirSync(home); mkdirSync(temp);
    // Upstream embeds TMPDIR into its command wrapper, so set it before wrapping.
    process.env.CLAUDE_CODE_TMPDIR = temp; process.env.CLAUDE_TMPDIR = temp;
    const literal = (path: string) => ({ path, literal: true as const });
    const p = request.policy;
    stage = "runtime-initialize";
    await sdk.SandboxManager.initialize({ network: { allowedDomains: p.allowedHosts, deniedDomains: [], strictAllowlist: true, deniedResolvedAddresses: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"], allowLocalBinding: false, allowAllUnixSockets: false }, filesystem: { denyRead: [literal("/"), ...p.deniedPaths.map(literal)], allowRead: [...p.readRoots, privateRoot].map(literal), allowWrite: [...p.writeRoots, privateRoot].map(literal), denyWrite: [...p.deniedPaths, "/tmp/claude", "/private/tmp/claude", "/dev/tty"].map(literal) } });
    if (finished) { await sdk.SandboxManager.reset(); return; }
    const environment: NodeJS.ProcessEnv = { ...request.environment, HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp, PI_CODING_AGENT_DIR: resolve(home, ".pi/agent"), PI_OFFLINE: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", npm_config_cache: resolve(home, ".npm"), npm_config_userconfig: resolve(home, ".npmrc") };
    const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
    stage = "runtime-wrap";
    const wrapped = await sdk.SandboxManager.wrapWithSandboxArgv([request.command, ...request.arguments].map(quote).join(" "), "/bin/bash", undefined, undefined, p.executionRoot, { commandId: `cjhx-${process.pid}-${p.digest.slice(-32)}` });
    if (finished) { await sdk.SandboxManager.reset(); return; }
    const [command, ...args] = wrapped.argv; if (!command) throw new Error("Empty sandbox wrapper");
    stage = "sandbox-spawn";
    child = spawn(command, args, { cwd: p.executionRoot, env: { ...wrapped.env, ...environment }, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let bytes = 0;
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) stream!.on("data", (data: Buffer) => { const remaining = request.outputLimit - bytes; bytes += data.length; if (remaining > 0) destination.write(data.subarray(0, remaining)); if (bytes > request.outputLimit) void finish(-1, true); });
    child.once("error", () => { void finish(-1, true); });
    child.once("spawn", () => send({ kind: "ready", policyDigest: p.digest }));
    child.once("close", code => { void finish(code ?? -1, false); });
    process.stdin.pipe(child.stdin!);
  } catch { process.stderr.write(`Sandbox failed at ${stage}; no host fallback was attempted\n`); await finish(-1, true); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
