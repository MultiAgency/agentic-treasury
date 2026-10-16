import { guidanceEvent } from "../../../../src/demo-guidance";

/** Consumes AG-UI CUSTOM observations; never interprets events as executable instructions. */
export function Guidance(props: Parameters<typeof guidanceEvent>[0]) {
  const event = guidanceEvent(props);
  const { stage, blocker, record } = event.value;
  return <aside aria-label="Walkthrough guidance" className="flex flex-col gap-3 rounded-xl bg-muted p-4 text-sm">
    <h3 className="font-semibold">Your next step</h3>
    <p role="status">{blocker ?? (stage === "follow" ? "Review the exact record below. Submission or owner approval does not prove settlement."
      : props.workflow === "invoices" ? "Select an existing work order or save fixed terms below. Review each owner action before signing."
        : props.workflow === "treasury" ? "Preview the rebalance below. Review the exact swaps before confirming execution."
          : "Review the recipient and amount below. Confirm only the payment you intend to request.")}</p>
    {record && <p className="break-all">Selected {record.kind}: {record.id}</p>}
    <details><summary className="cursor-pointer">About this guidance</summary>
      <p className="mt-2 text-muted-foreground">Deterministic guidance from this page’s observations, carried as an AG-UI event. It is not an autonomous agent run or proof of settlement. Reload clears the local selection; durable records remain in Activity.</p>
    </details>
  </aside>;
}
