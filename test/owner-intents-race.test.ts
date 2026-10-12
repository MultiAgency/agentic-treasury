import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** A todo until the owner-intent lifecycle lands after the money-path freeze and the journal. */
const PENDING = "the owner-intent lifecycle lands after the freeze and the journal";
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/owner-intents-race.ts", import.meta.url));

test("two processes preparing owner intents for one instance both keep theirs", { todo: PENDING }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-intents-race-"));
  const options = { cwd: dir, env: { ...process.env, ENV_FILE: "", AGENT_ID: "a".repeat(64) } };
  // The server loaded the intents before the command line prepared one, and prepares its own after.
  const server = spawn(TSX, [FIXTURE, "from-server", join(dir, "go")], options);
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((loaded) => server.stdout.on("data", (chunk) => String(chunk).includes("loaded") && loaded()));
  const cli = spawnSync(TSX, [FIXTURE, "from-cli"], { ...options, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  writeFileSync(join(dir, "go"), "");
  assert.equal(await new Promise((exited) => server.on("exit", exited)), 0, stderr);
  const kept = JSON.parse(readFileSync(join(dir, ".owner-intents", ".env.json"), "utf8"));
  assert.deepEqual(Object.keys(kept).sort(), ["from-cli", "from-server"]);
});
