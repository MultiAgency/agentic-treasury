import { paymentAssets } from "../payables/payment-assets";
import { TaskEvidence } from "../evidence/task-evidence";
import { ConfirmButton } from "../owner/confirm-button";
import { HandCoins, PaperPlaneTilt, Plus, X } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ago, client, fromUnits, kindOf, queries, toUnits, useAttempt } from "../../shared/lib";
import { AssetAmount, PaymentReview, type PaymentReviewData, PayoutResult, useDestinations, usePayout } from "./payout";
import { reviewedPolicyOf } from "../policy/policy-review";
import { useAgent } from "../../app/agent-context";
import { Badge, Button, Card, Details, ErrorBox, Loading, QueryError, Section, Spinner } from "../../shared/ui";
import { useNameOf } from "../../shared/names";
import { useIsOperator } from "../../app/viewer";
import { Field, focusInvalid } from "../../shared/form";
import { payeeError, deadlineError } from "../../shared/form-validation";
import { intentsAccount, isNearcomAddress } from "../../../../src/intents-account.js";
import { useDirtyDraft } from "../../shared/dirty-draft";
import { InvoicePageLink } from "./invoice-link";

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
  const [addSubmitted, setAddSubmitted] = useState(false);
  const editable = !except && !destinations.action.busy && !destinations.blocked;
  // Authorization pays a payout only to agreed payees: confidential destinations of an `only` policy (src/authorize.ts).
  const agreed = new Set(data.agreed);

  return (
    <>
      {facilitator && <TaskEvidence task="agreements" />}
      {facilitator && <Agreements listed={listed} destinations={destinations} />}
      <Section
        title={facilitator ? "Agreed payees" : moneyOut ? "Money out: from this agent to a payee" : "Payees"}
        description={except ? "Recipients blocked by the policy." : "Who the policy allows the agent to pay. Its caps still apply."}
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
            <Details summary={facilitator ? "Add a payee without agreement terms" : "Add a payee"} open={!facilitator}>
            {facilitator && <p className="text-muted-foreground">This updates the policy only. Offer terms above to record an amount ceiling and deadline.</p>}
            <form
              noValidate className="flex flex-wrap items-end gap-3 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                setAddSubmitted(true);
                if (payeeError(newPayee)) { focusInvalid(e.currentTarget); return; }
                if (editable) destinations.add({ address: intentsAccount(newPayee), confidential: facilitator || isNearcomAddress(newPayee) || Boolean(treasury?.dao) });
              }}
            >
              <Field label="Payee’s NEAR account" name="payee" autoComplete="off" spellCheck={false} autoCapitalize="none" className="flex-1" placeholder="payee.near or nearcom:…" value={newPayee} onChange={(e) => setNewPayee(e.target.value)} error={addSubmitted ? payeeError(newPayee) : undefined} />
              <Button type="submit" variant="outline" disabled={!editable}>
                <Plus size={16} /> Add
              </Button>
            </form>
            <RecipientHint value={newPayee} />
            </Details>
          )}
          <span className="text-sm text-muted-foreground">{destinations.action.label ?? destinations.blocked}</span>
          <ErrorBox error={destinations.action.error} />

          {moneyOut ? <ManualPayment listed={listed} open /> : <Link to="/" hash="manual-payment" className="text-sm underline">Create a payment in Payments</Link>}
        </Card>
      </Section>
    </>
  );
}

/** On a treasury agent's Funding page: where its funds may go, only when it is that kind of agent. */
export function TreasuryPayees() {
  const { data } = useAgent();
  return kindOf(data) === "treasury" ? (
    <Details summary="Send money to a payee">
      <PayeesSection moneyOut />
    </Details>
  ) : null;
}

