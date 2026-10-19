import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/gateway/config.js";
test("a configured frontend must be an absolute directory containing index.html", t => {
  const dir = mkdtempSync(join(tmpdir(), "frontend-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "gateway.json");
  const config = (frontendDist?: string) => ({ host: "treasury.test", selfService: true, agents: [], hosts: { "treasury.test": { demo: "treasury", agents: [], hostedAreas: ["treasury"], ...(frontendDist && { frontendDist }) } } });
  writeFileSync(file, JSON.stringify(config(dir)));
  assert.throws(() => loadConfig(file), /frontend/i);
  writeFileSync(join(dir, "index.html"), "<title>Independent Treasury</title>");
  assert.equal(loadConfig(file).hosts?.["treasury.test"]?.frontendDist, dir);
  writeFileSync(file, JSON.stringify(config("relative/build")));
  assert.throws(() => loadConfig(file));
  writeFileSync(file, JSON.stringify(config()));
  assert.equal(loadConfig(file).hosts?.["treasury.test"]?.frontendDist, undefined);
});


test("static contributor links are explicit HTTPS Payables configuration", t => {
  const dir = mkdtempSync(join(tmpdir(), "contributor-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "gateway.json");
  const write = (invoices?: string, area = "payables") => writeFileSync(file, JSON.stringify({
    host: "payables.test", agents: [{ name: "payout", owner: "alice.near", area, port: 9000, executor: false, ...(invoices !== undefined && { invoices }) }],
  }));
  write("https://invoices.test/submit?source=agency");
  assert.equal((loadConfig(file).agents[0] as { invoices?: string }).invoices, "https://invoices.test/submit?source=agency");
  for (const url of ["javascript:alert(1)", "http://invoices.test/", "https://user:password@invoices.test/", "https://invoices.test/#fragment"]) {
    write(url); assert.throws(() => loadConfig(file), url);
  }
  write("https://invoices.test/submit", "treasury"); assert.throws(() => loadConfig(file));
  write(); assert.equal((loadConfig(file).agents[0] as { invoices?: string }).invoices, undefined);
});

test("an owner app release origin is HTTPS or loopback, names its product, and excludes a legacy directory", t => {
  const dir = mkdtempSync(join(tmpdir(), "owner-frontend-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "index.html"), "<title>Legacy</title>");
  const file = join(dir, "gateway.json");
  const write = (host: object, demo = "treasury") => writeFileSync(file, JSON.stringify({ host: "treasury.test", selfService: true, agents: [], hosts: { "treasury.test": { demo, agents: [], hostedAreas: demo === "invoices" ? [] : ["treasury"], ...host } } }));
  write({ frontend: { origin: "https://releases.test/", product: "treasury" } });
  assert.equal(loadConfig(file).hosts?.["treasury.test"]?.frontend?.origin, "https://releases.test/");
  write({ frontend: { origin: "http://127.0.0.1:3020", product: "treasury" } });
  assert.equal(loadConfig(file).hosts?.["treasury.test"]?.frontend?.product, "treasury");
  for (const origin of ["http://releases.test/", "https://user:pw@releases.test/", "https://releases.test/build/"]) {
    write({ frontend: { origin, product: "treasury" } }); assert.throws(() => loadConfig(file), origin);
  }
  write({ frontend: { origin: "https://releases.test/", product: "treasury" }, frontendDist: dir }); assert.throws(() => loadConfig(file), /one owner frontend/);
  write({ frontend: { origin: "https://releases.test/", product: "Treasury!" } }); assert.throws(() => loadConfig(file));
});
