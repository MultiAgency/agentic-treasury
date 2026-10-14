import { EventType, type CustomEvent, type RunStartedEvent, type RunFinishedEvent } from "@ag-ui/core";

export type DemoKind = "facilitator" | "treasury";
export type DemoScenario = "standard" | "reserve" | "refusal";
export type DemoState = {
  stage: number;
  title: string;
  detail: string;
  tone: "neutral" | "held" | "success" | "refusal";
  approval?: boolean;
  invoice?: { payee: string; work: string; terms: string; status: "prepared" | "held" | "approved" | "paid" | "refused" };
  allocation?: { assets: string[]; before: number[]; target: number[]; result?: number[]; plan: string };
};
export type DemoEvent = RunStartedEvent | RunFinishedEvent | (CustomEvent & { name: "treasury.demo.state"; value: DemoState });

/** Authored illustrations, never recordings or inputs to the executor. No actual identities or timing. */
export function demoEvents(kind: DemoKind, scenario: DemoScenario, permission = true, work = "One completed design milestone"): DemoEvent[] {
  const refused = scenario === "refusal" || !permission;
  const runId = `simulation:${kind}:${scenario}:${refused ? "absent" : "active"}`;
  const allocation = {
    assets: ["Stablecoins", "Asset A", "Asset B"], before: [80, 10, 10],
    target: scenario === "reserve" ? [70, 15, 15] : [40, 30, 30],
    plan: scenario === "reserve" ? "Shift 10 percentage points from stablecoins: 5 to Asset A and 5 to Asset B." : "Shift 40 percentage points from stablecoins: 20 to Asset A and 20 to Asset B.",
  };
  const invoice = { payee: "Example design studio", work, terms: "Owner reviews the agreed milestone before approving this payout." };
  const state = (stage: number, title: string, detail: string, tone: DemoState["tone"] = "neutral", approval = false, status: NonNullable<DemoState["invoice"]>["status"] = "prepared"): DemoEvent => ({
    type: EventType.CUSTOM, name: "treasury.demo.state", value: {
      stage, title, detail, tone, approval,
      ...(kind === "facilitator" ? { invoice: { ...invoice, status } } : { allocation: { ...allocation, ...(tone === "success" ? { result: [...allocation.target] } : {}) } }),
    },
  });
  const start: DemoEvent = { type: EventType.RUN_STARTED, threadId: "public-simulation", runId };
  const end: DemoEvent = { type: EventType.RUN_FINISHED, threadId: "public-simulation", runId };
  const opening = kind === "facilitator"
    ? state(0, "Review the example invoice", "The agreed payee has requested payment for a completed milestone. Continue to see whether the agent can submit the payout.")
    : state(0, "Compare the example allocations", "Choose a strategy to change the target. The current allocation stays the same until the illustrated swaps complete.");
  if (refused) return [start, opening,
    state(1, "Stopped: owner permission absent", "A grant is the owner’s permission for this server to act. Without a live grant for this purpose, authorization refuses the operation. Nothing is sent.", "refusal", false, "refused"), end];
  return kind === "facilitator" ? [start, opening,
    state(1, "Held for owner review", "The grant lets the agent submit a payout; it does not replace the owner’s approval of this held payout. Review the milestone, then simulate approval.", "held", true, "held"),
    state(2, "Owner approval simulated", "The review is complete. In the real workflow, provider evidence of owner approval is checked before signing.", "neutral", false, "approved"),
    state(3, "Example payout completed", "This fictional payout is marked paid. No payment was submitted by this demo.", "success", false, "paid"), end]
    : [start, opening,
      state(1, "Review the proposed swaps", "The plan moves the example allocation toward the selected target. In the real workflow each proposed swap is quoted before execution."),
      state(2, "Authorization checked", "This example assumes the policy is in force, the live grant is bound to the strategy, and the plan fits the auto-execute limit."),
      state(3, "Example rebalance completed", "The fictional swaps completed at the illustrated target. Actual results depend on execution; no swap was submitted by this demo.", "success"), end];
}

/** RUN_FINISHED ends playback; the last state determines success or refusal. */
export function demoState(events: DemoEvent[], index: number): DemoState {
  for (let i = index; i >= 0; i--) {
    const event = events[i];
    if (event?.type === EventType.CUSTOM) return event.value;
  }
  return { stage: 0, title: "Ready to explore", detail: "Advance through the illustrated workflow at your own pace.", tone: "neutral" };
}

/** Protocol lifecycle events remain inspectable, but do not add empty visitor steps. */
export const demoSteps = (events: DemoEvent[]) => events.flatMap((event, index) => event.type === EventType.CUSTOM ? [index] : []);
