import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * provider. Two agents: one owned by a DAO, whose policy comes from a stand-in RPC, and one owned by a
 * plain account, which the RPC knows no contract for. No membership is changed anywhere.
 */

const SECRET = "test-only-gateway-session-secret-0123456789";
const DAO = "fixture.sputnik-dao.near";
const OWNER = "owner.near";
const policy = {
  proposal_bond: "0",
  roles: [{ name: "Viewer", kind: { Group: ["member.near"] }, permissions: [], vote_policy: {} }],
  default_vote_policy: { threshold: [1, 2] },
};

const reached: string[] = [];
let agentServers: Server[], rpcServer: Server, gateway: ChildProcess, base: string, dir: string;

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));

function paths(node: object, prefix = ""): string[] {
  return Object.entries(node).flatMap(([name, child]) =>
    "~orpc" in child ? [`${prefix}${name}`] : paths(child as object, `${prefix}${name}/`));
}

/** The DAO's MPC key as the stand-in RPC derives it, and so the account that signs as the DAO's agents' owner. */
const DAO_KEY = "ed25519:11111111111111111111111111111111";
const DAO_SIGNER = "0".repeat(64);

/**
 * An agent server whose agent is owned by `owner` (null: not created yet). It counts every call the
 * gateway forwards; the gateway's own owner check (marked `x-gateway`) is answered, not counted.
 */
const agentServer = (owner: string | null) => createServer((req, res) => {
  const path = req.url!.replace(/^\/rpc\//, "");
  if (req.headers["x-gateway"]) {
    const setup = { agentId: owner && "a".repeat(64), owner: owner && { type: "near", account_id: owner } };
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ json: path === "setup" ? setup : null }));
  }
  reached.push(path);
  res.writeHead(200, { "content-type": "application/json" }).end('{"json":null}');
});

before(async () => {
  agentServers = [agentServer(DAO_SIGNER), agentServer(OWNER), agentServer(null), agentServer("someone-else.near")];
  rpcServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk)).on("end", () => {
      const { id, params } = JSON.parse(body) as { id: unknown; params: { account_id?: string } };
      const view = (value: unknown) => ({ result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } });
      // Only the DAO and the MPC signer have contracts; any other account is answered as the chain answers an unknown one.
      const answer = params.account_id === DAO ? view(policy) : params.account_id === "v1.signer" ? view(DAO_KEY)
        : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error" } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...answer }));
    });
  });
  const [treasuryPort, walletPort, newPort, strayPort, rpcPort] = await Promise.all([...agentServers.map(listen), listen(rpcServer)]);

  dir = mkdtempSync(join(tmpdir(), "gateway-denial-"));
  const file = join(dir, "dashboard.json");
  writeFileSync(file, JSON.stringify({ host: "dao.test", agents: [
    { name: "treasury", owner: DAO, operators: ["ops.near"], port: treasuryPort },
    { name: "wallet", owner: OWNER, port: walletPort },
    // Not created yet: its configured owner sets it up.
    { name: "new", owner: OWNER, port: newPort },
    // Configured as OWNER's, but its server reports another owner: closed to everyone.
    { name: "stray", owner: OWNER, operators: ["ops.near"], port: strayPort },
  ] }));
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
  for (const server of agentServers ?? []) server.close();
  rpcServer?.close();
});

const session = (account: string) => ({ cookie: `dao_session=${sessionToken(account, SECRET)}` });
const call = (path: string, account?: string, agent = "treasury") =>
  fetch(`${base}/a/${agent}/rpc/${path}`, {
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
  assert.ok(((await answer.json()) as { calls: { path: string }[] }).calls.some((i) => i.path === "autopilot/tick"));
});

