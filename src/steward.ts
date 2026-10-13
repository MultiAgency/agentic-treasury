import { format } from "./holdings.js";
import { steward } from "./llm.js";
import { executePlan, type PlannedAction } from "./plans.js";

const describe = (a: PlannedAction) =>
  a.type === "swap"
    ? `swap ${a.amount} ${a.from} → ${a.to}, floor ${a.minAmountOut} (${a.costBps} bps)`
    : `shield ${format(a.amount, { decimals: 6, symbol: "USDC" })}`;

// `pnpm steward ["instruction"]` proposes a plan; `pnpm steward --execute <plan id>` executes it as proposed.
const args = process.argv.slice(2);
const planId = args.includes("--execute") ? args[args.indexOf("--execute") + 1] : undefined;

if (planId) {
  for await (const event of executePlan(planId)) {
    if (event.type === "rejected") console.log(`Not executed. Preview again:\n- ${event.problems.join("\n- ")}`);
    else {
      if (event.shield) console.log(`step ${event.index + 1}: shield ${event.shield.amount} first → ${event.shield.status}`);
      console.log(`step ${event.index + 1}: ${describe(event.action)} → ${event.status} ${event.correlationId} ${event.failureCode ?? ""}`);
    }
  }
} else {
  let planned = false;
  for await (const event of steward({ instruction: args.find((arg) => !arg.startsWith("--")) })) {
    if (event.type === "say") console.log(`\n${event.text}`);
    else if (event.type === "call") console.log(`\n→ ${event.name} ${JSON.stringify(event.input)}`);
    else if (event.type === "result") console.log(`  ${event.result}`);
    else if (event.type === "verified") console.log(`  [verified ${event.signatureKind} signature on ${event.completionId}]`);
    else {
      planned = true;
      console.log(`\nPlan ${event.plan.id}, valid until ${event.plan.expiresAt}:`);
      for (const [i, action] of event.plan.actions.entries()) console.log(`  ${i + 1}. ${describe(action)}`);
      console.log(`\nExecute it as proposed: pnpm steward --execute ${event.plan.id}`);
    }
  }
  // Whatever the model said, only proposals its tools recorded become a plan.
  if (!planned) console.log("\nNo plan: nothing was proposed, so there is nothing to execute.");
}
