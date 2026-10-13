import { CheckCircle, XCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ago, type client, describeRequest, fromUnits, kindOf, type Overview, queries } from "./lib";
import { type Setup, useOwnerAction, useSigner } from "./owner";
import { Badge, Button, Card, ErrorBox, Section, Spinner } from "./ui";
import { useViewer } from "./viewer";

/** How long the API keeps a held payment approvable (the server's APPROVAL_TTL_MS). */
const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;

type Agreement = Awaited<ReturnType<typeof client.agreements.list>>[number];

/**
 * A held payout against its payee's latest agreed terms (src/agreements.ts `withinTerms`): what a
 * voter checks. The terms are this server's record; the vote is what enforces them.
 */
function TermsCheck({ request, agreements }: { request: Record<string, unknown>; agreements: Agreement[] }) {
  const { recipient, amount } = request as { recipient?: string; amount?: string };
  const terms = agreements.filter((a) => a.payee === recipient && a.terms && a.status !== "declined").at(-1)?.terms;
  if (!terms || !amount) return <Badge>No agreed terms on record</Badge>;
  const over = BigInt(amount) > BigInt(terms.maxAmount);
  const late = Date.now() > Date.parse(terms.until);
  if (!over && !late) return <Badge tone="success">Within the agreed terms</Badge>;
  return (
    <Badge tone="warning">
      Outside the agreed terms: {[over && `over ${fromUnits(terms.maxAmount, 6)} USDC`, late && `after ${new Date(terms.until).toLocaleDateString()}`].filter(Boolean).join(", ")}
    </Badge>
  );
}

/** Payments the policy holds for the owner: each one released or rejected by its own vote. */
export function Held({ data, setup }: { data: Overview; setup: Setup }) {
  const held = useQuery(queries.held);
  const action = useOwnerAction(setup);
  const { viaDao, canSign } = useSigner(setup);
  const viewer = useViewer();
  const [voting, setVoting] = useState<string>();
  const facilitator = kindOf(data) === "facilitator";
  // Newest first from the server; oldest first here, so the latest terms come last.
  const agreements = [...(useQuery({ ...queries.agreements, enabled: facilitator }).data ?? [])].reverse();
  if (!held.data?.length) return null;
  // A member who may propose and vote files and approves in one wallet confirmation.
  const oneClick = viewer?.canPropose && viewer.canVote;

  const vote = async (item: (typeof held.data)[number], verdict: "approve" | "reject") => {
    setVoting(item.correlationId);
    await action.run({ type: "approval_vote", approvalId: item.approvalId, verdict, correlationId: item.correlationId });
    setVoting(undefined);
  };

  return (
    <Section
      title="Held payouts"
      description={
        viaDao
          ? oneClick
            ? "Approve files the proposal and your vote in one wallet confirmation."
            : "Approve files one proposal. The API's signing window closes about five minutes later, so vote in Trezu right away."
          : "Each payment waits for your signature."
      }
    >
      <Card>
        <ul className="flex flex-col divide-y">
          {held.data.map((item) => (
            <li key={item.correlationId} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-col gap-1 text-sm">
                <span>{describeRequest(item.request, data.book)}</span>
                <span className="text-muted-foreground">
                  {item.kind} · requested {ago(item.at)} · expires {ago(new Date(Date.parse(item.at) + APPROVAL_WINDOW_MS).toISOString())}
                </span>
                {facilitator && <TermsCheck request={item.request} agreements={agreements} />}
              </div>
              <div className="flex items-center gap-2">
                {voting === item.correlationId && action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
                <Button size="sm" disabled={action.busy || !canSign} onClick={() => vote(item, "approve")}>
                  {voting === item.correlationId && action.busy ? <Spinner /> : <CheckCircle size={16} />} Approve
                </Button>
                <Button size="sm" variant="outline" disabled={action.busy || !canSign} onClick={() => vote(item, "reject")}>
                  <XCircle size={16} /> Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <ErrorBox error={action.error} />
      </Card>
    </Section>
  );
}
