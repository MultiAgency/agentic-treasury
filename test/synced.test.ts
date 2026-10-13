import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendSynced } from "../src/synced.js";

/** The append every log here shares (journal, evidence, interventions, inbox): what a crash mid-append can cost. */

const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
const parsed = (path: string) => lines(path).flatMap((l) => { try { return [JSON.parse(l) as { id: string }]; } catch { return []; } });

test("after a torn last line the next record starts its own line: only the torn one is lost", () => {
  const path = join(mkdtempSync(join(tmpdir(), "synced-")), "log.jsonl");
  writeFileSync(path, `${JSON.stringify({ id: "a" })}\n{"id":"b","at":"2026-`); // a crash mid-append
  appendSynced(path, { id: "c" });
  assert.deepEqual(parsed(path).map((l) => l.id), ["a", "c"]);
  assert.equal(lines(path).length, 3);
});

test("an append to a new or intact file adds exactly one line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "synced-")), "log.jsonl");
  appendSynced(path, { id: "a" });
  appendSynced(path, { id: "b" });
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ id: "a" })}\n${JSON.stringify({ id: "b" })}\n`);
});
