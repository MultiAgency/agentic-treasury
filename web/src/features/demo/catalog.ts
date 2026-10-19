/** Public workflow descriptions; never contains agent identities or execution state. Each maps to one original experiment. */
export const walkthroughs = [
  { id: "payables", area: "payables", title: "Confidential payables",
    summary: "A payment request is reviewed, waits for the owner's required approval, then pays confidentially.",
    steps: ["The payee requests payment under agreed terms", "The owner reviews the exact request and the policy it falls under", "The owner's required approval releases the held payout", "The confidential payment is recorded; approval alone is not settlement"],
    limitation: "DAO quorum approval is not demonstrated: approval comes from a wallet owner. A Sputnik DAO's member roster is public on chain, so membership is not secret.",
    app: "https://payables.multiagency.ai" },
  { id: "treasury", area: "treasury", title: "Treasury",
    summary: "Balances are read, a plan is quoted, and only an explicitly authorized plan executes, within budget, with recorded outcomes.",
    steps: ["Read balances and the saved strategy", "Quote a plan and review it", "Authorize and execute that exact plan", "Check the budget and each recorded outcome"],
    limitation: "Allocation rebalancing and schedule acceptance are open. Exact payout unshielding is a gap. Spending caps do not bound total exposure, and budgets are not atomic. A balance change is not profit and loss.",
    app: "https://treasury.multiagency.ai" },
  { id: "invoices", area: "payables", title: "Purchase orders and invoices",
    summary: "A fixed purchase order gets its own authorized, funded agent; the contributor's invoice is paid only after the owner approves the held payout.",
    steps: ["Fix one purchase order's terms", "Authorize and fund its isolated agent", "The contributor files the order's invoice", "The owner approves the held payout", "Settlement is recorded separately"],
    variation: { title: "Recurring builder agreement", summary: "One agreement fixes the period, scope and cap; each report is reviewed and paid against it.",
      steps: ["Agree the period, scope and cap once", "The builder submits a report", "The owner reviews it and approves an explicit amount", "Payment: an isolated order by default, or the shared payout by the owner's choice"] },
    limitation: "Receipt conversion and forwarding are not implemented. Grant expiry neither returns residual funds nor undoes accepted work.",
    app: "https://payables.multiagency.ai" },
] as const;
export type WalkthroughId = typeof walkthroughs[number]["id"];
export const walkthroughAt = (path: string) => walkthroughs.find(item => `/${item.id}` === path || `/demo/${item.id}` === path);

/** What a demo surface shows: fixture data, a past recording, or the signed-in owner's real records. */
export type SurfaceSource = "Fictional rehearsal" | "Recorded simulation" | "Live";
