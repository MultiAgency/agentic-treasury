import { CheckCircle, XCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ago, describeRequest, type Overview, queries } from "./lib";
import { type Setup, useOwnerAction, useSigner } from "./owner";
import { Button, Card, ErrorBox, Section, Spinner } from "./ui";
import { useViewer } from "./viewer";

/** How long the API keeps a held payment approvable (the server's APPROVAL_TTL_MS). */
const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;

/** Payments the policy holds for the owner: each one released or rejected by its own vote. */
export function Held({ data, setup }: { data: Overview; setup: Setup }) {
  const held = useQuery(queries.held);
  const action = useOwnerAction(setup);
  const { viaDao, canSign } = useSigner(setup);
  const viewer = useViewer();
  const [voting, setVoting] = useState<string>();
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
            ? "A payment stays approvable for 24 hours. Approve files the proposal and your vote in one wallet confirmation."
            : "A payment stays approvable for 24 hours. Approve files one proposal, and the API's signing window closes about five minutes later, so vote in Trezu right away."
          : "A payment stays approvable for 24 hours and waits for your signature."
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
