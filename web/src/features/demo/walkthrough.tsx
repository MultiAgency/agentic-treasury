import { useAgent } from "../../app/agent-context";
import { kindOf } from "../../shared/lib";
import { SigningWalkthrough } from "./signing-walkthrough";
import { Guidance } from "./guidance";
import type { WalkthroughId } from "./catalog";
import { Link } from "@tanstack/react-router";

/** Both lengths retain the same action components, confirmations and exact-record tracking. */
export function Walkthrough({ workflow, short = false }: { workflow: WalkthroughId; short?: boolean }) {
  const { data } = useAgent();
  const matches = (kindOf(data) === "treasury") === (workflow === "treasury");
  if (!matches) return <p>This walkthrough needs a different agent. <a href="/demos" className="underline">Choose an available agent</a>.</p>;
  return <>
    <nav aria-label="Walkthrough versions" className="flex flex-wrap gap-5 text-sm">
      {workflow === "payables" && <Link to="/demos/payables/play" className="underline">Play the Payables demo</Link>}
      <a href="/demos" className="underline">All short demos</a>
      <a href={`/${workflow}`} className="underline">Complete walkthrough</a>
    </nav>
    {workflow === "invoices" ? <>
      <h2 className="text-xl font-semibold">Purchase-order walkthrough</h2>
      <p className="text-sm">Save fixed terms, authorize the isolated agent, fund it, and share its supplier link. Review owner approval and the payment recorded on that exact order.</p>
      <p className="text-sm text-muted-foreground">Offline-tested only. Supplier conversion and forwarding are not implemented. An accepted payment can finish after grant expiry; expiry does not return funds.</p>
      {short && <Guidance agentId={data.agentId} workflow="invoices" />}
    </> : null}
    <SigningWalkthrough workflow={workflow} short={short} />
  </>;
}
