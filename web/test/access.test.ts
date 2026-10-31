import { test } from "node:test";
import assert from "node:assert/strict";
import { accessState, deniedAt, settleDenials } from "../src/app/access.ts";
import { agent } from "../src/platform.ts";

/** A gateway denial of `scope` on an agent, as the platform module reports it. */
async function denied(name: string, access: "session" | "agent") {
  Object.assign(globalThis, { location: new URL("https://treasury.test/") });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: `${access} denied`, access }, { status: 403 });
  try { await agent(name).read("overview", undefined).catch(() => {}); } finally { globalThis.fetch = realFetch; }
}

test("a refreshed session lifts the denials it answers, including after another account signs in", async () => {
  await denied("portfolio", "agent");
  await denied("other", "agent");
  assert.ok(deniedAt(accessState(), "portfolio"));

  // Another account signs in and may see portfolio, but not other: portfolio's records return, other's stay hidden.
  settleDenials({ access: { portfolio: {} } });
  assert.equal(deniedAt(accessState(), "portfolio"), undefined);
  assert.ok(deniedAt(accessState(), "other"));

  // A session denial hides everything until a session read succeeds.
  await denied("portfolio", "session");
  assert.ok(deniedAt(accessState(), "portfolio"));
  settleDenials({ access: { portfolio: {} } });
  assert.equal(deniedAt(accessState(), "portfolio"), undefined);
  assert.ok(deniedAt(accessState(), "other"));

  // Signed out, nothing stays latched for the next sign-in.
  settleDenials(null);
  assert.deepEqual(accessState(), { agents: {} });
});
