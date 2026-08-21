import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

rmSync(resolve("dist"), { recursive: true, force: true });
const command = process.platform === "win32" ? "tsc.cmd" : "tsc";
for (const args of [[], ["-p", "tsconfig.ui.json"]]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
mkdirSync(resolve("dist/ui"), { recursive: true });
for (const asset of ["index.html", "styles.css", "cjhx-ai.svg"]) copyFileSync(resolve("ui", asset), resolve("dist/ui", asset));
