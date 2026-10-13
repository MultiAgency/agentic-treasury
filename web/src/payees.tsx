import { HandCoins, PaperPlaneTilt, Plus, X } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ago, client, fromUnits, kindOf, queries, toUnits, useAttempt } from "./lib";
import { AssetAmount, PayoutResult, useDestinations, usePayout } from "./payout";
import { useAgent } from "./shell";
import { Badge, Button, Card, Details, ErrorBox, input, Loading, QueryError, Section, Spinner } from "./ui";
import { useNameOf } from "./names";
import { useIsOperator } from "./viewer";

/** Thirty days from now, as a date input's value: the default deadline of new terms. */
const inThirtyDays = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
/** The end of the chosen day, UTC: terms hold through their last day. */
const endOf = (day: string) => new Date(`${day}T23:59:59.999Z`).toISOString();

/**
 * Who the agent may pay. The owner signs each payee into the policy; for a DAO, payees its members
 * already voted to pay are offered first, and a payout agent's agreements (requests from the invoice
 * page, offers such as purchase orders and awards) are answered here.
 */
export function PayeesSection({ moneyOut = false }: { moneyOut?: boolean }) {
  const { treasury, data, setup } = useAgent();
  const nameOf = useNameOf();
  const destinations = useDestinations(data, setup);
  const facilitator = kindOf(data) === "facilitator";
  const payees = destinations.current.filter((d) => d.address !== treasury?.accountId);
  // One predicate with the overview's: a payee the DAO voted to pay that the policy doesn't list yet.
  const listed = new Set(destinations.current.map((d) => d.address));
  const candidates = (treasury?.payees ?? []).filter((c) => !listed.has(c.address));
  // Every edit signs an allow-list (src/owner-requests.ts), so a block-list policy isn't edited here.
  const except = data.policy.policy?.destinations.mode === "except";
  const [newPayee, setNewPayee] = useState("");
  const editable = !except && !destinations.action.busy && !destinations.blocked;
  // Authorization pays a payout only to agreed payees: confidential destinations of an `only` policy (src/authorize.ts).
  const agreed = new Set(data.agreed);

  return (
    <>
      {facilitator && <Agreements listed={listed} destinations={destinations} />}
      <Section
        title={facilitator ? "Agreed payees" : moneyOut ? "Money out: from this agent to a payee" : "Payees"}
        description="Who the agent may pay. The provider refuses anyone the policy doesn't list, and any payment over its caps."
      >
        <Card>
          {except && (
            <p className="text-sm text-warning-muted-foreground">
              This policy blocks the recipients below and allows anyone else. Editing here would replace it with an allow-list, so it's a
              policy edit, not a payee change.
            </p>
          )}
          {payees.length === 0 && <p className="text-sm text-muted-foreground">No payees yet.</p>}
          <ul className="flex flex-col gap-2">
            {payees.map((p) => (
              <li key={p.address} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-mono" title={p.address}>
                  {nameOf(p.address)}
                </span>
                <span className="flex items-center gap-2">
                  {except ? (
                    <Badge tone="warning">blocked</Badge>
                  ) : facilitator && !agreed.has(p.address) ? (
                    <Badge tone="warning">public: not paid as a payout</Badge>
                  ) : (
                    <Badge tone="info">{p.confidential ? "confidential" : "public"}</Badge>
                  )}
                  <Button variant="ghost" size="sm" disabled={!editable} onClick={() => destinations.remove(p.address)} aria-label={`Remove ${p.address}`}>
                    <X size={14} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>

          {candidates.length > 0 && (
            <div className="flex flex-col gap-2 border-t pt-4">
              <span className="text-sm text-muted-foreground">Approved by {treasury?.accountId} in past proposals</span>
              {candidates.map((c) => (
                <div key={c.address} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-mono">{nameOf(c.address)}</span> <span className="text-muted-foreground">· #{c.proposalId}</span>
                  </span>
                  <Button variant="outline" size="sm" disabled={!editable} onClick={() => destinations.add({ address: c.address, confidential: true })}>
                    <Plus size={14} /> Add
                  </Button>
                </div>
              ))}
            </div>
          )}

          {!except && (
            <form
              className="flex gap-3 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (newPayee.trim()) destinations.add({ address: newPayee.trim(), confidential: Boolean(treasury?.dao) });
              }}
            >
              <input className={`${input} flex-1`} placeholder="Payee's NEAR account" value={newPayee} onChange={(e) => setNewPayee(e.target.value)} />
              <Button type="submit" variant="outline" disabled={!editable || !newPayee.trim()}>
                <Plus size={16} /> Add
              </Button>
            </form>
          )}
          <span className="text-sm text-muted-foreground">{destinations.action.label ?? destinations.blocked}</span>
          <ErrorBox error={destinations.action.error} />

          <ManualPayment listed={listed} open={moneyOut} />
        </Card>
      </Section>
    </>
  );
}

/** On a treasury agent's Funding page: where its funds may go, only when it is that kind of agent. */
export function TreasuryPayees() {
  const { data } = useAgent();
  return kindOf(data) === "treasury" ? <PayeesSection moneyOut /> : null;
}

/** A payment sent by hand, folded away: the provider decides, refusing anyone the policy doesn't list. */
function ManualPayment({ listed, open }: { listed: Set<string>; open?: boolean }) {
  const { data } = useAgent();
  const nameOf = useNameOf();
  const [recipient, setRecipient] = useState("");
  const [asset, setAsset] = useState(data.book[0]?.asset ?? "");
  const [value, setValue] = useState("");
  const payout = usePayout();
  const holding = data.book.find((h) => h.asset === asset);
  const amount = holding ? toUnits(value, holding.decimals) : null;
  const destination = data.policy.policy?.destinations.list.find((d) => d.address === recipient.trim());
  return (
    <Details summary="Send a payment by hand" open={open} className="border-t pt-4">
      <p className="text-muted-foreground">The agent sends under its grant; the provider refuses anyone the policy doesn't list.</p>
      {listed.size > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">To:</span>
          {[...listed].map((address) => (
            <Button key={address} size="sm" variant={recipient === address ? "default" : "outline"} onClick={() => setRecipient(address)}>
              {nameOf(address)}
            </Button>
          ))}
        </div>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (amount && recipient.trim())
            payout.pay({ recipient: recipient.trim(), asset, amount, confidential: destination?.action === "transfer" ? destination.confidential : true });
        }}
      >
        <input className={input} list="payees" placeholder="Recipient's NEAR account" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
        <datalist id="payees">
          {[...listed].map((address) => (
            <option key={address} value={address} />
          ))}
        </datalist>
        <div className="flex flex-wrap items-center gap-3">
          <AssetAmount book={data.book} asset={asset} setAsset={setAsset} value={value} setValue={setValue} />
          <Button type="submit" disabled={payout.busy || !amount || !recipient.trim()}>
            {payout.busy ? <Spinner /> : <PaperPlaneTilt size={18} />} Pay
          </Button>
          <PayoutResult result={payout.result} />
        </div>
        {recipient.trim() && !listed.has(recipient.trim()) && (
          <span className="text-sm text-warning-muted-foreground">The policy doesn't list this account: expect a refusal.</span>
        )}
      </form>
      <ErrorBox error={payout.error} />
    </Details>
  );
}

