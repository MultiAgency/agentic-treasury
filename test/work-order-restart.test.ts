import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { freshDirectory } from "./fixtures/harness.js";
import { createWorkOrder } from "../src/work-order-store.js";
import { workOrderSettings } from "../src/work-order-pool.js";

freshDirectory("work-order-restart");
test("restarted private executors retain the order, agent and attempted owner action", () => {
  const order = createWorkOrder("parent", { id: "12345678-1234-4234-8234-123456789abc", payee: "alice.near", amount: "1000000",
    note: "Design work", until: new Date(Date.now() + 86_400_000).toISOString(), asset: "usdc-test",
    owner: { type: "near", account_id: "owner.near", public_key: "fixture" } });
  const settings = workOrderSettings(order);
  writeFileSync(settings, "AGENT_ID=work-order-restart-agent\nAUTOPILOT=off\n");
  writeFileSync(`${settings}.initialized`, "retained");
  mkdirSync(".owner-intents");
  const intentPath = join(".owner-intents", `${basename(settings)}.json`);
  // A settled failed creation is retained. It must not authorize a replacement or replay.
  writeFileSync(intentPath, JSON.stringify({ attempted: { type: "agent_create", expiresAt: order.until,
    stage: "settled", result: { status: "FAILED" } } }));
  const run = () => {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("./fixtures/work-order-resume.ts", import.meta.url)), order.parentAgentId, order.id],
    { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = run(), second = run();
  assert.equal(first.agentId, "work-order-restart-agent");
  assert.deepEqual(second, first);
  assert.equal(first.ownerActions[0].correlationId, "attempted");
  assert.equal(first.ownerActions[0].status, "FAILED");
  assert.match(readFileSync(settings, "utf8"), /AGENT_ID=work-order-restart-agent/);
  assert.equal(JSON.parse(readFileSync(intentPath, "utf8")).attempted.stage, "settled");
});
