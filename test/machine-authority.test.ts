import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMachineAccess } from "../src/gateway/machine-authority.js";
import { resolveAgentAccess } from "../src/gateway/roles.js";

test("machine authority never uses warm dashboard ownership and requires an established wallet agent", async t => {
  const agent = { name: "machine-fixture", owner: "owner.near", port: 18790 };
  let identity: unknown = { agentId: "provider-agent", owner: { type: "near", account_id: agent.owner } };
  let failed = false;
  let chainFailed = false;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.startsWith("/rpc/")) return failed ? new Response("", { status: 503 }) : Response.json({ json: identity });
    if (chainFailed) throw new Error("unavailable");
    return Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: agent.owner } }, code: -32000, message: "Server error" } });
  });
  assert.ok(await resolveAgentAccess(agent.owner, agent));
  assert.equal((await resolveMachineAccess(agent.owner, agent))?.agentId, "provider-agent");
  assert.equal(await resolveMachineAccess("other.near", agent), null);
  failed = true;
  assert.ok(await resolveAgentAccess(agent.owner, agent));
  assert.equal(await resolveMachineAccess(agent.owner, agent), null);
  failed = false; chainFailed = true;
  assert.equal(await resolveMachineAccess(agent.owner, agent), null);
  chainFailed = false;
  for (const value of [{ agentId: null, owner: null }, { agentId: "x", owner: null }, { agentId: "x", owner: { type: "near", account_id: "other.near" } }, {}]) {
    identity = value;
    assert.equal(await resolveMachineAccess(agent.owner, agent), null);
  }
});
