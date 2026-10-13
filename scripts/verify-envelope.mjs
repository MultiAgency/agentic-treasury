/** Offline evidence capture. No .env loading, provider calls, signing or deployment commands. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2];
if (!output || !isAbsolute(output)) throw new Error("Usage: node scripts/verify-envelope.mjs <new absolute evidence directory>");
// Never overwrite an earlier verification record.
mkdirSync(output, { recursive: false, mode: 0o700 });
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
};
function snapshot() {
  const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  // Hash only public code, test sources and repository documentation; never credentials/state.
  const included = [...new Set(files)].filter(p =>
    /^(src|test|web|scripts)\/.*\.(ts|tsx|js|mjs|json|css|html)$/.test(p) ||
    /^docs\/.*\.(md|json)$/.test(p) ||
    /^(package\.json|pnpm-lock\.yaml|tsconfig\.json|README\.md|DEMO\.md|CONTEXT\.md|AGENTS\.md|test\/offline\.env)$/.test(p)
  ).sort();
  return Object.fromEntries(included.map(p => {
    try { return [p, createHash("sha256").update(readFileSync(resolve(root, p))).digest("hex")]; }
    catch (error) { if (error.code === "ENOENT") return [p, "MISSING"]; throw error; }
  }));
}
const startedAt = new Date().toISOString();
const head = git("rev-parse", "HEAD");
const before = snapshot();
const checks = [];
async function check(args, env) {
  return new Promise(resolveResult => {
    const child = spawn("pnpm", args, { cwd: root, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", error, timedOut = false;
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Terminate this check's process group, including stuck test fixtures, never other sessions.
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
      catch (failure) { if (failure.code !== "ESRCH") error = failure; }
    }, 120_000);
    child.on("error", failure => { error = failure; });
    child.on("close", (status, signal) => {
      clearTimeout(timer); resolveResult({ stdout, stderr, error, timedOut, status, signal });
    });
  });
}
for (const [name, args] of [["typecheck", ["typecheck"]], ["test", ["test"]]]) {
  const start = new Date().toISOString();
  const result = await check(args,
    // Defense in depth against inherited live credentials. pnpm test additionally loads offline.env.
    { ...process.env, NODE_ENV: "test", NEAR_INTENTS_AGENT_API_URL: "http://127.0.0.1:9",
      NEAR_RPC_URL: "http://127.0.0.1:9", NEAR_INTENTS_AGENT_API_KEY: "naa_" + "x".repeat(43),
      AGENT_ID: "a".repeat(64), AGENT_GRANT_TOKEN: "", AGENT_GRANT_TOKEN_PENDING: "",
      AGENT_OWNER_PRIVATE_KEY: "", NEARAI_API_KEY: "" });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`;
  writeFileSync(resolve(output, `${name}.log`), log, { mode: 0o600 });
  checks.push({ name, command: ["pnpm", ...args], startedAt: start, endedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, timedOut: result.timedOut,
    logSha256: createHash("sha256").update(log).digest("hex") });
  console.log(`${name}: ${result.status === 0 ? "PASS" : "FAIL"}`);
}
const after = snapshot();
const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(p => before[p] !== after[p]);
const headAfter = git("rev-parse", "HEAD");
const stable = changed.length === 0 && head === headAfter;
const checksPassed = checks.every(c => c.exitCode === 0);
const record = { schema: 1, startedAt, endedAt: new Date().toISOString(), head, headAfter,
  evidenceClass: "offline-tested", checksPassed, sourceStable: stable, changedDuringChecks: changed,
  releaseReady: false,
  limitations: ["No provider integration, signature-to-policy proof, deployment correspondence or custody guarantee established.",
    "Before/after hashes detect persistent changes, not a change followed by reversion during checks.",
    "Shared-workspace observations are not an immutable release build; suite skips and TODOs remain visible in test.log."],
  checks, before, after };
writeFileSync(resolve(output, "verification.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ checksPassed, sourceStable: stable, changedDuringChecks: changed, evidence: resolve(output, "verification.json") }));
process.exitCode = checksPassed && stable ? 0 : 1;