test("a torn line in the intervention record is counted, and the call recorded after it still reads", async () => {
  const path = join(dir, ".evidence", "interventions.jsonl");
  appendFileSync(path, '{"at":"2026-'); // a crash mid-append
  const torn = readFileSync(path, "utf8").split("\n").length;
  assert.equal((await call("autopilot/tick", "ops.near")).status, 200);
  const { calls, corrupt } = (await (await interventions("ops.near")).json()) as { calls: { path: string }[]; corrupt: number[] };
  assert.deepEqual(corrupt, [torn]);
  assert.equal(calls.at(-1)?.path, "autopilot/tick");
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

test("signed out, the gateway serves no roster or proposals: the old public view is gone", async () => {
  assert.equal((await fetch(`${base}/gw/public`)).status, 404);
  assert.equal((await fetch(`${base}/gw/proposals`)).status, 401);
});

test("a failure on the gateway's side is a 500 that shows no internals", async () => {
  // The stand-in RPC answers every view of the DAO with its policy, which is not a proposal list.
  const answer = await fetch(`${base}/gw/proposals?dao=${DAO}`, { headers: session("member.near") });
  assert.equal(answer.status, 500);
  assert.deepEqual(await answer.json(), { error: "Something went wrong. Try again later." });
});

test("an agent owned by a plain account: its owner operates it and sees nothing of the DAO's agents; the DAO's operators see nothing of it", async () => {
  reached.length = 0;
  assert.equal((await call("pay", OWNER, "wallet")).status, 200);
  assert.equal((await call("overview", OWNER, "treasury")).status, 403);
  assert.equal((await call("overview", "member.near", "wallet")).status, 403);
  assert.equal((await call("overview", "ops.near", "wallet")).status, 403, "operators are named per agent");
  assert.deepEqual(reached, ["pay"]);
});

test("who sees what: the agents a visitor may know of, each with its owner, and a viewer's access to each", async () => {
  type Me = { agents: unknown; invoices: unknown; viewer: { account: string; access: Record<string, unknown> } | null };
  const me = (account?: string) => fetch(`${base}/gw/me`, { headers: account ? session(account) : {} }).then((r) => r.json() as Promise<Me>);
  const dao = { name: "treasury", owner: DAO, dao: true };
  const wallet = { name: "wallet", owner: OWNER, dao: false };
  // Signed out, a wallet's agent isn't listed: who owns an agent here is the owner's to tell.
  assert.deepEqual(await me(), { agents: [dao], invoices: null, viewer: null });
  const operator = { role: "operator", canPropose: false, canVote: false };
  assert.deepEqual(await me(OWNER), {
    agents: [wallet, { name: "new", owner: OWNER, dao: false }],
    invoices: null,
    viewer: { account: OWNER, access: { wallet: operator, new: operator } },
  });
  assert.deepEqual((await me("member.near")).agents, [dao]);
});

test("proposals are listed per DAO, for viewers of an agent it owns", async () => {
  const proposals = (dao: string, account: string) => fetch(`${base}/gw/proposals?dao=${dao}`, { headers: session(account) });
  assert.equal((await proposals(DAO, OWNER)).status, 403);
  assert.equal((await proposals(OWNER, "member.near")).status, 403);
  assert.equal((await proposals(OWNER, OWNER)).status, 400, "a plain account files no proposals");
});

test("the configured owner must be the agent's real owner: an agent owned by anyone else is closed to everyone", async () => {
  reached.length = 0;
  for (const account of [OWNER, "ops.near"]) assert.equal((await call("overview", account, "stray")).status, 403, account);
  assert.equal((await call("pay", OWNER, "new")).status, 200, "an agent not created yet is its configured owner's to set up");
  assert.equal((await call("overview", "member.near", "treasury")).status, 200, "the DAO's agent is owned by the account the DAO signs with");
  assert.deepEqual(reached, ["pay", "overview"]);
});

test("an operator sees only the interventions on the agents it operates", async () => {
  assert.equal((await call("autopilot/tick", "ops.near")).status, 200);
  const calls = async (account: string) => ((await (await interventions(account)).json()) as { calls: { agent: string }[] }).calls;
  assert.ok((await calls("ops.near")).some((c) => c.agent === "treasury"));
  assert.deepEqual((await calls(OWNER)).filter((c) => c.agent !== "wallet" && c.agent !== "new"), []);
});
