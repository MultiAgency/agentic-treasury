// Runs the SDK skills' examples (copied into an isolated consumer by verify-skills.mjs) against stand-in servers:
// an oRPC owner agent and a payee entry. Each check records what was sent and asserts the documented recovery.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { ownerClient } from "@multiagency/sdk";
import { payeeClient } from "@multiagency/sdk/payee";
import { owner as setupOwner } from "./examples/owner-workflows-1.ts";
import { heldPayouts } from "./examples/owner-workflows-2.ts";
import { freezeAgent } from "./examples/owner-workflows-3.ts";
import { execute } from "./examples/owner-workflows-4.ts";
import { payee as setupPayee } from "./examples/payee-workflows-1.ts";
import { agentFor } from "./examples/payee-workflows-2.ts";
import { report } from "./examples/payee-workflows-3.ts";
import { paymentOf } from "./examples/payee-workflows-4.ts";
import { connectAgent, revokeAll } from "./examples/payee-workflows-5.ts";

const listen = async (handle: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handle);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(done => server.close(() => done())) };
};
const ran: Record<string, unknown> = {};
ok(setupOwner && setupPayee, "setup examples construct their clients");

// Owner agent stand-in, mounted where the gateway mounts it.
const calls: string[] = [];
let dropHeld = 1;
const nep413 = { standard: "nep413" as const, payload: { message: "freeze", recipient: "intents.near", nonce: "AAAA" } };
const router = {
  held: os.handler(() => { if (dropHeld-- > 0) throw new Error("connection reset"); return []; }),
  owner: {
    prepare: os.handler(() => ({ correlationId: "c-1", preview: { summary: "Freeze the agent" }, expiresAt: new Date(Date.now() + 600_000).toISOString(), digest: null, intent: nep413 })),
    submit: os.handler(({ input }) => { deepStrictEqual(input, { correlationId: "c-1", signedData: { ...nep413, public_key: "ed25519:k", signature: "s" } }); throw new Error("reply lost"); }),
    status: os.handler(() => ({ stage: "submitted", status: "SUCCESS" })),
  },
  executePlan: os.handler(async function* () {
    yield { type: "action", index: 0, action: { type: "shield", asset: "usdc", amount: "1" }, status: "SUCCESS", correlationId: "e-1" };
    throw new Error("stream lost");
  }),
};
const handler = new RPCHandler(router);
const agent = await listen(async (req, res) => {
  calls.push(req.url!.replace("/a/payout/rpc/", ""));
  const { matched } = await handler.handle(req, res, { prefix: "/a/payout/rpc" });
  if (!matched) res.writeHead(404).end();
});
const owner = ownerClient({ base: "/a/payout", fetch: (url, init) => fetch(new URL((url as URL).pathname, agent.base), init) });

deepStrictEqual(await heldPayouts(owner), { ok: true, value: [] });
deepStrictEqual(calls.splice(0), ["held", "held"], "a lost read is read again once");
ran.heldPayouts = "lost read, read again once";

let signatures = 0;
const frozen = await freezeAgent(owner, async intent => { signatures++; return { ...intent, public_key: "ed25519:k", signature: "s" }; });
deepStrictEqual(frozen, { ok: true, value: { stage: "submitted", status: "SUCCESS" } });
deepStrictEqual(calls.splice(0), ["owner/prepare", "owner/submit", "owner/status"], "a lost submit is read by its correlation id, never resent");
equal(signatures, 1);
ran.freezeAgent = "signed once, submitted once, outcome read by correlationId";

const planId = randomUUID();
const executed = await execute(owner, planId);
equal(executed.events.length, 1);
deepStrictEqual(executed.failure, { ok: false, kind: "unknown", procedure: "executePlan", identity: { planId } });
deepStrictEqual(calls.splice(0), ["executePlan"], "a stream lost after an event is never executed again");
ran.execute = "event kept, lost stream unknown with planId";
await agent.close();

