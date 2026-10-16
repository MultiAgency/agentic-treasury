import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { RPCHandler } from "@orpc/server/node";
import { ORPCError, type RouterClient } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { PublicError } from "../src/public-error.js";
import { os } from "../src/rpc/base.js";
import { AgentApiError } from "@near-intents-agent-api/sdk";

test("RPC errors do not expose arbitrary exceptions, including errors after streaming starts", async t => {
  const secret = "synthetic-private-credential";
  const router = {
    guidance: os.handler(() => { throw new PublicError("Intent expired"); }),
    fail: os.handler(() => { throw new Error(`failed at /private/settings: ${secret}`); }),
    stream: os.handler(async function* () { yield "observed"; throw new Error(secret); }),
    expected: os.handler(() => { throw new ORPCError("PRECONDITION_FAILED", { message: "Use the executor." }); }),
    provider: os.handler(() => { throw new AgentApiError(403, { errors: [{ status: "403", code: "spend_budget_exceeded", title: secret, detail: secret, meta: { token: secret, budget_remaining_usd: "1" } }] } as never); }),
  };
  const handler = new RPCHandler(router);
  const server = createServer(async (req, res) => { await handler.handle(req, res, { prefix: "/rpc" }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client: RouterClient<typeof router> = createORPCClient(new RPCLink({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, url: "/rpc" }));
  await assert.rejects(client.fail(), (error: unknown) => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /synthetic-private|\/private/);
    return true;
  });
  const stream = await client.stream();
  assert.deepEqual(await stream.next(), { value: "observed", done: false });
  await assert.rejects(stream.next(), (error: unknown) => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /synthetic-private/); return true;
  });
  await assert.rejects(client.guidance(), /Intent expired/);
  await assert.rejects(client.expected(), /Use the executor/);
  await assert.rejects(client.provider(), (error: unknown) => {
    assert.ok(error instanceof ORPCError);
    assert.doesNotMatch(JSON.stringify(error), /synthetic-private/);
    assert.deepEqual(error.data, { code: "spend_budget_exceeded", availableAt: null, budgetRemainingUsd: "1" });
    return true;
  });
});
