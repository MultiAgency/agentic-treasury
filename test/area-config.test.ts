import { temporaryDirectories } from "./fixtures/harness.js";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { childEnv, loadConfig } from "../src/gateway/config.js";

const scratch = temporaryDirectories();

test("distinct agent names cannot share a loopback port", () => {
  const file = join(scratch.create("port-config"), "dashboard.json");
  for (const managed of [false, true]) {
    const agents = ["one", "two"].map(name => ({ name, owner: "owner.near", port: 8789,
      ...(managed && { envFile: `.env.${name}` }) }));
    writeFileSync(file, JSON.stringify({ host: "fixture.test", agents }));
    assert.throws(() => loadConfig(file), /ports must be unique/i);
    agents[1]!.port = 8790;
    writeFileSync(file, JSON.stringify({ host: "fixture.test", agents }));
    assert.equal(loadConfig(file).agents.length, 2);
  }
});

test("configured area survives parsing and is isolated from another agent's environment", () => {
  const file = join(scratch.create("area-config"), "dashboard.json");
  writeFileSync(file, JSON.stringify({ host: "fixture.test", agents: [
    { name: "custom", area: "treasury", owner: "owner.near", envFile: ".env.custom", port: 8789 },
  ] }));
  const entry = loadConfig(file).agents[0]!;
  assert.equal((entry as { area?: string }).area, "treasury");
  assert.equal(childEnv({ ...entry, envFile: ".env.custom" }, { DASHBOARD_AREA: "payables" }).DASHBOARD_AREA, "treasury");
  assert.equal(childEnv({ name: "legacy", owner: "owner.near", executor: true, port: 8790, envFile: ".env.legacy" },
    { DASHBOARD_AREA: "payables" }).DASHBOARD_AREA, undefined);
  writeFileSync(file, JSON.stringify({ host: "fixture.test", agents: [
    { name: "custom", area: "typo", owner: "owner.near", port: 8789 },
  ] }));
  assert.throws(() => loadConfig(file), /area/);
});

// Remove state only after this suite has released its locks and stopped its processes.
after(scratch.cleanup);