/** A payment sent by hand, folded away: the provider decides, refusing anyone the policy doesn't list. */
export function ManualPayment({ listed, open }: { listed: Set<string>; open?: boolean }) {
  const { data, setup } = useAgent();
  const nameOf = useNameOf();
  const [recipient, setRecipient] = useState("");
  const book = paymentAssets(data.book, setup.grant?.label);
  const [chosenAsset, setAsset] = useState(book[0]?.asset ?? "");
  const asset = book.some(h => h.asset === chosenAsset) ? chosenAsset : book[0]?.asset ?? "";
  const [value, setValue] = useState("");
  const payout = usePayout();
  const operator = useIsOperator();
  const canSend = operator && setup.executor !== false && Boolean(setup.grant);
  useDirtyDraft(Boolean(recipient || value) && !payout.result && !payout.busy);
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState<PaymentReviewData>();
  const holding = book.find((h) => h.asset === asset);
  const amount = holding ? toUnits(value, holding.decimals) : null;
  const account = intentsAccount(recipient);
  const destination = data.policy.policy?.destinations.list.find((d) => d.action === "transfer" && d.address === account);
  const confidential = destination?.action === "transfer" ? destination.confidential : true;
  return (
    <Details summary="Send a payment by hand" open={open} className="border-t pt-4">
      {!canSend && <p className="text-muted-foreground">Creating a payment requires an operator on the executor with a live grant. Existing payments remain available for review.</p>}
      <p className="text-muted-foreground">The agent sends under its grant; the provider refuses anyone the policy doesn't list.</p>
      <form
        noValidate className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (!amount || payeeError(recipient)) { focusInvalid(e.currentTarget); return; }
          if (canSend && !payout.busy && holding) setReview({
            request: { recipient: account, asset, amount, confidential },
            symbol: holding.symbol, decimals: holding.decimals, ownerApproval: data.policy.policy?.owner_approval,
            expectedPolicy: reviewedPolicyOf(data),
          });
        }}
      >
        <Field label="Recipient’s NEAR account" name="recipient" autoComplete="off" spellCheck={false} autoCapitalize="none" list="payees" placeholder="payee.near or nearcom:…" value={recipient} onChange={(e) => setRecipient(e.target.value)} error={submitted ? payeeError(recipient) : undefined} />
        <RecipientHint value={recipient} confidential={confidential} />
        <datalist id="payees">
          {[...listed].map((address) => (
            <option key={address} value={address} label={nameOf(address)} />
          ))}
        </datalist>
        <div className="flex flex-wrap items-center gap-3">
          <AssetAmount book={book} asset={asset} setAsset={setAsset} value={value} setValue={setValue} submitted={submitted} />
          <Button type="submit" disabled={payout.busy || !canSend}>
            {payout.busy ? <Spinner /> : <PaperPlaneTilt size={18} />} {payout.busy ? "Sending…" : "Review payment"}
          </Button>
          <PayoutResult result={payout.result} />
        </div>
        {account && !listed.has(account) && (
          <span className="text-sm text-warning-muted-foreground">The policy doesn't list this account: expect a refusal.</span>
        )}
      </form>
      <span role="status" className="sr-only">{payout.busy ? "Submitting payment…" : ""}</span>
      {review && <PaymentReview payment={review} currentPolicy={data.notInForce ? undefined : reviewedPolicyOf(data)} onClose={() => setReview(undefined)} onConfirm={payout.pay} />}
      <ErrorBox error={payout.error} />
    </Details>
  );
}

/** Explain the actual transfer destination before an owner reviews or submits it. */
function RecipientHint({ value, confidential = true }: { value: string; confidential?: boolean }) {
  return isNearcomAddress(value) && !payeeError(value) ? <p className="break-words text-sm text-muted-foreground">
    Destination: <span className="break-all font-mono">{intentsAccount(value)}</span>. {confidential
      ? "A confidential transfer reaches the balance near.com shows."
      : "The policy lists a public transfer: it reaches the legacy public balance, which near.com does not show by default."}
  </p> : null;
}

