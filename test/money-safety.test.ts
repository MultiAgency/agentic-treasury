import { authorityFixture, policyView } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { type Action, dispatch, pay, send } from "../src/agent.js";
import { api } from "../src/api.js";
import { acquireMoneyLock, type MoneyLock, UnresolvedOperations } from "../src/lock.js";
import { readOps, record } from "../src/ops.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { refusals, type RefusalEvent } from "../src/treasury.js";

const home = process.cwd();
const action: Action = { method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "fixture.near", confidential: true } };
const policy = policyView(payoutPolicy(["fixture.near"]));
let calls: string[];
let answer: () => Promise<{ correlation_id: string }>;
let status: string;

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "money-safety-")));
  process.env.AGENT_ID = "a".repeat(64);
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  calls = [];
  status = "FAILED";
  answer = async () => ({ correlation_id: "fixture-op" });
  mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in offline fault tests"); });
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policy);
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status }));
  const method = async (_id: string, _request: unknown, options: { idempotencyKey: string }) => {
    calls.push(options.idempotencyKey);
    return answer();
  };
  mock.method(api, "forGrant", () => ({ transfer: method, swap: method, shield: method, unshield: method }));
});
afterEach(() => { mock.restoreAll(); process.chdir(home); });

const collect = async (live = true) => {
  const events: RefusalEvent[] = [];
  for await (const event of refusals({ live })) events.push(event);
  return events;
};

test("live probes default off before any API read or send", async () => {
  mock.method(api, "getPolicy", () => assert.fail("disabled probes must not read the API"));
  mock.method(api, "getTokens", () => assert.fail("disabled probes must not read the API"));
  await assert.rejects(async () => { for await (const _ of refusals()) assert.fail("no events expected"); }, /disabled/);
  assert.deepEqual(calls, []);
  assert.deepEqual(readOps(), []);
});

for (const failure of ["lost response", "retryable API error", "untrusted refusal-shaped error", "status timeout", "non-retryable status error"]) {
  test(`submission stays unknown after ${failure}, and a later run stays blocked`, async () => {
    if (failure === "non-retryable status error") mock.method(api, "getStatus", async () => {
      throw new AgentApiError(404, { errors: [{ status: "404", code: "not_found", title: "Not found" }], meta: {} });
    });
    else if (failure === "status timeout") mock.method(api, "getStatus", async () => { throw new Error("status timeout"); });
    else answer = async () => {
      if (failure === "retryable API error") throw new AgentApiError(503, {
        errors: [{ status: "503", code: "unavailable", title: "Unavailable", meta: { retryable: true } }], meta: {},
      });
      if (failure === "untrusted refusal-shaped error") throw Object.assign(new Error("unknown"), { errors: [{ code: "policy_denied" }] });
      throw new Error("lost response");
    };
    const lock = await acquireMoneyLock();
    try { await assert.rejects(dispatch(lock, "fixture", action)); } finally { await lock.release(); }
    assert.equal(calls.length, 1);
    assert.equal(readOps().length, 1);
    assert.equal(readOps()[0]?.refused, undefined);
    await assert.rejects(acquireMoneyLock(), UnresolvedOperations);
  });
}

for (const outcome of ["UNCERTAIN", "NEEDS_REVIEW"]) {
  test(`submission stops on ${outcome} without another request or a refusal label`, async () => {
    status = outcome;
    const lock = await acquireMoneyLock();
    try { assert.equal((await dispatch(lock, "fixture", action)).status, outcome); } finally { await lock.release(); }
    assert.equal(calls.length, 1);
    assert.equal(readOps()[0]?.status, outcome);
    assert.equal(readOps()[0]?.refused, undefined);
    await assert.rejects(acquireMoneyLock(), UnresolvedOperations);
  });
}

test("a proven first-submission refusal resolves only that operation", async () => {
  answer = async () => { throw new AgentApiError(409, {
    errors: [{ status: "409", code: "policy_denied", title: "Policy denied" }], meta: {},
  }); };
  const lock = await acquireMoneyLock();
  try { await assert.rejects(dispatch(lock, "fixture", action), AgentApiError); } finally { await lock.release(); }
  assert.equal(readOps()[0]?.refused, "policy_denied");
  assert.equal(calls.length, 1);
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
