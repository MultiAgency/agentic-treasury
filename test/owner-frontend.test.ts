import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { serveOwnerFrontend } from "../src/gateway/owner-frontend.js";

const listen = async (server: Server) => { await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
const close = (server: Server) => new Promise<void>(r => server.close(() => r()));

/** A release process: two releases, an active pointer, and an optional hook run between requests. */
function releaseServer() {
  const releases: Record<string, { contract: object; html: string }> = {
    a: { contract: { version: 1, product: "treasury", required: ["gateway-session-v1", "treasury-plans-v1"] }, html: "<title>A</title>" },
    b: { contract: { version: 1, product: "treasury", required: ["gateway-session-v1", "treasury-unknown-v9"] }, html: "<title>B</title>" },
    // Incompatible, with a skill: the release a binding test starts from before the pointer moves to compatible A.
    c: { contract: { version: 1, product: "treasury", required: ["gateway-session-v1", "treasury-unknown-v9"] }, html: "<title>C</title>" },
  };
  const state = { active: "a", seen: [] as unknown[], afterHtml: () => {}, untyped: false };
  const server = createServer((req, res) => {
    state.seen.push(req.headers.cookie, req.headers.authorization);
    const release = releases[state.active]!;
    if (req.url === "/contract.json") return res.writeHead(200, { "content-type": "application/json", "x-release-id": state.active }).end(JSON.stringify(release.contract));
    if (req.url === "/skill.md") {
      if (state.active === "b") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "x-release-id": state.active }).end(`# ${state.active.toUpperCase()} skill`); return state.afterHtml();
    }
    if (req.url === "/static/js/a.1234.js") return res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable" }).end("chunk");
    if (req.url === "/" || req.url === "/plans") { res.writeHead(200, { ...(!state.untyped && { "content-type": "text/html; charset=utf-8" }), "x-release-id": state.active }).end(release.html); return state.afterHtml(); }
    res.writeHead(404).end();
  });
  return { server, state };
}

test("owner HTML is served only from a compatible release whose contract names the same release", async () => {
  const app = releaseServer(), origin = await listen(app.server);
  const gateway = createServer(async (req, res) => {
    const frontend = { origin, product: "treasury", provided: ["gateway-session-v1", "agent-observe-v1", "owner-intents-v1", "treasury-plans-v1"] };
    if (!await serveOwnerFrontend(res, new URL(req.url!, origin).pathname, frontend)) res.writeHead(404).end("shared");
  });
  const host = await listen(gateway);
  try {
    const page = await fetch(host + "/plans", { headers: { cookie: "proto_session=secret", authorization: "Bearer secret" } });
    assert.equal(page.status, 200); assert.equal(await page.text(), "<title>A</title>");
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.ok(app.state.seen.every(value => value === undefined), "no cookie or authorization reaches the release process");
    // The pointer moves between the HTML and contract reads, from incompatible C to compatible A: the contract checked
    // is compatible, so only the release-id binding can refuse serving C's page.
    app.state.active = "c"; app.state.afterHtml = () => { app.state.active = "a"; };
    const swapped = await fetch(host + "/");
    assert.equal(swapped.status, 503); assert.match((await swapped.json() as { error: string }).error, /records and any submitted actions are unchanged/);
    app.state.afterHtml = () => {}; app.state.active = "b";
    assert.equal((await fetch(host + "/")).status, 503, "release B requires an unknown capability");
    app.state.active = "a";
    const skill = await fetch(host + "/skill.md");
    assert.equal(await skill.text(), "# A skill"); assert.match(skill.headers.get("content-type")!, /markdown/);
    app.state.active = "c"; app.state.afterHtml = () => { app.state.active = "a"; };
    assert.equal((await fetch(host + "/skill.md")).status, 503, "the skill is bound to the contract it was checked with (C's skill, A's contract)");
    app.state.afterHtml = () => {}; app.state.active = "b";
    assert.equal(await (await fetch(host + "/skill.md")).text(), "shared", "release B has no skill: not found here, and the caller answers 404");
    const chunk = await fetch(host + "/static/js/a.1234.js");
    assert.equal(await chunk.text(), "chunk", "hashed assets need no binding");
    assert.match(chunk.headers.get("cache-control")!, /immutable/);
    assert.equal(await (await fetch(host + "/static/js/consent.js")).text(), "shared", "unknown assets fall back to Proto's shared build");
    app.state.active = "b"; app.state.untyped = true;
    assert.equal((await fetch(host + "/plans")).status, 503, "a page route is checked even without an HTML content type");
    app.state.untyped = false;
    app.state.active = "a";
    assert.equal(await (await fetch(host + "/")).text(), "<title>A</title>", "rollback restores presentation");
  } finally { await Promise.all([close(gateway), close(app.server)]); }
});

test("a release without a release id, an unreachable origin or a product mismatch is refused", async () => {
  const bare = createServer((req, res) => req.url === "/contract.json"
    ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: 1, product: "treasury", required: ["gateway-session-v1"] }))
    : res.writeHead(200, { "content-type": "text/html" }).end("<title>bare</title>"));
  const origin = await listen(bare);
  const answer = async (frontend: { origin: string; product: string; provided: string[] }) => {
    let status = 0;
    const res = { writeHead: (code: number) => { status = code; return { end: () => {} }; }, headersSent: false } as never;
    await serveOwnerFrontend(res, "/", frontend);
    return status;
  };
  try {
    assert.equal(await answer({ origin, product: "treasury", provided: ["gateway-session-v1"] }), 503, "no x-release-id");
    assert.equal(await answer({ origin: "http://127.0.0.1:1", product: "treasury", provided: [] }), 503, "unreachable");
    assert.equal(await answer({ origin: "http://example.test", product: "treasury", provided: [] }), 503, "plain HTTP off loopback");
  } finally { await close(bare); }
  // Bound and compatible in every other way: only the product decides.
  let product = "payables";
  const bound = createServer((req, res) => req.url === "/contract.json"
    ? res.writeHead(200, { "content-type": "application/json", "x-release-id": "r1" }).end(JSON.stringify({ version: 1, product, required: ["gateway-session-v1"] }))
    : res.writeHead(200, { "content-type": "text/html", "x-release-id": "r1" }).end("<title>bound</title>"));
  const boundOrigin = await listen(bound);
  try {
    assert.equal(await answer({ origin: boundOrigin, product: "treasury", provided: ["gateway-session-v1"] }), 503, "another product's release");
    product = "treasury";
    assert.equal(await answer({ origin: boundOrigin, product: "treasury", provided: ["gateway-session-v1"] }), 200, "the same release naming this product");
  } finally { await close(bound); }
});