const STATUS_WORDS = {
  requested: ["Asked to be paid", "warning"],
  proposed: ["Agreement proposed", "info"],
  agreed: ["Agreed, invoice not filed yet", "success"],
  filed: ["Invoice filed", "neutral"],
  declined: ["Declined", "neutral"],
} as const;

/**
 * Agreements with terms (src/agreements.ts). A payee asks from the invoice page, or the DAO offers
 * first (a purchase order, a bounty or grant award). Agreeing records the terms and files the policy
 * update that lists the payee; the payee then files the invoice, and its payment still waits for a vote.
 */
function Agreements({ listed, destinations }: { listed: Set<string>; destinations: ReturnType<typeof useDestinations> }) {
  const operator = useIsOperator();
  const nameOf = useNameOf();
  const queryClient = useQueryClient();
  const list = useQuery(queries.agreements);
  const decline = useAttempt();
  const agreeing = useAttempt();
  // Each request's own deadline, until someone changes it: thirty days out.
  const [untilOf, setUntilOf] = useState<Record<string, string>>({});
  const until = (id: string) => untilOf[id] ?? inThirtyDays();
  const open = (list.data ?? []).filter((a) => a.status !== "filed" && a.status !== "declined");
  const closed = (list.data ?? []).filter((a) => a.status === "filed" || a.status === "declined");
  const blocked = destinations.action.busy || Boolean(destinations.blocked);

  // Terms first, so voters see them beside the proposal; then the policy update, unless already listed.
  const agree = (id: string, payee: string) =>
    agreeing.attempt(async () => {
      await client.agreements.propose({ id, until: endOf(until(id)) });
      await queryClient.invalidateQueries(queries.agreements);
      if (!listed.has(payee)) await destinations.add({ address: payee, confidential: true });
    });

  return (
    <Section
      title="Agreements"
      description="Who asked to be paid, and what the DAO offered. Agreeing lists the payee in the policy, by vote; each payment is still voted on."
    >
      <Card>
        {list.error ? (
          <QueryError error={list.error} retry={() => list.refetch()} />
        ) : !list.data ? (
          <Loading label="Loading agreements…" />
        ) : open.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting. Requests from the invoice page appear here.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {open.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 py-3 text-sm first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-mono">{nameOf(a.payee)}</span> · {fromUnits(a.terms?.maxAmount ?? a.amount, 6)} USDC
                    {a.note && ` · ${a.note}`}
                  </span>
                  <Badge tone={STATUS_WORDS[a.status][1]}>{STATUS_WORDS[a.status][0]}</Badge>
                </div>
                <span className="text-muted-foreground">
                  {a.origin === "owner" ? "Offered" : "Requested"} {ago(a.at)}
                  {a.terms && ` · each invoice up to ${fromUnits(a.terms.maxAmount, 6)} USDC until ${new Date(a.terms.until).toLocaleDateString()}`}
                </span>
                {a.status === "requested" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <input type="date" className={`${input} w-44`} aria-label="Terms hold until" value={until(a.id)}
                        onChange={(e) => setUntilOf((all) => ({ ...all, [a.id]: e.target.value }))} />
                      <Button size="sm" disabled={blocked || agreeing.busy} onClick={() => agree(a.id, a.payee)}>
                        Agree to these terms
                      </Button>
                      <Button size="sm" variant="outline" disabled={!operator || decline.busy}
                        onClick={() => decline.attempt(async () => { await client.agreements.decline({ id: a.id }); await queryClient.invalidateQueries(queries.agreements); })}>
                        Decline
                      </Button>
                    </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {/* Why Agree or Decline is off, once for every request. */}
        <span className="text-sm text-muted-foreground">
          {[destinations.action.label ?? destinations.blocked, open.some((a) => a.status === "requested") && !operator && "Only operators can decline."].filter(Boolean).join(" ")}
        </span>
        <ErrorBox error={destinations.action.error ?? agreeing.error ?? decline.error} />
        <Offer listed={listed} destinations={destinations} />
        {closed.length > 0 && (
          <Details summary={`Filed or declined (${closed.length})`}>
            <ul className="flex flex-col gap-1">
              {closed.map((a) => (
                <li key={a.id} className="text-muted-foreground">
                  {nameOf(a.payee)} · {fromUnits(a.amount, 6)} USDC · {STATUS_WORDS[a.status][0]}
                </li>
              ))}
            </ul>
          </Details>
        )}
      </Card>
    </Section>
  );
}

/** The DAO offers first: a purchase order, or a bounty or grant award, to an account it names. */
function Offer({ listed, destinations }: { listed: Set<string>; destinations: ReturnType<typeof useDestinations> }) {
  const queryClient = useQueryClient();
  const offer = useAttempt();
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [until, setUntil] = useState(inThirtyDays());
  return (
    <Details summary="Offer terms (a purchase order, a bounty or grant award)" className="border-t pt-4">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          offer.attempt(async () => {
            const account = payee.trim().toLowerCase();
            await client.agreements.offer({ payee: account, amount, note, until: endOf(until) });
            await queryClient.invalidateQueries(queries.agreements);
            setPayee(""); setAmount(""); setNote("");
            if (!listed.has(account)) await destinations.add({ address: account, confidential: true });
          });
        }}
      >
        <input className={input} placeholder="Payee's NEAR account" value={payee} onChange={(e) => setPayee(e.target.value)} />
        <div className="flex flex-wrap gap-3">
          <input className={`${input} w-36`} inputMode="decimal" placeholder="Up to (USDC)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input type="date" className={`${input} w-44`} value={until} onChange={(e) => setUntil(e.target.value)} />
        </div>
        <input className={input} maxLength={200} placeholder="What it's for (PO-17, audit bounty…)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" className="self-start" disabled={offer.busy || destinations.action.busy || Boolean(destinations.blocked) || !payee.trim() || !amount.trim()}>
          {offer.busy ? <Spinner /> : <HandCoins size={18} />} Offer
        </Button>
        <span className="text-muted-foreground">
          The payee signs in on the invoice page and files against these terms. If the policy doesn't list them yet, this also files the
          policy update for the DAO's vote.
        </span>
      </form>
      <ErrorBox error={offer.error} />
    </Details>
  );
}
