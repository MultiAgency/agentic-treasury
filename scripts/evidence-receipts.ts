// Sanitized copies of the apps' simulated workflow receipts, shown by Proto's evidence view as "Recorded simulation".
// Each copy is pinned to its source receipt's sha256 and to its own sha256 (evidence/receipts.ts); --check fails on a
// stale or edited copy. Sources are resolved beside Proto (`../payables`, `../treasury`) and checked when present.
// Usage: tsx scripts/evidence-receipts.ts --check
//        tsx scripts/evidence-receipts.ts --import <id> <payables|treasury> <path in that repo>
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { receipts, type ReceiptApp } from "../evidence/receipts.js";

const root = join(import.meta.dirname, "..");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const copyPath = (id: string) => join(root, "evidence/receipts", `${id}.json`);
export const sourcePath = (app: ReceiptApp, path: string) => join(resolve(realpathSync(root), ".."), app, path);

/**
 * Drops what is local to one machine or run environment: absolute paths become their file name, and the stack's
 * origins and logs are removed. Fixture identities, steps and outcomes are kept as recorded.
 */
export function sanitize(value: unknown): unknown {
  if (typeof value === "string") return /^\/(Users|home|private|tmp|var)\//.test(value) ? `<local>/${basename(value)}` : value;
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).filter(([name]) => !["stack", "logs", "log"].includes(name)).map(([name, item]) => [name, sanitize(item)]));
  return value;
}
/** One line per recorded step (its text or action, then its status or outcome), as the evidence view lists it. */
export function stepSummary(copy: string): string[] {
  const steps = (JSON.parse(copy) as { steps?: Record<string, unknown>[] }).steps ?? [];
  return steps.map(step => [typeof step.step === "string" ? step.step : step.action, step.status ?? step.outcome].filter(value => typeof value === "string" && value).join(" · "));
}
export const rendered = (source: Buffer) => `${JSON.stringify(sanitize(JSON.parse(source.toString("utf8"))), null, 2)}\n`;

/** Problems with the pinned copies; sources are compared only where this machine has them. */
export function receiptProblems() {
  const problems: string[] = [];
  for (const entry of receipts) {
    const path = copyPath(entry.id);
    if (!existsSync(path)) { problems.push(`${entry.id}: copy missing`); continue; }
    const copy = readFileSync(path);
    if (sha256(copy) !== entry.copySha256) problems.push(`${entry.id}: copy changed since it was pinned`);
    if (/"\/(Users|home|private|tmp|var)\//.test(copy.toString("utf8"))) problems.push(`${entry.id}: copy contains a local path`);
    if (JSON.stringify(stepSummary(copy.toString("utf8"))) !== JSON.stringify(entry.steps)) problems.push(`${entry.id}: listed steps differ from the copy`);
    const source = sourcePath(entry.source.app, entry.source.path);
    if (existsSync(source)) {
      const bytes = readFileSync(source);
      if (sha256(bytes) !== entry.source.sha256) problems.push(`${entry.id}: source receipt changed; import it again`);
      else if (rendered(bytes) !== copy.toString("utf8")) problems.push(`${entry.id}: copy differs from its sanitized source`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, id, app, path] = process.argv.slice(2);
  if (mode === "--check") {
    const problems = receiptProblems();
    for (const problem of problems) console.error(problem);
    process.exitCode = problems.length ? 1 : 0;
  } else if (mode === "--import" && id && (app === "payables" || app === "treasury") && path) {
    const bytes = readFileSync(sourcePath(app, path));
    const copy = rendered(bytes);
    mkdirSync(dirname(copyPath(id)), { recursive: true });
    writeFileSync(copyPath(id), copy);
    console.log(JSON.stringify({ id, source: { app, path, sha256: sha256(bytes) }, copySha256: sha256(copy), steps: stepSummary(copy) }, null, 2));
  } else throw new Error("Usage: tsx scripts/evidence-receipts.ts --check | --import <id> <payables|treasury> <path in that repo>");
}
