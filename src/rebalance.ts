import { format } from "./holdings.js";
import type { Strategy } from "./strategy-digest.js";
import { type Leg, rebalance, targets } from "./treasury.js";

// A rebalance only previews; the saved plan executes with `pnpm steward --execute <plan id>`.

let legs: Leg[] = [];
let strategy: Strategy | undefined;
let saved = false;
for await (const event of rebalance()) {
  if (event.type === "plan") {
    ({ legs, strategy } = event);
    const share = targets(strategy);
    console.log(`Book $${event.total.toFixed(2)}:`);
    for (const h of event.book)
      console.log(
        `  ${h.symbol.padEnd(5)} ${format(h.public, h).padStart(20)} public ${format(h.confidential, h).padStart(20)} private  $${h.usd.toFixed(2).padStart(7)}  ${((h.usd / event.total) * 100).toFixed(1)}% → ${((share[h.asset] ?? 0) * 100).toFixed(0)}%`,
      );
    if (legs.length === 0) {
      console.log("Within tolerance; nothing to do.");
      process.exit(0);
    }
    console.log(`Budget remaining: $${event.budget}\n`);
  } else if (event.type === "quote") {
    const leg = legs[event.leg]!;
    console.log(`leg ${event.leg + 1}: ${format(leg.amount, leg.from)} → ${leg.to.symbol} (~$${leg.usd.toFixed(2)})`);
    console.log(
      `  quote ${format(event.amountOut, leg.to)} (floor ${format(event.minAmountOut, leg.to)}), cost ${event.costBps} bps, at worst ${event.worstCostBps} bps`,
    );
    if (event.skipped) console.log(`  skipped: could cost more than ${strategy!.maxCostBps} bps at its floor`);
  } else {
    saved = true;
    console.log(`\nPlan ${event.plan.id}, valid until ${event.plan.expiresAt}.`);
    console.log(`Execute it as previewed: pnpm steward --execute ${event.plan.id}`);
  }
}
if (!saved) console.log("\nEvery leg costs more than it is worth: nothing to execute.");
