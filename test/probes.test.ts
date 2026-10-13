import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSETS } from "../src/policy.js";
import { probeCases } from "../src/probes.js";

const spent = (action: ReturnType<typeof probeCases>[number][1]) =>
  action.method === "swap" ? action.request.origin_asset : action.request.asset;

test("every probe asks for more than the agent holds of what it spends, however much that is", () => {
  for (const balance of [0n, 7_500_000n, 1_000_000_000n, 10n ** 30n]) {
    for (const [name, action] of probeCases(() => balance)) {
      assert.ok(BigInt(action.request.amount) > balance, `${name} at a balance of ${balance}`);
    }
  }
});

test("a probe keeps its designed size while that is already above the balance", () => {
  const amounts = probeCases(() => 0n).map(([, action]) => action.request.amount);
  assert.deepEqual(amounts, ["1000000", "2001350", "1000000", "90000000", "140000000"]);
});

test("probes spend only what each layer is about", () => {
  const assets = probeCases(() => 0n).map(([, action]) => spent(action));
  assert.deepEqual(assets, [ASSETS.USDC, "nep141:usdt.tether-token.near", ASSETS.USDC, ASSETS.USDC, ASSETS.USDC]);
});
