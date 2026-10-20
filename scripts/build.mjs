import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";

rmSync(resolve("dist"), { recursive: true, force: true });
// Invoke the installed JS entry directly: .cmd shims cannot use shell:false on Windows.
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
for (const args of [[], ["-p", "tsconfig.ui.json"]]) {
  const result = spawnSync(process.execPath, [tsc, ...args], { stdio: "inherit", shell: false });
  if (result.error) console.error(`TypeScript compiler could not start: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
mkdirSync(resolve("dist/ui"), { recursive: true });
for (const asset of ["index.html", "styles.css", "test-workbench.css", "cjhx-ai.svg"]) copyFileSync(resolve("ui", asset), resolve("dist/ui", asset));
