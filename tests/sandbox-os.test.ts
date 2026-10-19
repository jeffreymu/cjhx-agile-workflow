import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { SandboxPolicy } from "../src/sandbox/policy.js";
import type { RunnerEvent } from "../src/sandbox/runner.js";

// Explicit opt-in: this starts real OS isolation and local SDK proxy services.
// A skip is not evidence of isolation on any platform.
test("REAL OS: outside read/write and network denied; allowed repository write succeeds", { skip: process.env.CJHX_SANDBOX_OS_TEST !== "1" }, async t => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "cjhx-os-probe-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = resolve(root, "repo"); mkdirSync(repo);
  const outside = resolve(root, "outside.txt"); writeFileSync(outside, "UNCHANGED");
  const probe = resolve(repo, "probe.mjs");
  writeFileSync(probe, `import fs from 'node:fs'; import net from 'node:net';
const outside=${JSON.stringify(outside)}; let denied=0;
try { fs.readFileSync(outside); } catch { denied++; }
try { fs.writeFileSync(outside,'ESCAPED'); } catch { denied++; }
fs.writeFileSync('allowed.txt','OK');
const blocked = await new Promise(resolve => {const s=net.connect({host:'1.1.1.1',port:443}); s.setTimeout(1500); s.on('connect',()=>{s.destroy();resolve(false)}); s.on('error',()=>resolve(true)); s.on('timeout',()=>{s.destroy();resolve(true)});});
// Raw TCP is intentionally prohibited even to a permitted DNS host; also test the HTTP proxy allowlist.
let proxyBlocked=false; try { const p=new URL(process.env.HTTP_PROXY); const http=await import('node:http'); proxyBlocked=await new Promise(resolve=>{const q=http.request({hostname:p.hostname,port:p.port,path:'http://example.com/',headers:{Host:'example.com','Proxy-Authorization':'Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64')}},r=>{r.resume();resolve(r.statusCode===403)});q.on('error',()=>resolve(false));q.setTimeout(2000,()=>{q.destroy();resolve(false)});q.end();}); } catch {}
if(denied!==2 || !blocked || !proxyBlocked) process.exitCode=1;
console.log(JSON.stringify({denied,blocked,proxyBlocked}));`);
  const reads = (process.env.CJHX_SANDBOX_TEST_READ_ROOTS ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean).map(path => realpathSync(path));
  assert.ok(reads.length, "Set explicit system/Node read roots; do not grant HOME or the probe parent");
  const policy: SandboxPolicy = { schemaVersion: 1, backend: "anthropic-srt", runtimeVersion: "0.0.80", purpose: "postflight", executionRoot: repo, readRoots: [repo, ...reads], writeRoots: [repo], deniedPaths: [], allowedHosts: [], ruleDigest: "probe", digest: "probe-os" };
  const runner = resolve(dirname(fileURLToPath(import.meta.url)), "../src/sandbox/runner.js");
  const child = spawn(process.execPath, [runner], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  let stdout = ""; let stderr = ""; let completed: RunnerEvent | undefined;
  child.stdout!.on("data", data => { stdout += data; }); child.stderr!.on("data", data => { stderr += data; });
  child.on("message", (event: RunnerEvent) => { if (event.kind === "completed" || event.kind === "failed") completed = event; });
  child.send({ policy, command: process.execPath, arguments: [probe], environment: { PATH: process.env.PATH ?? "" }, timeoutMs: 15_000, outputLimit: 65_536 }); child.stdin!.end();
  const code = await new Promise(resolve => child.on("close", resolve));
  assert.equal(code, 0, stderr + stdout); assert.equal(completed?.kind, "completed"); assert.equal(completed?.cleanup, "completed");
  assert.equal(readFileSync(outside, "utf8"), "UNCHANGED"); assert.equal(readFileSync(resolve(repo, "allowed.txt"), "utf8"), "OK");
});
