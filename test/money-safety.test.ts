import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { type Action, dispatch, LocalRefusal, pay, send } from "../src/agent.js";
import { api } from "../src/api.js";
import { acquireMoneyLock, type MoneyLock, UnresolvedOperations } from "../src/lock.js";
import { readOps, record } from "../src/ops.js";
import { mandateDigest } from "../src/mandate.js";
import { ASSETS, payoutPolicy, treasuryPolicy } from "../src/policy.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

const action: Action = { method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "fixture.near", confidential: true } };
const policy = policyView(payoutPolicy(["fixture.near"]));
let calls: string[];
let answer: () => Promise<{ correlation_id: string }>;
let status: string;

freshDirectory("money-safety");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  calls = [];
  status = "FAILED";
  answer = async () => ({ correlation_id: "fixture-op" });
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policy);
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status }));
  const method = async (_id: string, _request: unknown, options: { idempotencyKey: string }) => {
    calls.push(options.idempotencyKey);
    return answer();
  };
  mock.method(api, "forGrant", () => ({ transfer: method, swap: method, shield: method, unshield: method }));
});
afterEach(() => mock.restoreAll());

test("a proven first-submission refusal resolves only that operation", async () => {
  answer = async () => { throw new AgentApiError(409, {
    errors: [{ status: "409", code: "policy_denied", title: "Policy denied" }], meta: {},
  }); };
  const lock = await acquireMoneyLock();
  try { await assert.rejects(dispatch(lock, "fixture", action), AgentApiError); } finally { await lock.release(); }
  assert.equal(readOps()[0]?.refused, "policy_denied");
  assert.equal(calls.length, 1);
});

test("a swap into an asset outside the policy is refused before sending, and logged with its mandate", async () => {
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy, 7));
  mock.method(api, "listGrants", authorityFixture("treasury").listGrants);
  const lock = await acquireMoneyLock();
  try {
    const swap = { origin_asset: ASSETS.USDC, destination_asset: "nep141:usdt.tether-token.near", amount: "2000000", confidential: true };
    await assert.rejects(dispatch(lock, "rebalance", { method: "swap", request: swap }), LocalRefusal);
  } finally {
    await lock.release();
  }
  const [op] = readOps();
  assert.equal(op?.refused, "asset_out_not_allowed");
  assert.deepEqual(calls, [], "nothing was sent");
  assert.equal(op?.policyRevision, 7);
  assert.equal(op?.policyDigest, mandateDigest(treasuryPolicy));
  assert.equal(op?.usdIn, 2);
  // A refusal is a proven outcome: it doesn't block the next money action.
  await (await acquireMoneyLock()).release();
});

test("lock lost during asynchronous preflight produces zero sends and zero request records", async () => {
  const lock = await acquireMoneyLock();
  mock.method(api, "getPolicy", async () => { await lock.release(); return policy; });
  await assert.rejects(dispatch(lock, "fixture", action), /money lock/);
  assert.deepEqual(calls, []);
  assert.deepEqual(readOps(), []);
});

test("an unresolved operation appearing during preflight blocks before recording a new request", async () => {
  const lock = await acquireMoneyLock();
  try {
    mock.method(api, "getPolicy", async () => {
      await Promise.resolve();
      record({ at: new Date().toISOString(), idempotencyKey: "fixture:unknown", kind: "fixture", method: action.method, request: action.request });
      return policy;
    });
    await assert.rejects(dispatch(lock, "fixture", action), UnresolvedOperations);
    assert.deepEqual(calls, []);
    assert.deepEqual(readOps().map((op) => op.idempotencyKey), ["fixture:unknown"]);
  } finally { await lock.release(); }
});

test("an unknown outcome blocks a subsequent dispatch within the same held lock", async () => {
  const lock = await acquireMoneyLock();
  try {
    status = "UNCERTAIN";
    await dispatch(lock, "fixture", action);
    await assert.rejects(dispatch(lock, "fixture", action), UnresolvedOperations);
    assert.equal(calls.length, 1);
    assert.equal(readOps().length, 1);
  } finally { await lock.release(); }
});

test("replay also refuses a lost lock without sending", async () => {
  const lock: MoneyLock = { held: false, release: async () => {} };
  await assert.rejects(send(action, "fixture:original-key", lock), /money lock/);
  assert.deepEqual(calls, []);
});

test("a payout's retryable API failure is not presented as a policy refusal", async () => {
  answer = async () => { throw new AgentApiError(503, {
    errors: [{ status: "503", code: "unavailable", title: "Unavailable", meta: { retryable: true } }], meta: {},
  }); };
  await assert.rejects(pay({ asset: ASSETS.USDC, amount: "1", recipient: "fixture.near", confidential: true }), AgentApiError);
  assert.equal(calls.length, 1);
  assert.equal(readOps()[0]?.refused, undefined);
});
