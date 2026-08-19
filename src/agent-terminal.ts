import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentProfile } from "./agents.js";
import { ValidationError } from "./errors.js";

export interface AgentTerminalLaunch { scriptPath: string; opener: string; arguments: string[] }
export type AgentTerminalLauncher = (script: string) => AgentTerminalLaunch;

function shQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n")) throw new ValidationError("Agent terminal values may not contain control characters");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildAgentTerminalScript(profile: Pick<AgentProfile, "name" | "command" | "arguments" | "versionArguments">, options: { cwd?: string } = {}): string {
  const versionArguments = profile.versionArguments ?? ["--version"];
  const lines = [
    "#!/bin/sh",
    `echo ${shQuote(`CJHX Agent 终端验证: ${profile.name}`)}`,
    `echo ${shQuote(`非交互命令模板: ${[profile.command, ...profile.arguments].join(" ")}`)}`,
    `echo ${shQuote("CJHX 通过参数数组执行命令，不经过 Shell；此终端仅用于人工验证。")}`,
    ...(options.cwd ? [`cd ${shQuote(options.cwd)} || { echo ${shQuote(`工作目录不可用: ${options.cwd}`)}; exit 1; }`] : []),
    `echo ${shQuote(`— 版本测试: ${[profile.command, ...versionArguments].join(" ")} —`)}`,
    `${[profile.command, ...versionArguments].map(shQuote).join(" ")} || { echo ${shQuote("版本测试失败：请确认命令在 PATH 中可用。")}; exit 1; }`,
    `echo ${shQuote("— 进入交互式会话；退出 Agent 后本脚本结束 —")}`,
    `exec ${shQuote(profile.command)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function openAgentTerminal(script: string): AgentTerminalLaunch {
  const directory = mkdtempSync(resolve(tmpdir(), "cjhx-agent-terminal-"));
  const platform = process.platform;
  const scriptPath = resolve(directory, platform === "darwin" ? "verify.command" : platform === "win32" ? "verify.bat" : "verify.sh");
  writeFileSync(scriptPath, script, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  let opener: string; let args: string[];
  if (platform === "darwin") { opener = "open"; args = ["-a", "Terminal", scriptPath]; }
  else if (platform === "win32") { opener = "cmd"; args = ["/c", "start", "cmd", "/k", scriptPath]; }
  else { opener = "x-terminal-emulator"; args = ["-e", scriptPath]; }
  const child = spawn(opener, args, { detached: true, stdio: "ignore", shell: false });
  child.on("error", () => undefined); child.unref();
  return { scriptPath, opener, arguments: args };
}
