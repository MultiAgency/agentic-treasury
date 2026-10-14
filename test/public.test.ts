import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The signed-out page shows the prototypes and sign-in, and reads nothing: no balances, payments or
 * agents, and no roster or proposals. Pinned at the source, so a fetch added later fails here.
 */
test("the signed-out page reads nothing from the server", () => {
  const source = readFileSync(new URL("../web/src/public.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|gw[<(]|client\.|useQuery/);
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./app/session", "./features/evidence/showcase", "@phosphor-icons/react"]);
});

test("its prototype cards read nothing either, and show requirements and their phases, never the evidence", () => {
  const source = readFileSync(new URL("../web/src/features/evidence/showcase.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|gw[<(]|client\.|useQuery/);
  const start = source.indexOf("export function PrototypeCard(");
  assert.ok(start >= 0, "showcase.tsx no longer defines PrototypeCard: repoint this test");
  const card = source.slice(start);
  assert.doesNotMatch(card, /evidence/);
});
