import { Details } from "../../shared/ui";
import { receipts, type ReceiptWorkflow } from "../../../../evidence/receipts";
import { SourceLabel } from "./source-label";

/**
 * The apps' simulated workflow receipts behind a catalog workflow: sanitized copies pinned by sha256 in Proto's evidence
 * inventory (evidence/receipts.ts), served with this page. Simulated provider, chain, signatures and settlement.
 */
export function RecordedSimulations({ workflows }: { workflows: ReceiptWorkflow[] }) {
  const entries = receipts.filter(entry => workflows.includes(entry.workflow));
  if (!entries.length) return null;
  return <div className="flex flex-col gap-3 text-sm">
    <h3 className="font-medium">Recorded simulations</h3>
    <ul className="flex flex-col gap-3">{entries.map(entry => <li key={entry.id} className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2"><SourceLabel source="Recorded simulation" /><span>{entry.title}</span></span>
      <span className="text-muted-foreground">Recorded {entry.recordedAt.replace("T", " ").slice(0, 16)} UTC · simulated provider, chain, signatures and settlement; no real funds.</span>
      {entry.note && <span className="text-muted-foreground">{entry.note}</span>}
      <Details summary="Recorded steps and digests">
        <ol className="list-decimal space-y-1 pl-5">{entry.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
        <p className="break-all text-xs text-muted-foreground">Proto snapshot {entry.snapshot} · source receipt sha256 {entry.source.sha256} ({entry.source.app}) · copy sha256 {entry.copySha256}</p>
      </Details>
    </li>)}</ul>
  </div>;
}