// Payee entry stand-in: the payee's records, and agent connections managed from the browser session.
const sent: { method: string; path: string; authorization: string | null }[] = [];
const requests: Record<string, unknown>[] = [];
const connections = [{ id: randomUUID(), label: "Old agent", role: "payee", permissions: ["compensation.read", "compensation.submit"], host: "invoices.test",
  instance: "i-1", account: "c.near", agentId: "a-1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revoked: false }];
const body = (req: IncomingMessage) => new Promise<any>(done => { let text = ""; req.on("data", (chunk: Buffer) => text += chunk).on("end", () => done(text ? JSON.parse(text) : undefined)); });
const entry = await listen(async (req, res) => {
  const path = req.url!, json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  sent.push({ method: req.method!, path, authorization: req.headers.authorization ?? null });
  if (req.method === "GET" && path === "/api/compensation/session") return json(200, { account: "c.near" });
  if (req.method === "GET" && path === "/api/compensation") return json(200, { account: "c.near", agreements: [], requests, history: [],
    payments: requests.map(r => ({ requestId: r.id, id: randomUUID(), status: "paid" })) });
  if (req.method === "POST" && path === "/api/compensation") {
    const command = await body(req);
    requests.push({ id: command.id, version: 1, payee: "c.near", agreementVersion: 1, report: command.report, state: "approved", feedback: "", reviewedBy: null, at: new Date().toISOString(), payment: null });
    return json(200, requests.at(-1));
  }
  if (req.method === "GET" && path === "/api/agent-connections") return json(200, { connections });
  if (req.method === "POST" && path === "/api/agent-connections") {
    const issued = { ...connections[0], id: randomUUID(), label: (await body(req)).label };
    connections.push(issued);
    return json(201, { connection: issued, token: `tac_${randomUUID()}.${"A".repeat(43)}` });
  }
  if (req.method === "DELETE" && path.startsWith("/api/agent-connections/")) {
    connections.find(c => c.id === path.split("/").at(-1))!.revoked = true;
    return json(200, { revoked: true });
  }
  json(404, { error: "Not found" });
});

const token = `tac_${randomUUID()}.${"A".repeat(43)}`;
const viaAgent = agentFor(entry.base, token);
deepStrictEqual(await viaAgent.compensationSession(), { ok: true, value: { account: "c.near" } });
equal(sent.at(-1)!.authorization, `Bearer ${token}`);
ran.agentFor = "bearer token sent";

const command = { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true,
  report: { agreementId: randomUUID(), start: "2026-10-01", end: "2026-10-15", contributions: "Hosted the meetup", assessment: "Delivered", evidence: [] } };
// The POST reaches the entry and its reply is lost; reads answer.
const losing = payeeClient({ base: entry.base, token, fetch: async (input, init) => {
  const response = await fetch(input, init);
  if (init?.method === "POST") throw new TypeError("reply lost");
  return response;
} });
const recovered = await report(losing, command);
ok(recovered.ok && recovered.value.id === command.id, "the lost reply is recovered by the kept request id");
equal(requests.length, 1);
equal(sent.filter(s => s.method === "POST" && s.path === "/api/compensation").length, 1, "one submission; recovery is a read");
ran.report = "lost reply recovered by id with a read";

deepStrictEqual(await paymentOf(viaAgent, command.id), { ok: true, value: { state: "approved", payment: "paid" } });
ran.paymentOf = "request state and payment status read";

const browser = payeeClient({ base: entry.base });
const connected = await connectAgent(browser);
ok(connected.ok && connected.value.token.startsWith("tac_"));
deepStrictEqual(connected.ok && connected.value.permissions, ["compensation.read", "compensation.submit"]);
deepStrictEqual(await revokeAll(browser), { ok: true, value: 2 });
ok(connections.every(c => c.revoked));
ok(sent.filter(s => s.path.startsWith("/api/agent-connections")).every(s => s.authorization === null), "connections are managed without a token");
ran.connections = "started, listed and revoked from the browser session";
await entry.close();

console.log(JSON.stringify(ran));
