import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { mayCall } from "../src/gateway/allowlist.js";
import { router } from "../src/router.js";
import { sessionToken } from "../src/signin.js";

/**
 * The real gateway process in front of an instrumented agent server: every call that gets past the
 * gateway is counted there, so a refused call is proven never to reach a handler, let alone the
 * provider. The DAO's policy comes from a stand-in RPC; no membership is changed anywhere.
 */

const SECRET = "test-only-gateway-session-secret-0123456789";
const DAO = "fixture.sputnik-dao.near";
const policy = {
  proposal_bond: "0",
  roles: [{ name: "Viewer", kind: { Group: ["member.near"] }, permissions: [], vote_policy: {} }],
  default_vote_policy: { threshold: [1, 2] },
};

const reached: string[] = [];
let agentServer: Server, rpcServer: Server, gateway: ChildProcess, base: string, dir: string;

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));

function paths(node: object, prefix = ""): string[] {
  return Object.entries(node).flatMap(([name, child]) =>
    "~orpc" in child ? [`${prefix}${name}`] : paths(child as object, `${prefix}${name}/`));
}

before(async () => {
  agentServer = createServer((req, res) => {
    reached.push(req.url!.replace(/^\/rpc\//, ""));
    res.writeHead(200, { "content-type": "application/json" }).end('{"json":null}');
  });
  rpcServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk)).on("end", () => {
      const { id } = JSON.parse(body) as { id: unknown };
      const result = { result: [...Buffer.from(JSON.stringify(policy))], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  const [agentPort, rpcPort] = await Promise.all([listen(agentServer), listen(rpcServer)]);

  dir = mkdtempSync(join(tmpdir(), "gateway-denial-"));
  const file = join(dir, "dashboard.json");
  writeFileSync(file, JSON.stringify({ dao: DAO, host: "dao.test", operators: ["ops.near"], agents: [{ name: "treasury", port: agentPort }] }));
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((done) => probe.close(done));
  gateway = spawn(join(process.cwd(), "node_modules/.bin/tsx"), [join(process.cwd(), "src/gateway/server.ts")], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), DASHBOARD_FILE: file, SESSION_SECRET: SECRET, NEAR_RPC_URL: `http://127.0.0.1:${rpcPort}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  base = `http://127.0.0.1:${port}`;
  await new Promise<void>((done, fail) => {
    gateway.stdout!.on("data", (chunk: Buffer) => chunk.toString().includes("on port") && done());
    gateway.on("exit", (code) => fail(new Error(`The gateway exited (${code})`)));
  });
});

after(() => {
  gateway?.kill();
  agentServer?.close();
  rpcServer?.close();
});

const call = (path: string, account?: string) =>
  fetch(`${base}/a/treasury/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(account && { cookie: `dao_session=${sessionToken(account, SECRET)}` }) },
    body: "{}",
  });

const all = paths(router);
const operatorOnly = all.filter((path) => !mayCall("member", path));

test("without a session, no procedure reaches the agent server", async () => {
  reached.length = 0;
  for (const path of all) assert.equal((await call(path)).status, 401, path);
  assert.deepEqual(reached, []);
});

test("an outsider's valid session reaches nothing", async () => {
  reached.length = 0;
  for (const path of all) assert.equal((await call(path, "outsider.near")).status, 401, path);
  assert.deepEqual(reached, []);
});

test("a plain member is refused every money and settings procedure before it reaches the agent server", async () => {
  assert.ok(operatorOnly.includes("pay") && operatorOnly.includes("executePlan") && operatorOnly.includes("sweep"));
  reached.length = 0;
  for (const path of operatorOnly) assert.equal((await call(path, "member.near")).status, 403, path);
  assert.deepEqual(reached, []);
});

test("a forged or altered session is refused", async () => {
  reached.length = 0;
  const forged = await fetch(`${base}/a/treasury/rpc/pay`, { method: "POST", headers: { cookie: "dao_session=bWVtYmVyLm5lYXI.9999999999999.forged" }, body: "{}" });
  assert.equal(forged.status, 401);
  const token = sessionToken("member.near", SECRET).split(".");
  const altered = `${Buffer.from("ops.near").toString("base64url")}.${token[1]}.${token[2]}`;
  const promoted = await fetch(`${base}/a/treasury/rpc/pay`, { method: "POST", headers: { cookie: `dao_session=${altered}` }, body: "{}" });
  assert.equal(promoted.status, 401);
  assert.deepEqual(reached, []);
});

test("path tricks don't turn a member read into a money call", async () => {
  reached.length = 0;
  for (const path of ["overview/../pay", "overview%2F..%2Fpay", "overview/", "pay?x=overview", "./pay"])
    assert.notEqual((await call(path, "member.near")).status, 200, path);
  assert.ok(reached.every((path) => mayCall("member", path.split("?")[0]!)), JSON.stringify(reached));
});

test("the controls: a member's reads and an operator's calls do get through", async () => {
  reached.length = 0;
  assert.equal((await call("overview", "member.near")).status, 200);
  assert.equal((await call("pay", "ops.near")).status, 200);
  assert.deepEqual(reached, ["overview", "pay"]);
});

const recorded = () => {
  const path = join(dir, ".evidence", "interventions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { account: string; path: string }) : [];
};
const interventions = (account?: string) =>
  fetch(`${base}/gw/interventions?since=2000-01-01T00:00:00Z`, { headers: account ? { cookie: `dao_session=${sessionToken(account, SECRET)}` } : {} });

test("an operator's call beyond reads is recorded before it runs; reads and refusals aren't", async () => {
  const before = recorded().length;
  await call("overview", "ops.near");
  await call("pay", "member.near");
  assert.equal(recorded().length, before);
  reached.length = 0;
  assert.equal((await call("autopilot/tick", "ops.near")).status, 200);
  assert.deepEqual(reached, ["autopilot/tick"]);
  assert.deepEqual(recorded().slice(before).map((r) => [r.account, r.path]), [["ops.near", "autopilot/tick"]]);
});

test("the intervention record is for operators only", async () => {
  assert.equal((await interventions()).status, 401);
  assert.equal((await interventions("member.near")).status, 403);
  const answer = await interventions("ops.near");
  assert.equal(answer.status, 200);
  assert.ok(((await answer.json()) as { path: string }[]).some((i) => i.path === "autopilot/tick"));
});

test("an operator call that can't be recorded is not run", async () => {
  const path = join(dir, ".evidence", "interventions.jsonl");
  rmSync(path, { force: true });
  mkdirSync(path); // a directory where the record should be
  try {
    reached.length = 0;
    assert.equal((await call("pay", "ops.near")).status, 503);
    assert.deepEqual(reached, []);
  } finally {
    rmSync(path, { recursive: true });
  }
});

test("a cross-site or malformed Origin is refused 403, not mistaken for a bad request", async () => {
  reached.length = 0;
  for (const origin of ["null", "https://elsewhere.example", "not a url"]) {
    const answer = await fetch(`${base}/a/treasury/rpc/pay`, {
      method: "POST",
      headers: { origin, cookie: `dao_session=${sessionToken("ops.near", SECRET)}` },
      body: "{}",
    });
    assert.equal(answer.status, 403, origin);
  }
  assert.deepEqual(reached, []);
});

test("a failure on the gateway's side is a 500 that shows no internals", async () => {
  // The stand-in RPC answers every view with the DAO's policy, which is not a proposal list.
  const answer = await fetch(`${base}/gw/public`);
  assert.equal(answer.status, 500);
  assert.deepEqual(await answer.json(), { error: "Something went wrong. Try again later." });
});
