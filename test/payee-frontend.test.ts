import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { servePayeeFrontend, payeeAsset } from "../src/gateway/payee-frontend.js";

test("contributor presentation excludes all API, internal, traversal and owner routes", () => {
 for (const path of ["/api/invoices", "/internal/compensation", "/a/payout/access", "/invoice-ui/static/../.env", "/static/proto.js", "/static/a.js?x", "/.env"]) assert.equal(payeeAsset(path), null);
 assert.equal(payeeAsset("/report"), "/report");
});
test("frontend releases change without restarting backend; cookies and private headers never reach assets", async () => {
 let release = "first", redirected = false, incompatible = false, skill = ""; const seen: unknown[] = [];
 const frontend = createServer((req,res) => { seen.push(req.headers.cookie, req.headers.authorization); if (redirected) return res.writeHead(302,{location:"https://example.invalid"}).end(); if(req.url === "/contract.json") return res.end(JSON.stringify({version:1,product:"invoices",required:[incompatible ? "unsupported-v9" : "supplier-session-v1"]})); if(req.url === "/skill.md") return skill ? res.writeHead(200,{"content-type":"text/markdown"}).end(skill) : res.writeHead(404).end(); res.end(release); });
 await new Promise<void>(r=>frontend.listen(0,"127.0.0.1",r));
 const origin=`http://127.0.0.1:${(frontend.address() as {port:number}).port}`;
 const gateway = createServer(async(req,res)=>{if (!await servePayeeFrontend(res,new URL(req.url!,origin).pathname,origin)) res.writeHead(404).end();});
 await new Promise<void>(r=>gateway.listen(0,"127.0.0.1",r));
 const host=`http://127.0.0.1:${(gateway.address() as {port:number}).port}`;
 try {
  assert.equal(await (await fetch(host,{headers:{cookie:"private=secret",authorization:"Bearer secret"}})).text(),"first");
  release="second"; assert.equal(await (await fetch(host)).text(),"second");
  release="first"; assert.equal(await (await fetch(host)).text(),"first");
  assert.equal((await fetch(host+"/api/invoices")).status,404); assert.ok(seen.every(v=>v===undefined));
  incompatible=true; assert.equal((await fetch(host)).status,503); incompatible=false;
  assert.equal((await fetch(host+"/skill.md")).status,404,"an app without a skill gets 404, never another copy");
  skill="# Invoices skill"; const answer=await fetch(host+"/skill.md"); assert.equal(await answer.text(),"# Invoices skill"); assert.match(answer.headers.get("content-type")!,/markdown/);
  incompatible=true; assert.equal((await fetch(host+"/skill.md")).status,503,"the skill passes the contract check"); incompatible=false;
  redirected=true; assert.equal((await fetch(host)).status,503);
 }finally{await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>frontend.close(()=>r()))]);}
});
test("a page or skill is served only with the contract of the same release: mismatched or one-sided ids are refused", async () => {
  // Both answers are compatible; only the release ids differ.
  const ids: { page?: string; contract?: string } = {};
  const frontend = createServer((req, res) => {
    const id = req.url === "/contract.json" ? ids.contract : ids.page;
    res.writeHead(200, { ...(id && { "x-release-id": id }), ...(req.url === "/skill.md" && { "content-type": "text/markdown" }) });
    if (req.url === "/contract.json") return res.end(JSON.stringify({ version: 1, product: "invoices", required: ["supplier-session-v1"] }));
    res.end(req.url === "/skill.md" ? "# skill" : "page");
  });
  await new Promise<void>(r => frontend.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(frontend.address() as { port: number }).port}`;
  const gateway = createServer(async (req, res) => { if (!await servePayeeFrontend(res, new URL(req.url!, origin).pathname, origin)) res.writeHead(404).end(); });
  await new Promise<void>(r => gateway.listen(0, "127.0.0.1", r));
  const host = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  try {
    for (const path of ["/", "/skill.md"]) {
      Object.assign(ids, { page: "a", contract: "a" }); assert.equal((await fetch(host + path)).status, 200, `${path}: same release`);
      Object.assign(ids, { page: "a", contract: "b" }); assert.equal((await fetch(host + path)).status, 503, `${path}: another release's contract`);
      Object.assign(ids, { page: "a", contract: undefined }); assert.equal((await fetch(host + path)).status, 503, `${path}: contract without a release id`);
      Object.assign(ids, { page: undefined, contract: "a" }); assert.equal((await fetch(host + path)).status, 503, `${path}: page without a release id`);
    }
  } finally { await Promise.all([new Promise<void>(r => gateway.close(() => r())), new Promise<void>(r => frontend.close(() => r()))]); }
});
