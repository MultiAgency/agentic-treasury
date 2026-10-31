import type { OwnerOutput } from "@multiagency/sdk";
import type { Machine } from "./machine.ts";
import { follow, type Outcome } from "./outcome.ts";

/** The agent's proposal. Each saves a plan for the owner to approve and moves no funds. */
export type Proposal = { outcome: Outcome; planId: string | null };

/** Quotes the legs toward the owner's saved allocation targets and saves them as a plan. */
export async function rebalance(propose: Machine<"prepare">, onEvent: (event: OwnerOutput<"rebalance">) => void): Promise<Proposal> {
  let planId: string | null = null;
  const outcome = await follow(propose.stream("rebalance", undefined), event => {
    if (event.type === "saved") planId = event.plan.id;
    onEvent(event);
  }, { procedure: "rebalance", identity: {} });
  return { outcome, planId };
}

/** Quotes one chosen swap (atomic amount of `from`) and saves it as a plan. */
export async function swap(propose: Machine<"prepare">, from: string, to: string, amount: string): Promise<Proposal & { plan?: OwnerOutput<"externalPlan"> }> {
  const saved = await propose.call("externalPlan", { swaps: [{ from, to, amount }] });
  return saved.ok ? { outcome: { ok: true }, planId: saved.value.id, plan: saved.value } : { outcome: saved, planId: null };
}
