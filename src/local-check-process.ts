import { realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ValidationError } from "./errors.js";

/** Host-only npm launch. Injected/sandbox executors keep the catalog command unchanged. */
export function localCheckProcess(cwd: string, platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, node = process.execPath): { command: string; arguments: string[]; environment: NodeJS.ProcessEnv } {
  const value = (key: string): string | undefined => environment[Object.keys(environment).find((name) => name.toLowerCase() === key.toLowerCase()) ?? key];
  const env: NodeJS.ProcessEnv = { PATH: value("PATH") ?? "", HOME: value("HOME") ?? "", LANG: value("LANG") ?? "C.UTF-8" };
  for (const key of platform === "win32" ? ["SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE", "PATHEXT"] : ["TMPDIR"]) {
    const entry = value(key); if (entry !== undefined) env[key] = entry;
  }
  if (platform !== "win32") return { command: "npm", arguments: [], environment: env };
  // Never shell-quote npm.cmd or search the target repo / relative PATH entries.
  // Standard Node and npm global installations put npm's JS entry beside the shim.
  const directories = [dirname(node), ...(value("PATH") ?? "").split(delimiter)].map((entry) => entry.replace(/^"(.*)"$/, "$1"));
  const repository = realpathSync(cwd);
  const insideRepository = (path: string): boolean => {
    const relation = relative(repository, path);
    return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
  };
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue;
    const entry = resolve(directory, "node_modules/npm/bin/npm-cli.js");
    if (insideRepository(entry)) continue;
    try {
      const canonical = realpathSync(entry);
      if (!insideRepository(canonical) && statSync(canonical).isFile()) return { command: node, arguments: [canonical], environment: env };
    } catch { /* Try the next external installation. */ }
  }
  throw new ValidationError("Cannot locate npm-cli.js outside the execution repository; install npm alongside Node or on an absolute PATH entry");
}
