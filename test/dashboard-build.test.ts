import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Exercise the actual bundler with only source inputs copied before the Docker build step.
// This is a build-input check, not a Linux image or runtime validation.
test("dashboard Dockerfile copies every source needed for its web build", { timeout: 60_000 }, () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "dashboard-build-"));
  try {
    const dockerfile = readFileSync(join(root, "Dockerfile.dashboard"), "utf8");
    const beforeBuild = dockerfile.split(/^RUN pnpm build:web$/m);
    assert.equal(beforeBuild.length, 2, "Locate the dashboard build boundary explicitly");
    for (const line of beforeBuild[0]!.split("\n")) {
      if (!line.startsWith("COPY ")) continue;
      const parts = line.slice(5).trim().split(/\s+/);
      const destination = parts.pop()!;
      assert.ok(!parts.some(part => /[\[\]*]/.test(part)), "Update fixture for complex COPY syntax");
      for (const source of parts) cpSync(join(root, source), join(dir, destination === "./" ? basename(source) : destination), {
        recursive: true, filter: path => !["node_modules", "dist"].includes(basename(path)),
      });
    }
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    const result = spawnSync("pnpm", ["build:web"], { cwd: dir, encoding: "utf8", timeout: 45_000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
