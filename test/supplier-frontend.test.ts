import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { serveSupplierFrontend, supplierAsset } from "../src/gateway/supplier-frontend.js";

test("supplier presentation excludes all API, internal, traversal and owner routes", () => {
 for (const path of ["/api/invoices", "/internal/compensation", "/a/payout/access", "/invoice-ui/static/../.env", "/static/proto.js", "/static/a.js?x", "/.env"]) assert.equal(supplierAsset(path), null);
 assert.equal(supplierAsset("/report"), "/contributor.html");
});
test("frontend releases change without restarting backend; cookies and private headers never reach assets", async () => {
 let release = "first", redirected = false, incompatible = false; const seen: unknown[] = [];
 const frontend = createServer((req,res) => { seen.push(req.headers.cookie, req.headers.authorization); if (redirected) return res.writeHead(302,{location:"https://example.invalid"}).end(); if(req.url === "/contract.json") return res.end(JSON.stringify({version:1,product:"invoices",required:[incompatible ? "unsupported-v9" : "supplier-session-v1"]})); res.end(release); });
 await new Promise<void>(r=>frontend.listen(0,"127.0.0.1",r));
 const origin=`http://127.0.0.1:${(frontend.address() as {port:number}).port}`;
 const gateway = createServer(async(req,res)=>{if (!await serveSupplierFrontend(res,new URL(req.url!,origin).pathname,origin)) res.writeHead(404).end();});
 await new Promise<void>(r=>gateway.listen(0,"127.0.0.1",r));
 const host=`http://127.0.0.1:${(gateway.address() as {port:number}).port}`;
 try {
  assert.equal(await (await fetch(host,{headers:{cookie:"private=secret",authorization:"Bearer secret"}})).text(),"first");
  release="second"; assert.equal(await (await fetch(host)).text(),"second");
  release="first"; assert.equal(await (await fetch(host)).text(),"first");
  assert.equal((await fetch(host+"/api/invoices")).status,404); assert.ok(seen.every(v=>v===undefined));
  incompatible=true; assert.equal((await fetch(host)).status,503); incompatible=false;
  redirected=true; assert.equal((await fetch(host)).status,503);
 }finally{await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>frontend.close(()=>r()))]);}
});
