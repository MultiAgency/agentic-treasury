import type { OwnerOutput } from "@multiagency/sdk";
import type { Machine } from "./machine.ts";
import { follow, settle, type Leg, type Outcome } from "./outcome.ts";

/**
 * The owner's approval, each under its own credential. The executor claims a saved plan at most once; a sweep is a
 * fresh action per call. Neither is ever sent again after an unknown or partial outcome.
 */
export async function execute(approve: Machine<"execute-plan">, planId: string, onEvent: (event: OwnerOutput<"executePlan">) => void): Promise<Outcome> {
  const legs: Leg[] = [];
  let rejected: string[] | null = null;
  const ended = await follow(approve.stream("executePlan", { planId }), event => {
    if (event.type === "rejected") rejected = event.problems;
    else legs.push({ index: event.index, status: event.status, correlationId: event.correlationId, failureCode: event.failureCode, ...(event.shield && { shield: event.shield }) });
    onEvent(event);
  });
  return settle(ended, legs, rejected, { procedure: "executePlan", identity: { planId } });
}

/** Previews (`execute: false`) or shields the agent's managed public balances. */
export async function sweep(sweeper: Machine<"sweep">, execute: boolean, onEvent: (event: OwnerOutput<"sweep">) => void): Promise<Outcome> {
  const legs: Leg[] = [];
  const ended = await follow(sweeper.stream("sweep", { execute }), event => {
    if (event.type === "shield") legs.push({ asset: event.asset, status: event.status, correlationId: event.correlationId, failureCode: event.failureCode });
    onEvent(event);
  });
  return settle(ended, legs, null, { procedure: "sweep", identity: { execute } });
}
