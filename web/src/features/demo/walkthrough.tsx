import { useAgent } from "../../app/agent-context";
import { kindOf } from "../../shared/lib";
import { WorkOrders } from "../payables/work-orders";
import { LiveDemo } from "./live-demo";
import { Guidance } from "./guidance";
import type { WalkthroughId } from "./catalog";

/** Both lengths retain the same action components, confirmations and exact-record tracking. */
export function Walkthrough({ workflow, short = false }: { workflow: WalkthroughId; short?: boolean }) {
  const { data } = useAgent();
  const matches = (kindOf(data) === "treasury") === (workflow === "treasury");
  if (!matches) return <p>This walkthrough needs a different agent. <a href="/demos" className="underline">Choose an available agent</a>.</p>;
  return <>
    <nav aria-label="Walkthrough versions" className="flex flex-wrap gap-5 text-sm">
      <a href="/demos" className="underline">All short demos</a>
      <a href={`/${workflow}`} className="underline">Complete walkthrough</a>
    </nav>
    {workflow === "invoices" ? <>
      <h2 className="text-xl font-semibold">Purchase-order walkthrough</h2>
      <p className="text-sm">Save fixed terms, authorize the isolated agent, fund it, and share its supplier link. Review owner approval and the payment recorded on that exact order.</p>
      <p className="text-sm text-muted-foreground">Offline-tested only. Supplier conversion and forwarding are not implemented. An accepted payment can finish after grant expiry; expiry does not return funds.</p>
      {short ? <Guidance agentId={data.agentId} workflow="invoices" /> : <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>Choose one supplier, a fixed amount and a deadline. Saving terms does not authorize payment.</li>
        <li>Open the saved order. Review and sign its separate agent policy, then its expiring grant.</li>
        <li>Fund that agent and share the supplier link shown on the order.</li>
        <li>Review the supplier’s invoice and the owner approval. Track the order’s retained payment identity; approval is not settlement.</li>
      </ol>}
      <WorkOrders />
    </> : <LiveDemo short={short} expanded={!short} />}
  </>;
}
