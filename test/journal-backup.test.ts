import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { record } from "../src/ops.js";
import { freshDirectory, TSX } from "./fixtures/harness.js";

// The pre-release check of a backup copy: the candidate reader accepts a journal written by the real writer, names the
// invalid line otherwise, and never writes to the backup it checks.
freshDirectory("journal-backup");
const SCRIPT = fileURLToPath(new URL("../scripts/check-journal-backup.ts", import.meta.url));
const check = () => spawnSync(TSX, [SCRIPT, process.cwd()], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
const digest = () => createHash("sha256").update(readFileSync(".ops/agent-a.jsonl")).digest("hex");

test("a backup journal written by the writer reads; an unsupported line fails with its line number; the backup is untouched", () => {
  process.env.AGENT_ID = "agent-a";
  record({ at: new Date().toISOString(), idempotencyKey: "backup:1", kind: "fixture", method: "transfer", request: { amount: "1" } });
  const before = digest();
  const ok = check();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout.trim()), { agent: "agent-a", ok: true, operations: 1, blocking: 1 });
  assert.equal(digest(), before, "the backup is not written");

  appendFileSync(".ops/agent-a.jsonl", `${JSON.stringify({ idempotencyKey: "backup:1", unexpected: true })}\n`);
  const bad = check();
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout.trim()).error, /Invalid operation journal at line 2: unsupported record shape/);
});
