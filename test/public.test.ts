import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { DaoPolicy } from "../src/chain.js";
import type { DaoProposal } from "../src/gateway/proposals.js";
import { publicView } from "../src/gateway/public.js";

const DAO = "agentic.sputnik-dao.near";
const sign = (path: string, hash: string) => ({
  FunctionCall: {
    receiver_id: "v1.signer",
    actions: [{ method_name: "sign", args: Buffer.from(JSON.stringify({ request: { path, payload_v2: { Eddsa: hash }, domain_id: 1 } })).toString("base64") }],
  },
});
const proposal = (id: number, kind: DaoProposal["kind"], description = ""): DaoProposal => ({
  id,
  proposer: "multiagentic.near",
  description,
  status: "Approved",
  submission_time: "1760284800000000000",
  votes: { "multiagentic.near": "Approve" },
  kind,
});
const policy: DaoPolicy = {
  proposal_bond: "0",
  roles: [
    { name: "all", kind: "Everyone", permissions: [], vote_policy: {} },
    { name: "Approver", kind: { Group: ["multiagentic.near"] }, permissions: ["*:VoteApprove"], vote_policy: {} },
  ],
  default_vote_policy: { threshold: [1, 2] },
};

test("the public view names each proposal's kind from its on-chain arguments, newest first", () => {
  const view = publicView(DAO, policy, [
    proposal(1, sign("agent-owner", "aa")),
    proposal(2, sign(DAO, "bb"), "* Proposal Action: confidential"),
    proposal(3, { Transfer: { token_id: "", receiver_id: "x.near", amount: "1" } }),
    proposal(4, { ChangePolicy: { policy: {} } }),
    proposal(5, { FunctionCall: { receiver_id: "intents.near", actions: [] } }),
  ]);
  assert.deepEqual(
    view.proposals.map((p) => [p.id, p.action, p.hash]),
    [
      [5, "Call to intents.near", null],
      [4, "Policy change", null],
      [3, "Transfer", null],
      [2, "Confidential payment (Trezu)", "bb"],
      [1, "Signature as the agents' owner", "aa"],
    ],
  );
  assert.equal(view.proposals[0]!.submittedAt, "2025-10-12T16:00:00.000Z");
  assert.deepEqual(view.roles, [{ name: "Approver", members: ["multiagentic.near"] }]);
});

test("the public view is read from chain only: it never calls an agent server", () => {
  const source = readFileSync(new URL("../src/gateway/public.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /127\.0\.0\.1|localhost|\/rpc\/|fetch\(/);
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["near-kit", "../chain.js", "./proposals.js"]);
});
