import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/env.ts", import.meta.url));

/** Runs the fixture in a fresh process in `dir`, with `env` added; returns what it printed. */
function run(dir: string, env: Record<string, string>, agentId: string) {
  const result = spawnSync(TSX, [FIXTURE, agentId], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("another instance starts without the default agent and saves only to its own file", () => {
  const dir = mkdtempSync(join(tmpdir(), "instance-"));
  writeFileSync(join(dir, ".env"), "AGENT_ID=default\nSHARED=kept\n");
  writeFileSync(join(dir, ".env.payout"), "TREASURY_ACCOUNT=dao.near\n");
  const shared = { AGENT_ID: "default", SHARED: "kept" };
  const seen = run(dir, { ...shared, ENV_FILE: ".env.payout" }, "payout");
  assert.equal(seen, JSON.stringify([null, "dao.near", "kept"]));
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "AGENT_ID=default\nSHARED=kept\n");
  assert.equal(readFileSync(join(dir, ".env.payout"), "utf8"), "TREASURY_ACCOUNT=dao.near\nAGENT_ID=payout\n");
});

test("the default instance keeps everything in .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "instance-"));
  writeFileSync(join(dir, ".env"), "SHARED=kept\n");
  run(dir, { ENV_FILE: "" }, "default");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "SHARED=kept\nAGENT_ID=default\n");
});
