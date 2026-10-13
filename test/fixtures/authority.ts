import { grantCommitment, type Policy } from "@near-intents-agent-api/sdk";
import { ASSETS } from "../../src/policy.js";
import { loadStrategy } from "../../src/strategy.js";
import { strategyLabelSuffix } from "../../src/strategy-digest.js";
import { mock } from "node:test";
import { api } from "../../src/api.js";

export const fixtureOwner = { type: "near" as const, account_id: "owner.near", public_key: "ed25519:fixture" };
export const fixtureWallet = { wallet_id: "wallet-fixture", near_account_id: "wallet.near" };
export function fixtureGrant(label = `treasury:${strategyLabelSuffix(loadStrategy())}`) {
  const expires = Date.now() + 86_400_000;
  return { grant_id: "fixture-grant", agent_id: process.env.AGENT_ID!, wallet_id: fixtureWallet.wallet_id, label,
    issued_at: new Date().toISOString(), expires_at: new Date(expires).toISOString(), revoked_at: null, revoked_reason: null, owner_epoch: 1,
    owner_message: { domain: "near-intents-agent-api.agent-grant.v6" as const, owner: fixtureOwner, tenant_id: "fixture",
      agent_id: process.env.AGENT_ID!, wallet_id: fixtureWallet.wallet_id, label, credential: grantCommitment(process.env.AGENT_GRANT_TOKEN!),
      network: "mainnet" as const, issued_at_ms: Date.now(), expires_at_ms: expires, owner_epoch: 1, nonce: "fixture", recipient: "fixture" } };
}
export function authorityFixture(purpose: "treasury" | "payout" = "payout") {
  return {
    getAgent: async () => ({ id: process.env.AGENT_ID!, status: "ACTIVE", archived: false, deleted: false, owner: fixtureOwner, wallet: fixtureWallet }),
    getWallet: async () => fixtureWallet,
    listGrants: async () => [fixtureGrant(purpose === "payout" ? "payout" : undefined)],
    getHistory: async () => ({ data: [], next_cursor: null }),
    getTokens: async () => timedPrices([{ asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 }]),
    getBalances: async (_id: string, { source }: { source: string }) => balanceView(source,
      [{ asset_id: ASSETS.USDC, balance_raw: "1000000000" }]),
  };
}
export const balanceView = <T>(source: string, balances: T[]) => ({ near_account_id: fixtureWallet.near_account_id, source, balances });
export const timedPrices = <T>(tokens: T[]) => tokens.map((t) => ({ ...t,
  price_updated_at: new Date().toISOString(), price_expires_at: new Date(Date.now() + 600_000).toISOString() }));
/** The provider reports a policy budget in its own format: "25" as "25.00". */
const usd = (value: string | null) => value === null ? null : Number(value).toFixed(2);
export function policyView(policy: Policy, revision = 1) {
  const budget = Object.fromEntries((["daily", "weekly", "monthly"] as const).map((w) => [w,
    { limit_usd: usd(policy.budget[`${w}_usd`]), spent_usd: "0", remaining_usd: usd(policy.budget[`${w}_usd`]), resets_at: null }]));
  return { policy, revision, wallet_id: fixtureWallet.wallet_id, status: "APPLIED", provider_policy_synced: true,
    usage: { budget, timelock: { delay_ms: 0, scheduled_count: 0 } } };
}

/** Enrich older offline book fixtures with explicit provider identity and freshness evidence. */
export function completeExecutionEvidence({ grants = false } = {}) {
  const fixture = authorityFixture("treasury");
  mock.method(api, "getAgent", fixture.getAgent);
  mock.method(api, "getWallet", fixture.getWallet);
  mock.method(api, "getHistory", fixture.getHistory);
  const policy = api.getPolicy, tokens = api.getTokens, balances = api.getBalances, list = api.listGrants;
  mock.method(api, "getPolicy", async (...args: Parameters<typeof api.getPolicy>) => {
    const value = await policy(...args);
    return { ...value, ...policyView(value.policy!, value.revision ?? 1) };
  });
  mock.method(api, "getTokens", async () => timedPrices(await tokens()));
  mock.method(api, "getBalances", async (...args: Parameters<typeof api.getBalances>) => balanceView(args[1]?.source ?? "public", (await balances(...args)).balances));
  mock.method(api, "listGrants", async (...args: Parameters<typeof api.listGrants>) => grants
    ? (await list(...args)).map((g) => ({ ...fixtureGrant(g.label), ...g, owner_message: { ...fixtureGrant(g.label).owner_message, ...g.owner_message } }))
    : [fixtureGrant()]);
}
