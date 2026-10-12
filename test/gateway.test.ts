import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKey, Near, type PrivateKey } from "near-kit";
import { mayCall } from "../src/gateway/allowlist.js";
import { childEnv, hostOf, loadConfig } from "../src/gateway/config.js";
import { CHALLENGE_TTL_MS, issueChallenge, type KeyLookup, SESSION_TTL_MS, sessionAccount, sessions, sessionToken, verifySignIn } from "../src/signin.js";
import { accessOf } from "../src/gateway/roles.js";

const HOST = "dao.test";

/** Signs a challenge the way a wallet does (near-kit's NEP-413 signer), for `account`. */
async function signIn(account = "alice.near", host = HOST, callbackUrl?: string) {
  const key = generateKey();
  const challenge = issueChallenge(HOST);
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: account });
  const signed = await near.signMessage({ message: challenge.message, recipient: host, nonce: Buffer.from(challenge.nonce, "base64"), callbackUrl });
  return { accountId: account, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce, callbackUrl };
}
const fullAccess: KeyLookup = async () => "FullAccess";

test("a wallet's signature over a fresh challenge signs the account in", async () => {
  assert.equal(await verifySignIn(await signIn(), HOST, fullAccess), "alice.near");
});

test("a wallet that signs a callback URL on this site signs in; one elsewhere is refused", async () => {
  assert.equal(await verifySignIn(await signIn("alice.near", HOST, `https://${HOST}/`), HOST, fullAccess), "alice.near");
  await assert.rejects(verifySignIn(await signIn("alice.near", HOST, "https://evil.test/"), HOST, fullAccess), /callback URL is not this site/);
  // A wallet that fills in the callback itself: the page offers what it might be, and one matches.
  const unreported = await signIn("alice.near", HOST, `https://${HOST}/a/treasury/`);
  assert.equal(
    await verifySignIn({ ...unreported, callbackUrl: undefined, callbackUrls: [`https://${HOST}/`, `https://${HOST}/a/treasury/`] }, HOST, fullAccess),
    "alice.near",
  );
  // The callback is part of what was signed: dropping or changing it breaks the signature.
  const signed = await signIn("alice.near", HOST, `https://${HOST}/`);
  await assert.rejects(verifySignIn({ ...signed, callbackUrl: null }, HOST, fullAccess), /doesn't match/);
});

test("a challenge signs in once", async () => {
  const attempt = await signIn();
  await verifySignIn(attempt, HOST, fullAccess);
  await assert.rejects(verifySignIn(attempt, HOST, fullAccess), /Unknown or used/);
});

test("an expired challenge is refused", async () => {
  await assert.rejects(verifySignIn(await signIn(), HOST, fullAccess, Date.now() + CHALLENGE_TTL_MS + 1), /expired/);
});

test("a signature for another site is refused", async () => {
  await assert.rejects(verifySignIn(await signIn("alice.near", "evil.test"), HOST, fullAccess), /doesn't match/);
});

test("a signature can't be moved to another account or key", async () => {
  const attempt = await signIn();
  const other = await signIn();
  await assert.rejects(verifySignIn({ ...attempt, publicKey: other.publicKey }, HOST, fullAccess), /doesn't match/);
});

test("the key must be a full-access key of the claimed account", async () => {
  await assert.rejects(verifySignIn(await signIn("bob.near"), HOST, async () => null), /is not a key of bob\.near/);
  await assert.rejects(verifySignIn(await signIn(), HOST, async () => "FunctionCall"), /full-access/);
});

test("a session names its account until it expires, and can't be forged or altered", () => {
  const token = sessionToken("alice.near", "secret");
  assert.equal(sessionAccount(token, "secret"), "alice.near");
  assert.equal(sessionAccount(token, "other secret"), null);
  const [, expires, mac] = token.split(".");
  assert.equal(sessionAccount(`${Buffer.from("bob.near").toString("base64url")}.${expires}.${mac}`, "secret"), null);
  assert.equal(sessionAccount(token, "secret", Date.now() + SESSION_TTL_MS + 1), null);
  assert.equal(sessionAccount(undefined, "secret"), null);
});

test("an app's session cookie is read back only under its own name", () => {
  const dao = sessions({ cookie: "dao_session", secret: "secret", secure: true });
  const opened = dao.open("alice.near");
  assert.match(opened, /^dao_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const request = (cookie: string) => ({ headers: { cookie } }) as never;
  const pair = opened.split(";")[0]!;
  assert.equal(dao.account(request(`theme=dark; ${pair}`)), "alice.near");
  assert.equal(sessions({ cookie: "invoices_session", secret: "secret", secure: false }).account(request(pair)), null);
  assert.equal(dao.account({ headers: {} } as never), null);
  assert.equal(dao.close(), "dao_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
  assert.doesNotMatch(sessions({ cookie: "c", secret: "s", secure: false }).close(), /Secure/);
});

const policy = {
  proposal_bond: "0",
  roles: [
    { name: "council", kind: { Group: ["alice.near", "carol.near"] }, permissions: ["*:AddProposal", "*:VoteApprove"], vote_policy: {} },
    { name: "requestors", kind: { Group: ["dave.near"] }, permissions: ["call:AddProposal"], vote_policy: {} },
    { name: "all", kind: "Everyone", permissions: ["*:Finalize"], vote_policy: {} },
  ],
  default_vote_policy: { threshold: [1, 2] },
};

test("members come from the DAO's groups, operators from the configuration, everyone else is refused", () => {
  assert.deepEqual(accessOf("alice.near", policy, []), { role: "member", canPropose: true, canVote: true });
  assert.deepEqual(accessOf("dave.near", policy, []), { role: "member", canPropose: true, canVote: false });
  assert.deepEqual(accessOf("ops.near", policy, ["ops.near"]), { role: "operator", canPropose: false, canVote: false });
  assert.equal(accessOf("mallory.near", policy, []), null);
});

test("members read and file proposals; money and settings are for operators", () => {
  for (const path of ["overview", "activity", "held", "ledgerCsv", "owner/pending", "owner/prepare"]) assert.ok(mayCall("member", path), path);
  for (const path of ["pay", "sweep", "steward/execute", "autopilot/set", "autopilot/tick", "recover", "treasury/link", "owner/submit", "someFutureProcedure"])
    assert.ok(!mayCall("member", path), path);
  assert.ok(mayCall("operator", "pay"));
});

test("an approve-only agent server starts with EXECUTOR=off; gateway secrets never reach agent servers", () => {
  const parent = { SESSION_SECRET: "s".repeat(40), DASHBOARD_HOST: "x.test", DASHBOARD_FILE: "d.json", EXECUTOR: "off", NEAR_INTENTS_AGENT_API_KEY: "naa_k" };
  const executor = childEnv({ name: "treasury", envFile: ".env.dao", port: 8789, executor: true }, parent);
  assert.deepEqual(
    { ...executor },
    { NEAR_INTENTS_AGENT_API_KEY: "naa_k", ENV_FILE: ".env.dao", PORT: "8789" },
    "the executor: shared keys, its own file and port, no EXECUTOR=off inherited",
  );
  const approver = childEnv({ name: "payout", envFile: ".env.payout", port: 8790, executor: false }, parent);
  assert.equal(approver.EXECUTOR, "off");
  assert.equal(approver.SESSION_SECRET, undefined);
});

test("the deployed configuration runs the treasury agent here and the payout agent approve-only", () => {
  const config = loadConfig("deploy/dashboard.json");
  assert.equal(config.host, "proto.multiagency.ai");
  assert.deepEqual(
    config.agents.map((a) => [a.name, a.envFile, a.executor]),
    [
      ["treasury", ".env.dao", true],
      ["payout", ".env.payout", false],
    ],
  );
});

test("a sign-in host may be given bare or as a URL", () => {
  for (const value of ["dao.example.com", "https://dao.example.com", "https://dao.example.com/", "dao.example.com/"]) assert.equal(hostOf(value), "dao.example.com");
  assert.equal(hostOf("http://localhost:8800"), "localhost:8800");
});
