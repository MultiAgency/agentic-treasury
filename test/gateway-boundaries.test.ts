import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { runtimeImports } from "./fixtures/source-analysis.mjs";

test("gateway modules do not embed executor handlers or sibling product source", () => {
  const forbidden = new Set(["agent", "router", "invoices", "treasury", "plans", "autopilot"].map(name => resolve(`src/${name}.ts`)));
  for (const name of readdirSync("src/gateway").filter(name => name.endsWith(".ts"))) {
    const file = resolve("src/gateway", name);
    for (const specifier of runtimeImports(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      assert.ok(target.startsWith(resolve("src") + "/"), `${name} imports outside Proto source: ${specifier}`);
      assert.ok(!forbidden.has(target), `${name} embeds executor implementation: ${specifier}`);
    }
  }
});
