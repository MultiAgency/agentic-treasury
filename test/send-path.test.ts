import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Every money action leaves through one door: `dispatch` → `send` in src/agent.ts, the only code that
 * calls a grant's money methods. Anything else reaching a grant must be a dry quote. A new send path
 * fails here before it can skip the checks `dispatch` runs.
 */

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
const sources = files("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));
const MONEY = /\.(swap|transfer|shield|unshield|withdraw)\(/;

test("only src/agent.ts makes a grant client", () => {
  assert.deepEqual(sources.filter((s) => s.text.includes("forGrant(")).map((s) => s.path), ["src/agent.ts"]);
});

test("outside src/agent.ts, the grant client is used only for dry quotes", () => {
  const uses = sources.filter((s) => s.path !== "src/agent.ts")
    .flatMap((s) => s.text.split("\n").map((line, i) => ({ at: `${s.path}:${i + 1}`, line })))
    .filter(({ line }) => /\bagent\(\)\./.test(line));
  assert.ok(uses.length > 0, "the quote site moved: update this test");
  for (const { at, line } of uses) assert.match(line, /\.swap\(.*dry: true/, at);
});

test("inside src/agent.ts, money methods are called only from send, which only dispatch can unlock", () => {
  const text = sources.find((s) => s.path === "src/agent.ts")!.text;
  const start = text.indexOf("export async function send(");
  const end = text.indexOf("\n}\n", start);
  const outside = (text.slice(0, start) + text.slice(end)).split("\n").filter((line) => MONEY.test(line) && /\bgrant\./.test(line));
  assert.deepEqual(outside, []);
  // The permit is module-private and passed by dispatch alone.
  assert.equal(text.match(/FIRST_SUBMISSION/g)?.length, 3, "declared, checked in send, passed once by dispatch");
  assert.equal(text.match(/\bsend\([^)]*FIRST_SUBMISSION\)/g)?.length, 1);
  assert.match(text, /const FIRST_SUBMISSION = Symbol\(/);
  assert.doesNotMatch(text, /export\s+(const|let)\s+FIRST_SUBMISSION/);
});
