/** Public workflow descriptions; never contains agent identities or execution state. */
export const walkthroughs = [
  { id: "treasury", area: "treasury", title: "Treasury", summary: "Preview a rebalance, confirm its swaps, then inspect the exact operations.", steps: ["Check policy, strategy, grant and funds", "Preview and explicitly confirm", "Follow the selected plan’s operations"], app: "https://treasury.multiagency.ai" },
  { id: "payables", area: "payables", title: "Confidential payables", summary: "Review an agreement and invoice, request a payment, then follow owner approval and its outcome.", steps: ["Review the agreed payee and invoice terms", "Confirm the payment request", "Follow owner approval and the exact payment"], app: "https://payables.multiagency.ai" },
  { id: "invoices", area: "payables", title: "Purchase orders and invoices", summary: "Create an isolated work order, authorize its agent, and track the supplier’s fixed invoice.", steps: ["Save fixed terms for one supplier", "Approve the separate agent’s policy and grant", "Fund, share the supplier link and track that order"], app: "https://payables.multiagency.ai", limitation: "Work orders are offline-tested, not mainnet-observed. Supplier conversion and forwarding are not implemented." },
] as const;
export type WalkthroughId = typeof walkthroughs[number]["id"];
export const walkthroughAt = (path: string) => walkthroughs.find(item => `/${item.id}` === path || `/demo/${item.id}` === path);
