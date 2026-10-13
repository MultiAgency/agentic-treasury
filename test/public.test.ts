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
  assert.deepEqual(imports.sort(), ["./session", "./showcase", "@phosphor-icons/react"]);
});

test("its prototype cards read nothing either, and show claims and how each is known, never their evidence", () => {
  const source = readFileSync(new URL("../web/src/showcase.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|gw[<(]|client\.|useQuery/);
  const card = source.slice(source.indexOf("export function PrototypeCard"));
  assert.doesNotMatch(card, /evidence/);
});
