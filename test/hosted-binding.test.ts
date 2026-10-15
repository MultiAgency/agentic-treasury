import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHostedCreation, checkHostedTreasury } from "../src/hosted-binding.js";

test("reserved ownership, signer type and area cannot be changed by setup input", () => {
  const wallet = { type: "near" as const, account_id: "alice.near", public_key: "ed25519:key" };
  const env = { HOSTED_OWNER: "alice.near", HOSTED_OWNER_KIND: "wallet", DASHBOARD_AREA: "treasury" };
  assert.doesNotThrow(() => checkHostedCreation(wallet, "wallet", "treasury", env));
  assert.throws(() => checkHostedCreation({ ...wallet, account_id: "bob.near" }, "wallet", "treasury", env));
  assert.throws(() => checkHostedCreation(wallet, "dao", "treasury", env));
  assert.throws(() => checkHostedCreation(wallet, "wallet", "payout", env));
  const dao = { HOSTED_OWNER: "team.near", HOSTED_OWNER_KIND: "dao", TREASURY_ACCOUNT: "team.near", DASHBOARD_AREA: "payables" };
  assert.doesNotThrow(() => checkHostedCreation(wallet, "dao", "payout", dao));
  assert.throws(() => checkHostedCreation(wallet, "dao", "payout", { ...dao, TREASURY_ACCOUNT: "other.near" }));
  assert.throws(() => checkHostedTreasury("", dao));
  assert.throws(() => checkHostedTreasury("other.near", dao));
  assert.doesNotThrow(() => checkHostedTreasury("team.near", dao));
  assert.doesNotThrow(() => checkHostedCreation(wallet, "wallet", "payout", {}), "legacy instances retain existing creation behavior");
});

test("the owner-action handler refuses reassignment and concurrent creation before generating another intent", async t => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "hosted-binding-"));
  process.chdir(dir);
  process.env.ENV_FILE = ".env.hosted-test";
  process.env.HOSTED_OWNER = "alice.near";
  process.env.HOSTED_OWNER_KIND = "wallet";
  process.env.DASHBOARD_AREA = "treasury";
  t.after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  const { prepare } = await import("../src/owner-intents.js");
  const { api } = await import("../src/api.js");
  let generated = 0;
  t.mock.method(api, "generateIntent", async () => {
    generated++;
    return { type: "agent_create", correlation_id: "creation", expires_at: "2099-01-01T00:00:00Z", preview: {},
      signer: { type: "near", account_id: "alice.near", public_key: "ed25519:key" }, intent: { standard: "nep413", payload: {} } } as never;
  });
  const owner = { type: "near" as const, account_id: "alice.near", public_key: "ed25519:key" };
  await assert.rejects(prepare({ type: "agent_create", owner: { ...owner, account_id: "bob.near" } }), /bound/);
  await assert.rejects(prepare({ type: "agent_create", owner, role: "payout" }), /bound/);
  assert.equal(generated, 0);
  await prepare({ type: "agent_create", owner });
  await assert.rejects(prepare({ type: "agent_create", owner }), /open owner action/);
  assert.equal(generated, 1);
});