const STATUS_WORDS = {
  requested: ["Asked to be paid", "warning"],
  proposed: ["Terms saved; policy approval needed", "info"],
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
  // Observe the shell's policy read without starting another request.
  const policyRead = useQuery({ ...queries.overview, enabled: false });
  const { setup, data } = useAgent();
  const pending = useQuery({ ...queries.ownerPending, refetchInterval: 5_000 });
  const policyWaiting = pending.data?.some((p) => p.type === "policy_update" && p.state === "waiting");
  const decline = useAttempt([["agreements"]]);
  const agreeing = useAttempt();
  // Each request's own deadline, until someone changes it: thirty days out.
  const [untilOf, setUntilOf] = useState<Record<string, string>>({});
  const [dateChecked, setDateChecked] = useState<Record<string, boolean>>({});
  const until = (id: string) => untilOf[id] ?? inThirtyDays();
  const open = (list.data ?? []).filter((a) => a.status !== "filed" && a.status !== "declined");
  const groups = [
    { title: "Requests to review", records: open.filter(a => a.status === "requested") },
    { title: "Policy approval needed", records: open.filter(a => a.status === "proposed") },
    { title: "Established agreements", records: open.filter(a => a.status === "agreed") },
  ];
  const decisionsWaiting = open.some(a => a.status === "requested" || a.status === "proposed");
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
      description="Review requested or offered terms. The owner signs any required policy update; payment approval is a separate decision."
    >
      <Card>
        <InvoicePageLink next={!list.error && !policyRead.error && !data.notInForce && data.policy.policy?.destinations.mode === "only" && open.some(a => a.status === "agreed" && data.agreed.includes(a.payee))} />
        {list.error ? (
          <QueryError error={list.error} retry={() => list.refetch()} />
        ) : !list.data ? (
          <Loading label="Loading agreements…" />
        ) : open.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open agreements. Review a request from the invoice page or offer terms below.</p>
        ) : (
          groups.filter(group => group.records.length > 0).map(group => <div key={group.title} className="flex flex-col gap-3">
          <h3 className="font-medium">{group.title} ({group.records.length})</h3>
          <ul className="flex flex-col divide-y">
            {group.records.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 py-3 text-sm first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="break-all font-mono">{nameOf(a.payee)}</span> · {fromUnits(a.terms?.maxAmount ?? a.amount, 6)} USDC
                    {a.note && ` · ${a.note}`}
                  </span>
                  <Badge tone={STATUS_WORDS[a.status][1]}>{STATUS_WORDS[a.status][0]}</Badge>
                </div>
                <span className="text-muted-foreground">
                  {a.origin === "owner" ? "Offered" : "Requested"} {ago(a.at)}
                  {a.terms && ` · each invoice up to ${fromUnits(a.terms.maxAmount, 6)} USDC until ${new Date(a.terms.until).toLocaleDateString()}`}
                </span>
                {a.status === "proposed" && <div className="flex flex-col gap-2">
                  <p>The terms are saved. The policy has not yet agreed this payee.</p>
                  {setup.dao && <a className="underline" href={`https://trezu.app/${setup.dao.id}/requests`} target="_blank" rel="noopener noreferrer">Review the policy proposal in Trezu</a>}
                  {policyWaiting ? <p>A policy proposal is still waiting. Complete its vote before preparing another.</p> : <>
                    <p>If the wallet was cancelled before filing, continue with the saved terms. If submission is uncertain, ask the operator to review it first.</p>
                    <Button size="sm" className="self-start" disabled={blocked || !pending.isSuccess || agreeing.busy} onClick={() => destinations.add({ address: a.payee, confidential: true })}>Continue policy approval</Button>
                  </>}
                  <Link to="/policy" className="underline">Review the current policy</Link>
                  <ErrorBox error={pending.error?.message} />
                </div>}
                {a.status === "agreed" && <p className="text-muted-foreground">The payee files from their own account on the invoice page.</p>}
                {a.status === "requested" && (
                    <form noValidate className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
                      e.preventDefault();
                      setDateChecked((all) => ({ ...all, [a.id]: true }));
                      if (deadlineError(until(a.id))) { focusInvalid(e.currentTarget); return; }
                      if (!blocked && !agreeing.busy) agree(a.id, a.payee);
                    }}>
                      <Field label="Terms hold until" name="until" autoComplete="off" type="date" className="w-44" value={until(a.id)}
                        error={dateChecked[a.id] ? deadlineError(until(a.id)) : undefined}
                        onChange={(e) => setUntilOf((all) => ({ ...all, [a.id]: e.target.value }))} />
                      <Button type="submit" size="sm" disabled={blocked || agreeing.busy}>
                        Agree to these terms
                      </Button>
                      <ConfirmButton label="Decline" title="Decline this agreement request?"
                        description={`Decline the request from ${a.payee} for ${fromUnits(a.amount, 6)} USDC. It moves to filed or declined requests; this does not change the policy or cancel a payment.`}
                        confirm="Decline request" disabled={!operator || decline.busy}
                        onConfirm={() => decline.attempt(() => client.agreements.decline({ id: a.id }))} />
                    </form>
                )}
              </li>
            ))}
          </ul>
          </div>)
        )}
        {/* Why Agree or Decline is off, once for every request. */}
        <span className="text-sm text-muted-foreground">
          {destinations.action.label ?? destinations.blocked}{open.some((a) => a.status === "requested") && !operator && " Only operators can decline."}
        </span>
        <ErrorBox error={destinations.action.error ?? agreeing.error ?? decline.error} />
        {list.data && <Offer listed={listed} destinations={destinations} initiallyOpen={!decisionsWaiting} />}
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
function Offer({ listed, destinations, initiallyOpen }: { listed: Set<string>; destinations: ReturnType<typeof useDestinations>; initiallyOpen: boolean }) {
  // Capture the initial presentation once; polling must not close an owner’s draft.
  const [open] = useState(initiallyOpen);
  const queryClient = useQueryClient();
  const offer = useAttempt();
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [initialUntil] = useState(inThirtyDays);
  const [until, setUntil] = useState(initialUntil);
  const [submitted, setSubmitted] = useState(false);
  const recipientError = payeeError(payee);
  const amountError = toUnits(amount, 6) ? undefined : "Enter a USDC amount greater than zero, with up to 6 decimal places.";
  const dateError = deadlineError(until);
  useDirtyDraft(Boolean(payee || amount || note || until !== initialUntil));
  return (
    <Details open={open} summary="Offer terms (a purchase order, a bounty or grant award)" className="border-t pt-4">
      <form
        noValidate className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (recipientError || amountError || dateError) { focusInvalid(e.currentTarget); return; }
          if (offer.busy || destinations.action.busy || destinations.blocked) return;
          offer.attempt(async () => {
            const account = intentsAccount(payee);
            await client.agreements.offer({ payee: account, amount, note, until: endOf(until) });
            await queryClient.invalidateQueries(queries.agreements);
            setPayee(""); setAmount(""); setNote(""); setUntil(initialUntil); setSubmitted(false);
            if (!listed.has(account)) await destinations.add({ address: account, confidential: true });
          });
        }}
      >
        <Field label="Payee’s NEAR account" name="offer-payee" autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="payee.near or nearcom:…" value={payee} onChange={(e) => setPayee(e.target.value)} error={submitted ? recipientError : undefined} />
        <RecipientHint value={payee} />
        <div className="flex flex-wrap gap-3">
          <Field label="Up to (USDC)" name="offer-amount" autoComplete="off" className="w-36" inputMode="decimal" placeholder="Up to (USDC)" value={amount} onChange={(e) => setAmount(e.target.value)} error={submitted ? amountError : undefined} />
          <Field label="Terms hold until (UTC)" name="offer-until" autoComplete="off" type="date" className="w-44" value={until} onChange={(e) => setUntil(e.target.value)} error={submitted ? dateError : undefined} />
        </div>
        <Field label="What it’s for" name="offer-note" autoComplete="off" maxLength={200} placeholder="What it's for (PO-17, audit bounty…)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" className="self-start" disabled={offer.busy || destinations.action.busy || Boolean(destinations.blocked)}>
          {offer.busy ? <Spinner /> : <HandCoins size={18} />} Offer
        </Button>
        <span className="text-muted-foreground">
          The payee signs in on the invoice page and files against these terms. If the policy doesn't list them yet,
          the owner must also approve a policy update.
        </span>
      </form>
      <ErrorBox error={offer.error} />
    </Details>
  );
}
