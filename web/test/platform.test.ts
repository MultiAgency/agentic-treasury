import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { agent, failureKind, gateway, onDenial, PlatformError, READS, reads, scope, scopeOfKey, type Denial } from "../src/platform.ts";

/** Each request the app sent, and the answers the fake host gives, in order. */
let sent: { url: string; method: string; body: string }[] = [];
let answers: (() => Response | Promise<Response>)[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  answers = [];
  Object.assign(globalThis, { location: new URL("https://treasury.test/a/portfolio/") });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input instanceof URL || typeof input === "string" ? new URL(input, "https://treasury.test") : input, init);
    sent.push({ url: new URL(request.url).pathname, method: request.method, body: await request.text() });
    const answer = answers.shift();
    if (!answer) throw new Error(`No answer for ${request.url}`);
    return answer();
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const json = (body: unknown, status = 200) => () => Response.json(body, { status });
const lost = () => { throw new TypeError("network"); };
/** An oRPC event stream: each value as a message, then the end. */
const events = (...values: unknown[]) => () => new Response(
  [...values.map(value => `event: message\ndata: ${JSON.stringify({ json: value })}\n\n`), "event: close\ndata: {\"json\":null}\n\n"].join(""),
  { headers: { "content-type": "text/event-stream" } });

test("every listed read is a read to the SDK: a lost answer is unavailable, never unknown", async () => {
  const inputs: Partial<Record<(typeof READS)[number], unknown>> = { "autopilot/log": { tickId: "t" }, "owner/status": { correlationId: "c" }, "autopilot/evidence": {} };
  for (const path of READS) {
    answers.push(lost);
    await assert.rejects(agent("portfolio").read(path, inputs[path] as never), (error: unknown) => failureKind(error) === "unavailable", path);
  }
  assert.equal(sent.length, READS.length);
});

test("a read answers its value, and a failed one throws by kind", async () => {
  answers.push(json({ json: { agentId: "a1", executor: true } }));
  assert.deepEqual(await agent("portfolio").read("instance", undefined), { agentId: "a1", executor: true });
  assert.deepEqual(sent.map(s => s.url), ["/a/portfolio/rpc/instance"]);

  answers.push(json({ json: { defined: true, code: "BAD_REQUEST", message: "No", data: { kind: "refused", code: "x" } } }, 400));
  await assert.rejects(agent("portfolio").read("instance", undefined), (error: unknown) => error instanceof PlatformError && error.failure.kind === "refused");
});

test("an action is sent once and answers its result, whatever happened", async () => {
  answers.push(lost);
  const unknown = await agent("portfolio").act("autopilot/stop", undefined);
  assert.equal(unknown.ok ? "ok" : unknown.kind, "unknown");
  answers.push(json({ json: { defined: true, code: "BAD_REQUEST", message: "Refused", data: { kind: "refused" } } }, 400));
  const refused = await agent("portfolio").act("autopilot/stop", undefined);
  assert.equal(refused.ok ? "ok" : refused.kind, "refused");
  assert.equal(sent.length, 2, "each action was sent exactly once");
});

test("a stream hands over each event; a throw after the first is unknown, and nothing is sent again", async () => {
  const seen: unknown[] = [];
  answers.push(events({ type: "plan", exposed: [] }));
  assert.equal(await agent("portfolio").stream("sweep", { execute: false }, event => { seen.push(event); }), undefined);
  assert.deepEqual(seen, [{ type: "plan", exposed: [] }]);

  answers.push(events({ type: "plan", exposed: [] }, { type: "shield", asset: "a", status: "SUCCESS", correlationId: "c" }));
  const ended = await agent("portfolio").stream("sweep", { execute: true }, () => { throw new Error("render failed"); });
  assert.deepEqual(ended, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  assert.equal(sent.length, 2);
});

test("a gateway denial is reported, with its scope, before the call returns", async () => {
  const denials: Denial[] = [];
  const stop = onDenial(denial => denials.push(denial));
  try {
    answers.push(json({ error: "No access to this agent", scope: "agent" }, 403));
    await assert.rejects(agent("portfolio").read("overview", undefined), (error: unknown) => failureKind(error) === "forbidden");
    answers.push(json({ error: "Sign in again" }, 401));
    await assert.rejects(gateway.challenge(), (error: unknown) => failureKind(error) === "session");
  } finally { stop(); }
  assert.deepEqual(denials, [{ agent: "portfolio", scope: "agent", message: "No access to this agent" }, { agent: null, scope: "session", message: "Sign in again" }]);
});

test("the gateway's session: discovery is parsed or refused, never guessed", async () => {
  answers.push(json({ agents: [], viewer: null, invoices: "https://invoices.test/submit" }));
  assert.equal((await gateway.me()).viewer, null);
  answers.push(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(gateway.me(), /unexpected response/);
  answers.push(json({ agents: "nope" }));
  await assert.rejects(gateway.me(), /invalid discovery data/);
});

test("sign-in posts the wallet's signature once; sign-out ends the session", async () => {
  const signed = { accountId: "owner.near", publicKey: "ed25519:k", signature: "s", nonce: "n", callbackUrls: ["https://treasury.test/"] };
  answers.push(json({ message: "Sign in", recipient: "treasury.test", nonce: "n" }), json({ ok: true }), json({}));
  assert.deepEqual(await gateway.challenge(), { message: "Sign in", recipient: "treasury.test", nonce: "n" });
  await gateway.signIn(signed);
  await gateway.signOut();
  assert.deepEqual(sent.map(s => [s.method, s.url]), [["GET", "/gw/challenge"], ["POST", "/gw/session"], ["POST", "/gw/logout"]]);
  assert.deepEqual(JSON.parse(sent[1]!.body), signed);
});

test("cached reads are keyed by host, agent and viewer, so accounts never share records", () => {
  assert.notDeepEqual(reads("portfolio", "owner.near").overview.queryKey, reads("portfolio", "member.near").overview.queryKey);
  assert.deepEqual(scopeOfKey([scope("portfolio", "owner.near"), "overview"]), { host: "treasury.test", agent: "portfolio", account: "owner.near" });
  assert.equal(scopeOfKey(["gateway"]), undefined);
});
