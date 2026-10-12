import assert from "node:assert/strict";
import { test } from "node:test";
import { mayCall } from "../src/gateway/allowlist.js";
import { accessOf } from "../src/gateway/roles.js";
import { router } from "../src/router.js";

/**
 * A plain member (in a DAO group, not an operator) against every procedure the agent server really
 * has, so a procedure added later is checked too. Fixture roles only: no DAO membership changes.
 */

/** Every procedure's gateway path (`owner/prepare`), read from the router itself. */
function paths(node: object, prefix = ""): string[] {
  return Object.entries(node).flatMap(([name, child]) =>
    "~orpc" in child ? [`${prefix}${name}`] : paths(child as object, `${prefix}${name}/`));
}

/** What members may call: reads, plus filing owner actions as proposals. */
const READS = ["setup", "overview", "policyHistory", "treasury/get", "activity", "unresolved", "held", "autopilot/get",
  "inbox/list", "ledger", "ledgerCsv", "reconcileBooks", "owner/status", "owner/pending"];
/** Member-callable but not read-only: it creates a provider intent and holds it on the server. */
const PROPOSES = ["owner/prepare"];

const policy = {
  proposal_bond: "0",
  roles: [
    { name: "Viewer", kind: { Group: ["viewer.near"] }, permissions: [], vote_policy: {} },
    { name: "Requestor", kind: { Group: ["requestor.near"] }, permissions: ["call:AddProposal", "call:VoteRemove"], vote_policy: {} },
  ],
  default_vote_policy: { threshold: [1, 2] },
};

test("the fixture accounts sign in as plain members, not operators", () => {
  assert.equal(accessOf("viewer.near", policy, ["ops.near"])?.role, "member");
  assert.equal(accessOf("requestor.near", policy, ["ops.near"])?.role, "member");
  assert.equal(accessOf("outsider.near", policy, ["ops.near"]), null);
});

test("a plain member reaches exactly the reads and owner/prepare; every other procedure is operators only", () => {
  const all = paths(router);
  for (const path of [...READS, ...PROPOSES]) assert.ok(all.includes(path), `${path} is not a procedure`);
  const memberCallable = all.filter((path) => mayCall("member", path)).sort();
  assert.deepEqual(memberCallable, [...READS, ...PROPOSES].sort());
  for (const path of all) assert.ok(mayCall("operator", path), path);
});

test("money and settings procedures are refused to members", () => {
  for (const path of ["pay", "sweep", "rebalance", "executePlan", "recover", "autopilot/set", "autopilot/tick",
    "inbox/dismiss", "owner/submit", "treasury/link", "deposit", "steward/propose", "cancelPreparedInvoice", "refusals"])
    assert.ok(!mayCall("member", path), path);
});
