import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ago, client, type Overview } from "./lib";
import { ownerName, type Setup, useOwnerAction, useSigner } from "./owner";
import { Badge, Button, Card, ConfirmButton, CopyButton, ErrorBox, Section, Spinner } from "./ui";
import { connect, useWallet } from "./wallet";

/**
 * The agent's live grants. Whoever holds a grant's token can act inside the policy until it expires;
 * revoking stops it at once, short of a freeze, which stops every grant.
 */
export function Grants({ data, setup }: { data: Overview; setup: Setup }) {
  const wallet = useWallet();
  const action = useOwnerAction(setup);
  const { viaDao, canSign, needsWallet, connectedNotOwner } = useSigner(setup);
  const [revoking, setRevoking] = useState<string>();
  const [issuing, setIssuing] = useState(false);
  const live = data.grants.filter((g) => new Date(g.expires_at) > new Date());
  if (live.length === 0) return null;

  const revoke = async (grantId: string) => {
    setRevoking(grantId);
    await action.run({ type: "grant_revoke", grantId });
    setRevoking(undefined);
  };
  const issue = async () => {
    setIssuing(true);
    await action.run({ type: "grant_issue" });
    setIssuing(false);
  };

  return (
    <Section
      title="Grants"
      description={`Each grant lets whoever holds its token act inside the policy until it expires. Revoking one stops it at once; operations it already committed still finish.${viaDao ? " Each revocation is one DAO proposal." : ""}`}
    >
      <Card>
        <ul className="flex flex-col divide-y">
          {live.map((g) => {
            const held = g.grant_id === setup.grant?.id;
            const label = revoking === g.grant_id && action.busy ? <Spinner /> : viaDao ? "Propose to revoke" : needsWallet ? "Connect to revoke" : "Revoke";
            return (
              <li key={g.grant_id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-col gap-1 text-sm">
                  <span className="flex items-center gap-2">
                    {g.label} {held && <Badge tone="info">Current</Badge>}
                  </span>
                  <span className="text-muted-foreground">
                    issued {ago(g.issued_at)} · expires {ago(g.expires_at)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {revoking === g.grant_id && action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
                  {needsWallet ? (
                    <Button size="sm" variant="outline" disabled={wallet.status === "connecting"} onClick={() => connect().catch(() => {})}>
                      {label}
                    </Button>
                  ) : held ? (
                    <ConfirmButton
                      label={label}
                      disabled={action.busy || !canSign}
                      ownerAction
                      title="Revoke the current grant?"
                      description="The agent stops: nothing moves until the owner issues a new grant. Operations it already committed still finish."
                      confirm="Revoke"
                      onConfirm={() => revoke(g.grant_id)}
                    />
                  ) : (
                    <Button size="sm" variant="outline" disabled={action.busy || !canSign} onClick={() => revoke(g.grant_id)}>
                      {label}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm">
          <span className="text-muted-foreground">
            A new grant replaces the current one once the owner signs it. A treasury grant's label carries the strategy in force, so
            signing it approves that strategy for the autopilot.
          </span>
          <div className="flex items-center gap-2">
            {issuing && action.label && <span className="text-muted-foreground">{action.label}</span>}
            <Button size="sm" variant="outline" disabled={action.busy || !canSign || needsWallet} onClick={issue}>
              {issuing && action.busy ? <Spinner /> : viaDao ? "Propose a new grant" : "Issue a new grant"}
            </Button>
          </div>
        </div>
        {connectedNotOwner && (
          <p className="pt-3 text-xs text-muted-foreground">
            Only {ownerName(setup)} can revoke grants. Connect that account, or run <code>pnpm revoke-grant</code> with its key.
          </p>
        )}
        <ErrorBox error={action.error} />
      </Card>
    </Section>
  );
}

/**
 * The mandate's digest and every revision's: sha256 of the policy's canonical JSON (src/mandate.ts),
 * so anyone holding the policy can recompute it and check which mandate each action ran under.
 */
export function Mandate({ digest }: { digest: string | null }) {
  const history = useQuery({ queryKey: ["policyHistory"], queryFn: () => client.policyHistory() });
  return (
    <Section title="Mandate" description="The policy's digest: recompute it from the policy JSON to check what was signed.">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="break-all font-mono text-xs">{digest ?? "No policy applied"}</span>
          {digest && <CopyButton text={digest} />}
        </div>
        {history.data && history.data.length > 0 && (
          <ul className="flex flex-col divide-y border-t pt-3 text-sm">
            {history.data.map((r) => (
              <li key={`${r.revision}-${r.digest}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  Revision {r.revision ?? "–"} · {r.status.toLowerCase()}
                  {r.appliedAt && <span className="text-muted-foreground"> · {ago(r.appliedAt)}</span>}
                </span>
                <span className="font-mono text-xs text-muted-foreground" title={r.digest ?? undefined}>
                  {r.digest ? `${r.digest.slice(0, 19)}…` : "–"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}
