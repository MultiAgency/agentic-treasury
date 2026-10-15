import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionToken } from "../src/signin.js";

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
test("hosted setup admits a new wallet, isolates its real child, and recovers its reservation after gateway restart", { timeout: 60_000 }, async t => {
  const root = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "hosted-gateway-"));
  const secret = "offline-self-service-session-secret-123456789";
  const rpc = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk).on("end", () => {
      const { id, params } = JSON.parse(body);
      const view = (value: unknown) => ({ result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } });
      const policy = { proposal_bond: "0", roles: [{ name: "council", kind: { Group: ["alice.near"] }, permissions: ["call:AddProposal"], vote_policy: {} }], default_vote_policy: { threshold: [1, 2] } };
      const answer = params.account_id === "team.sputnik-dao.near" ? view(policy) : params.account_id === "v1.signer" ? view("ed25519:11111111111111111111111111111111")
        : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error" } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...answer }));
    });
  });
  const rpcPort = await listen(rpc);
  const old = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ json: { agentId: null, owner: null } })));
  const oldPort = await listen(old);
  const probe = createServer(); const port = await listen(probe); await new Promise(resolve => probe.close(resolve));
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify({ host: "fixture.test", selfService: true, walkthroughs: true,
    agents: [{ name: "existing", owner: "existing.near", port: oldPort }] }));
  let child: ChildProcess;
  let diagnostics = "";
  const stop = async () => {
    if (child && child.exitCode === null) await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
  };
  t.after(async () => { await stop(); rpc.close(); old.close(); rmSync(dir, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "src/gateway/server.ts")], { cwd: dir,
      env: { ...process.env, PORT: String(port), SESSION_SECRET: secret, NEAR_RPC_URL: `http://127.0.0.1:${rpcPort}` }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", data => { diagnostics = (diagnostics + data.toString()).slice(-8000); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Gateway startup timed out")), 8_000);
      child.stdout!.on("data", data => { if (data.toString().includes("on port")) { clearTimeout(timer); resolve(); } });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}`)); });
    });
  };
  const call = (path: string, account?: string, body?: unknown, origin?: string) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(account && { cookie: `dao_session=${sessionToken(account, secret)}` }), ...(origin && { origin }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  await start();
  const publicView = await (await call("/gw/me")).json();
  assert.deepEqual(publicView.agents, []);
  assert.equal(publicView.viewer, null);
  const fresh = await (await call("/gw/me", "alice.near")).json();
  assert.equal(fresh.viewer.account, "alice.near");
  assert.deepEqual(fresh.agents, []);
  const input = { owner: "alice.near", kind: "wallet", area: "treasury" };
  assert.equal((await call("/gw/agents", undefined, input)).status, 401);
  assert.equal((await call("/gw/agents", "bob.near", input)).status, 403);
  assert.equal((await call("/gw/agents", "alice.near", input, "https://foreign.test")).status, 403);
  const first = await call("/gw/agents", "alice.near", input);
  assert.equal(first.status, 200);
  const { name } = await first.json();
  assert.deepEqual(await (await call("/gw/agents", "alice.near", input)).json(), { name });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    const view = await (await call("/gw/me", "alice.near")).json();
    if (view.viewer.access[name]) { ready = true; assert.equal(view.agents[0].invoices, null); break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `real isolated child answers ownership checks: ${diagnostics}`);
  const instance = await call(`/a/${name}/rpc/instance`, "alice.near", {});
  assert.equal(instance.status, 200);
  assert.deepEqual((await instance.json()).json, { agentId: null, executor: true }, "parent's fixture AGENT_ID never leaks into new setup");
  assert.equal((await call(`/a/${name}/rpc/instance`, "bob.near", {})).status, 403);
  const forged = await call(`/a/${name}/rpc/owner/prepare`, "alice.near", { json: {
    signer: "wallet", action: { type: "agent_create", owner: { type: "near", account_id: "bob.near", public_key: "ed25519:key" } },
  } });
  assert.equal(forged.status, 400);
  assert.match(await forged.text(), /bound to its selected owner/);
  const daoInput = { owner: "team.sputnik-dao.near", kind: "dao", area: "payables" };
  assert.equal((await call("/gw/agents", "bob.near", daoInput)).status, 403);
  const daoResponse = await call("/gw/agents", "alice.near", daoInput);
  assert.equal(daoResponse.status, 200);
  const daoName = (await daoResponse.json()).name;
  let daoSetup;
  for (let i = 0; i < 150; i++) {
    const response = await call(`/a/${daoName}/rpc/setup`, "alice.near", {});
    if (response.ok) { daoSetup = (await response.json()).json; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(daoSetup?.agentId, null);
  assert.equal(daoSetup?.dao.id, daoInput.owner);
  assert.equal(daoSetup?.dao.owner.account_id, "0".repeat(64));
  assert.equal(daoSetup?.dao.funded, false, "unfunded DAO owner account remains an explicit prerequisite");
  await stop(); await start();
  assert.deepEqual(await (await call("/gw/agents", "alice.near", input)).json(), { name });
});
