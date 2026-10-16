import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("both Docker contexts explicitly exclude private release artifacts, state and backups", () => {
  for (const file of [".dockerignore", "Dockerfile.dashboard.dockerignore"]) {
    const rules = readFileSync(file, "utf8").split(/\r?\n/).map(line => line.trim());
    for (const path of [".test-artifacts", ".hosted", ".work-orders", ".agreements", ".notify", "*.tar", "*.tar.gz", "*.bak", "backups", "dashboard.json"])
      assert.ok(rules.includes(path), `${file} must exclude ${path}`);
  }
});
