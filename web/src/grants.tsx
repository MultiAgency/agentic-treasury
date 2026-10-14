import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ago, client, swaps, type Overview } from "./lib";
import { ownerName, type Setup, useOwnerAction, useSigner, WalletButton } from "./owner";
import { Badge, Button, Card, ConfirmButton, CopyButton, Details, ErrorBox, Section, Spinner } from "./ui";
import { connect, useWallet } from "./wallet";

/**
 * The agent's grants, including ended access. A live grant's token permits acting inside the policy;
 * revoking stops it at once, short of a freeze, which stops every grant.
 */
export function Grants({ data, setup }: { data: Overview; setup: Setup }) {
  const wallet = useWallet();
  const action = useOwnerAction(setup);
  const { viaDao, canSign, needsWallet, connectedNotOwner } = useSigner(setup);
  const [revoking, setRevoking] = useState<string>();
  const [issuing, setIssuing] = useState(false);
  const now = Date.now();
  const live = data.grants.filter((g) => !g.revoked_at && Date.parse(g.expires_at) > now);
  const history = <ul className="flex flex-col divide-y">
    {data.grants.map((g) => {
      const active = !g.revoked_at && Date.parse(g.expires_at) > now;
      return <li key={g.grant_id} className="flex flex-col gap-1 py-3 text-sm first:pt-0 last:pb-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-all">{g.label}</span>
          <Badge tone={active ? "info" : "neutral"}>{g.revoked_at ? "Revoked" : active ? "Live" : "Expired"}</Badge>
          {active && g.grant_id === setup.grant?.id && <Badge tone="info">Current</Badge>}
        </span>
        <span className="text-muted-foreground">
          issued {ago(g.issued_at)} · {g.revoked_at ? <>revoked <time dateTime={g.revoked_at}>{g.revoked_at}</time></>
            : active ? <>expires {ago(g.expires_at)}</> : <>expired <time dateTime={g.expires_at}>{g.expires_at}</time></>}
        </span>
      </li>;
    })}
  </ul>;

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

  const issueButton = swaps(data) ? <Link id="grants" to="/automations" className="text-sm underline">Review and authorize the Treasury strategy</Link> : (
    <div className="scroll-mt-48 flex flex-wrap items-center gap-2" id="grants">
      {(needsWallet || connectedNotOwner) && <><WalletButton /><span className="text-sm">Connect {ownerName(setup)} to issue a grant.</span></>}
      {issuing && action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
      <Button size="sm" variant="outline" disabled={action.busy || !canSign || needsWallet} onClick={issue}>
        {issuing && action.busy ? <Spinner /> : viaDao ? "Propose a new grant" : "Issue a new grant"}
      </Button>
    </div>
  );
  // With no live grant the agent can't act at all: issuing one is the whole page, not a fold.
  if (live.length === 0)
    return (
      <Section title="Grants" description="No live grant: the agent can't send until the owner issues one.">
        <Card>
          {history}
          {issueButton}
          <ErrorBox error={action.error} />
        </Card>
      </Section>
    );

  const revokeButton = (g: (typeof live)[number]) => {
    const held = g.grant_id === setup.grant?.id;
    const label = revoking === g.grant_id && action.busy ? <Spinner /> : viaDao ? "Propose to revoke" : needsWallet ? "Connect to revoke" : "Revoke";
    return needsWallet ? (
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
    );
  };

  return (
    <Section title="Grants" description="Live grants allow actions inside the policy. Expired and revoked grants remain here as history.">
      <Card>
        {history}
        {issueButton}
        <Details summary="Revoke a grant" className="border-t pt-3">
          <p className="text-muted-foreground">
            Revoking a grant stops it at once; operations it already committed still finish.{viaDao ? " Each revocation is one DAO proposal." : ""} A
            new grant replaces the current one once the owner signs it. A treasury grant's label carries the strategy in force, so signing it
            approves that strategy for the autopilot.
          </p>
          <ul className="flex flex-col divide-y">
            {live.map((g) => (
              <li key={g.grant_id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span>{g.label}</span>
                <div className="flex items-center gap-2">
                  {revoking === g.grant_id && action.label && <span className="text-muted-foreground">{action.label}</span>}
                  {revokeButton(g)}
                </div>
              </li>
            ))}
          </ul>

          {connectedNotOwner && <p className="text-xs text-muted-foreground">Only {ownerName(setup)} can revoke or issue grants. Connect that account.</p>}
        </Details>
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
          <Details summary={`Every revision (${history.data.length})`} className="border-t pt-3">
            <ul className="flex flex-col divide-y">
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
          </Details>
        )}
      </Card>
    </Section>
  );
}
