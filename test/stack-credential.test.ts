import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "stack-credential.ts");
const TOKEN = "tmc_00000000-0000-0000-0000-000000000000.test";

/** A stack directory with only `state.json` and `controls/`, whose control answers `answer` to the first request. */
function fakeStack(answer: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "stack-")), controls = join(directory, "controls");
  mkdirSync(controls);
  writeFileSync(join(directory, "state.json"), JSON.stringify({ treasury: { agent: "portfolio", machineBase: "https://127.0.0.1:4444/machine/v1/a/portfolio" } }));
  const requests: unknown[] = [];
  let stopped = false;
  void (async () => {
    while (!stopped) {
      for (const name of readdirSync(controls).filter(name => /^treasury-.*\d\.json$/.test(name))) {
        const result = join(controls, name.replace(/\.json$/, ".result.json"));
        if (existsSync(result)) continue;
        requests.push(JSON.parse(readFileSync(join(controls, name), "utf8")));
        writeFileSync(result, JSON.stringify(answer));
      }
      await delay(20);
    }
  })();
  return { directory, requests, stop: () => { stopped = true; } };
}

function credential(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: { PATH: process.env.PATH } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("the token replaces its key in a 0600 .env, keeping comments and blank lines", async () => {
  const stack = fakeStack({ ok: true, value: { token: TOKEN } }), cwd = mkdtempSync(join(tmpdir(), "repo-"));
  writeFileSync(join(cwd, ".env"), "# treasury\nTREASURY_AGENT=old\n\n# approval\nTREASURY_EXECUTE_TOKEN=tmc_old\nOTHER=kept\n", { mode: 0o644 });
  try {
    const { code, stdout, stderr } = await credential(cwd, [stack.directory, "execute", "600"]);
    assert.equal(code, 0, stderr);
    assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN), "the token is never printed");
    assert.equal(statSync(join(cwd, ".env")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(cwd, ".env"), "utf8"),
      `# treasury\nTREASURY_AGENT=portfolio\n\n# approval\nTREASURY_EXECUTE_TOKEN=${TOKEN}\nOTHER=kept\nTREASURY_ORIGIN=https://127.0.0.1:4444\n`);
    assert.deepEqual(stack.requests, [{ command: "machineCredential", label: "treasury execute", scopes: ["execute-plan"], ttlSeconds: 600 }]);
    assert.deepEqual(readdirSync(cwd).sort(), [".env"], "no temporary file is left");
  } finally { stack.stop(); }
});

test("roles, TTLs and refusals: nothing is issued or written unless all are valid", async () => {
  const stack = fakeStack({ ok: false, error: "Issuing answered 400: Invalid issuance input" }), cwd = mkdtempSync(join(tmpdir(), "repo-"));
  try {
    for (const args of [["constructor"], ["toString"], ["execute", "10m"], ["execute", "59"], ["execute", "86401"]]) {
      const { code, stderr } = await credential(cwd, [stack.directory, ...args]);
      assert.equal(code, 1, args.join(" "));
      assert.match(stderr, /Usage: stack-credential|ttlSeconds must be an integer from 60 to 86400/, args.join(" "));
    }
    assert.deepEqual(stack.requests, [], "no control was written");

    const refused = await credential(cwd, [stack.directory, "propose", "3600"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Issuing answered 400: Invalid issuance input/, "the platform's error is printed");
    assert.deepEqual(readdirSync(cwd), [], ".env isn't written");
  } finally { stack.stop(); }
});
