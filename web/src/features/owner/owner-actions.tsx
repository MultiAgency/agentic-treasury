import { queries } from "../../shared/queries";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { Card, Loading, QueryError, Section } from "../../shared/ui";

/** Private durable records on this host, not a complete history across owner devices. */
export function OwnerActions() {
  const actions = useQuery({ ...queries.ownerActions, refetchInterval: 5_000, retry: false });
  const hash = useLocation({ select: location => location.hash });
  useEffect(() => {
    if (hash.startsWith("owner-") && actions.data) document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [hash, actions.data]);
  return <Section title="Owner actions" description="Actions recorded on this instance. Owner approval and payment settlement are separate outcomes.">
    {actions.error && <QueryError error={actions.error} retry={() => actions.refetch()} />}
    {actions.isPending && <Loading label="Checking owner actions…" />}
    {actions.isSuccess && !actions.data.length && <p className="text-sm text-muted-foreground">No owner actions are recorded on this instance. Another instance may hold the record.</p>}
    {(!actions.error ? actions.data ?? [] : []).map(a => <Card key={a.correlationId}>
      <div id={`owner-${a.correlationId}`} className="scroll-mt-48">
        <p className="font-medium">{a.type.replaceAll("_", " ")} · {a.signer === "dao" ? "DAO" : "Owner wallet"}</p>
        <p className="text-sm">{a.stage === "submitted" ? "Submission attempted—checking the existing owner action’s outcome. Do not sign again." : a.stage === "prepared" ? "Prepared, with no submission attempt recorded. Review the existing action; its signing window closes " + new Date(a.expiresAt).toLocaleString() + "." : a.stage === "expired" ? "Signing window closed without a recorded submission attempt." : a.ownerSucceeded ? "Owner action succeeded." : `Owner action ended: ${a.status ?? "outcome unavailable"}.`}</p>
        {a.payment && <p className="text-sm">{a.ownerSucceeded ? `${a.payment.verdict === "reject" ? "Rejection" : "Approval"} submitted. ` : ""}<Link to="/follow/payment" search={{ payment: a.payment.correlationId }} className="underline">Follow the payment outcome</Link></p>}
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{a.correlationId}</p>
      </div>
    </Card>)}
  </Section>;
}
