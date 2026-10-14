import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.js";
import { held } from "../src/payouts.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("payout-review");

test("dashboard held-payout review cannot report empty when remote history is unavailable", async () => {
  Object.assign(api, { getHistory: async () => { throw new Error("history unavailable"); } });
  await assert.rejects(held({ complete: true }), /history unavailable/);
});
