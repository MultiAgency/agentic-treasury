import { Link, useSearch } from "@tanstack/react-router";
import { useViewer } from "./viewer";
import { useQuery } from "@tanstack/react-query";
import { PaymentEvidence } from "./payment-evidence";
import { type ReactNode, useRef, useState } from "react";
import type { Decoded } from "../../src/gateway/proposals.js";
import { ago, APPROVAL_WINDOW_MS, client, exactPayment, fromUnits, gw, minutesSeconds, queries, useCountdown } from "./lib";
import { useSiblings } from "./names";
import { useOwnerAction, useSigner } from "./owner";
import { useAgent } from "./shell";
import { Badge, Button, Card, ConfirmButton, Details, ErrorBox, Loading, QueryError, Section, Spinner } from "./ui";
import { refusalText } from "./words";
import { paymentOwnerState } from "./payment-owner-state";

/**
 * Payments held for the owner, each as a timeline that doubles as its receipt, approved or rejected in
 * place: the payout agent's Overview lists them ("Payments"), and "Follow this payment" shows the same
 * list full page, to link to. Each step reads its own record: the held payout, the owner action that
 * approves or rejects it (owner/pending names the payment and the verdict), the DAO proposal with that
 * action's hash, the action's outcome, and the provider's status for the payment (`paymentStatus`, which
 * works on an approve-only copy). Only payouts held for the owner are listed: a direct transfer has no
 * vote to show. Members only.
 *
 * Each moment also says what anyone watching the chain could learn from it, as far as it has been
 * observed: the proposal and the MPC signature are public; the payout shows no public transfer.
 */

const TERMINAL = new Set(["SUCCESS", "FAILED", "REFUNDED"]);
type Status = "complete" | "current" | "upcoming" | "stopped" | "unverified";

const time = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null);

/** What an outsider sees at one moment: a plain statement, and the public value itself when there is one. */
type Public = { text: string; value?: string };

/**
 * One moment, told twice: what members see on the left, what the chain shows on the right (under it on a
 * phone). The spine between them fills as the payment moves.
 */
function Moment({ status, when, title, detail, outsider, last, children }: {
  status: Status; when: string | null; title: string; detail?: ReactNode; outsider: Public; last?: boolean; children?: ReactNode;
}) {
  const reached = status !== "upcoming";
  const dot = {
    complete: "border-brand bg-brand",
    unverified: "border-border-strong bg-background",
    current: "border-brand bg-background ring-4 ring-brand-muted",
    upcoming: "border-border-strong bg-background",
    stopped: "border-destructive-muted-foreground bg-destructive-muted-foreground",
  }[status];
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-x-4 md:grid-cols-[1fr_2.5rem_1fr] md:gap-x-2">
      <div className="flex flex-col gap-1 pb-3 md:col-start-1 md:row-start-1 md:items-end md:pb-8 md:text-right col-start-2">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{reached ? (when ?? "") : "not yet"}</span>
        <h3 className={`font-heading text-base font-medium text-balance ${reached ? "" : "text-muted-foreground"}`}>{title}{status === "unverified" && <span className="text-sm text-muted-foreground"> · unverified</span>}</h3>
        {reached && detail && <p className="max-w-prose text-sm text-muted-foreground">{detail}</p>}
        {status === "current" && children}
      </div>
      <div className="relative col-start-1 row-span-2 row-start-1 flex justify-center md:col-start-2 md:row-span-1">
        {!last && <span className={`absolute top-6 -bottom-1 w-0.5 ${status === "complete" ? "bg-brand" : "bg-border"}`} />}
        <span className={`relative mt-1.5 size-3.5 rounded-full border-2 ${dot}`} />
      </div>
      <div
        className={`col-start-2 mb-6 min-w-0 self-start rounded-lg border px-3.5 py-2.5 text-sm md:col-start-3 md:row-start-1 md:mb-8 ${reached ? "" : "opacity-55"}`}
        style={{ background: "repeating-linear-gradient(-45deg, var(--muted) 0 6px, transparent 6px 12px), var(--card)" }}
      >
        <p className="text-muted-foreground"><span className="md:hidden">On chain: </span>{status === "unverified" ? "Public visibility is not established by this record." : reached ? outsider.text : "Nothing yet."}</p>
        {reached && status !== "unverified" && outsider.value && <p className="mt-1 font-mono text-xs break-all">{outsider.value}</p>}
      </div>
    </li>
  );
}

type Agreement = Awaited<ReturnType<typeof client.agreements.list>>[number];

/**
 * A held payout against its payee's latest agreed terms (src/agreements.ts `withinTerms`): what a
 * voter checks. The terms are this server's record; the vote is what enforces them.
 */
function TermsCheck({ request, agreements }: { request: Record<string, unknown>; agreements: Agreement[] }) {
  const { recipient, amount } = request as { recipient?: string; amount?: string };
  const terms = agreements.filter((a) => a.payee === recipient && a.terms && a.status !== "declined").at(-1)?.terms;
  if (!terms || !amount || !/^\d+$/.test(amount)) return <Badge>No agreed terms on record</Badge>;
  const over = BigInt(amount) > BigInt(terms.maxAmount);
  const late = Date.now() > Date.parse(terms.until);
  return <div className="flex flex-col gap-2 text-sm">
    <p>Each invoice up to {fromUnits(terms.maxAmount, 6)} USDC · deadline {new Date(terms.until).toLocaleString()}</p>
    <Badge tone={over || late ? "warning" : "neutral"}>{over || late ? "Outside agreed terms" : "Within recorded terms"}</Badge>
    <p>These terms are checked by the voter. Invoices outside them are not automatically refused.</p>
  </div>;
}

/** A payment as this page knows it; `request` is missing for one approved earlier that this tab never saw held. */
type Known = { at: string; request?: Record<string, unknown>; approvalId?: string };

/**
 * Payments seen held in this tab. On the hosted dashboard the payout agent is approve-only: once a payment
 * settles it is no longer held, and its request was sent from the invoice host, so only what was seen
 * here while it was held can still describe it.
 */
const remembered = new Map<string, Known>();

/** Held payments, and those an approval this server filed names (within the approval window), newest first. */
function usePayments(poll: number | false) {
  const held = useQuery({ ...queries.held, retry: false });
  const pending = useQuery({ queryKey: ["owner", "pending"], queryFn: () => client.owner.pending(), refetchInterval: poll });
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => client.activity() });
  const history = useQuery({ queryKey: ["paymentHistory"], queryFn: () => client.paymentHistory(), refetchInterval: 30_000, retry: false });
  const ownerActions = useQuery({ queryKey: ["owner", "actions"], queryFn: () => client.owner.actions(), refetchInterval: poll, retry: false });
  const known = new Map<string, Known>();
  for (const p of history.data?.items ?? []) known.set(p.correlationId, { at: p.at });
  for (const a of ownerActions.data ?? []) if (a.payment && !known.has(a.payment.correlationId)) known.set(a.payment.correlationId, { at: "" });
  const sent = new Map((activity.data ?? []).filter((op) => op.correlationId).map((op) => [op.correlationId!, op]));
  const since = Date.now() - APPROVAL_WINDOW_MS;
  for (const p of pending.data ?? []) {
    if (!p.payment || Date.parse(p.expiresAt) < since) continue;
    const id = p.payment.correlationId;
    const op = sent.get(id);
    known.set(id, remembered.get(id) ?? known.get(id) ?? (op ? { at: op.at, request: op.request } : { at: "" }));
  }
  for (const h of held.data ?? []) {
    const item = { at: h.at, request: h.request, approvalId: h.approvalId };
    remembered.set(h.correlationId, item);
    known.set(h.correlationId, item);
  }
  for (const [id, item] of remembered) if (!known.has(id)) known.set(id, item);
  const list = [...known].sort(([, a], [, b]) => b.at.localeCompare(a.at));
  return { held, pending, activity, history, ownerActions, list };
}

/** One payment's timeline, with Approve and Reject in its vote step while it is held. */
function PaymentCard({ id, payment: knownPayment, agreements, historyOpen = false }: { historyOpen?: boolean; id: string; payment: Known; agreements?: Agreement[] }) {
  const { data, setup } = useAgent();
  const viewer = useViewer();
  const { self } = useSiblings();
  const [settled, setSettled] = useState(false);
  const poll = settled ? false : 5_000;
  const pending = useQuery({ queryKey: ["owner", "pending"], queryFn: () => client.owner.pending(), refetchInterval: poll });
  // The proposals of the DAO that owns this agent, when one does: an owner account files none.
  const dao = self?.dao ? self.owner : undefined;
  const proposals = useQuery({ queryKey: ["gw", "proposals", dao], queryFn: () => gw<Decoded[]>(`/gw/proposals?dao=${encodeURIComponent(dao!)}`),
    enabled: Boolean(dao), refetchInterval: settled ? false : 10_000 });
  const ownerActions = useQuery({ queryKey: ["owner", "actions"], queryFn: () => client.owner.actions(), refetchInterval: poll, retry: false });
  const action = useOwnerAction(setup);
  const { canSign } = useSigner(setup);

  // The first read answers at once; each later one waits at the provider until the payment moves (up to
  // 25 s) and is asked again as soon as it answers: news arrives at once, in about 2 calls a minute. The
  // provider holds at most 10 waits per API key and answers the rest at once, so a wait that came back
  // quickly without the payment finishing is followed by a 4 s pause instead of an immediate retry.
  const seen = useRef(false);
  const quick = useRef(false);
  const status = useQuery({
    queryKey: ["paymentStatus", id],
    retry: false,
    queryFn: async () => {
      const waited = seen.current;
      const started = Date.now();
      const result = await client.paymentStatus({ correlationId: id, ...(waited && { waitMs: 25_000 }) });
      quick.current = waited && Date.now() - started < 5_000;
      seen.current = true;
      return result;
    },
    refetchInterval: (q) => (q.state.error ? false : q.state.data && TERMINAL.has(q.state.data.status) ? false : quick.current ? 4_000 : 500),
  });
  // The latest approval filed for this payment that hasn't expired, else the latest of any.
  const approvals = (pending.data ?? []).filter((p) => p.payment?.correlationId === id);
  const approval = approvals.filter((p) => p.state !== "expired").at(-1) ?? approvals.at(-1);
  const vote = useQuery({
    queryKey: ["owner", "status", approval?.correlationId],
    queryFn: () => client.owner.status({ correlationId: approval!.correlationId }),
    enabled: Boolean(approval),
    refetchInterval: settled ? false : 4_000,
  });
  const proposal = approval ? proposals.data?.find((p) => p.hash === approval.hash) : undefined;
  // The signing window comes from the owner action itself: the API keeps it open 5 to 10 minutes.
  const windowLeft = useCountdown(vote.data?.stage === "voting" ? vote.data.expiresAt : undefined);

  const payment = { at: status.data?.createdAt ?? knownPayment.at, request: status.data?.request ?? knownPayment.request, approvalId: status.data?.approvalId ?? knownPayment.approvalId };
  const expiresAt = status.data?.expiresAt ?? (payment.at ? new Date(Date.parse(payment.at) + APPROVAL_WINDOW_MS).toISOString() : null);
  const s = status.data?.status;
  const paid = s === "SUCCESS";
  const failed = s === "FAILED" || s === "REFUNDED";
  const isHeld = s === "PENDING_APPROVAL";
  const voted = vote.data?.stage === "submitted" ? vote.data : null;
  const outcome = voted && "status" in voted ? voted.status : undefined;
  const { records, recovering, approved, rejected } = paymentOwnerState(ownerActions.data ?? [], id);
  const expired = outcome === "EXPIRED" || approval?.state === "expired";
  const final = paid || failed;
  if (final !== settled) setSettled(final);
  // Each stage needs its own evidence; a paid transfer does not prove approval history.
  const heldEvidence = Boolean(payment.approvalId || approval || records.length);
  const step = (index: number): Status => {
    if (index === 1) return heldEvidence ? "complete" : "unverified";
    if (index === 2) return proposal ? (proposal.status === "Approved" ? "complete" : "current") : approved || rejected ? "complete" : "unverified";
    if (index === 3) return rejected ? "stopped" : approved ? "complete" : recovering?.stage === "submitted" ? "current" : "unverified";
    return paid ? "complete" : failed ? "stopped" : s && !isHeld ? "current" : "upcoming";
  };
  const VOTE_WORDS: Record<string, string> = { InProgress: "voting", Approved: "approved", Rejected: "rejected", Removed: "removed", Expired: "expired" };
  const deciding = action.busy || Boolean(recovering) || approved || rejected || Boolean(approval && !expired && !approved && !rejected);
  const approvable = isHeld && ownerActions.isSuccess && !ownerActions.error && pending.isSuccess && !deciding && Boolean(expiresAt && Date.now() < Date.parse(expiresAt)) && !status.error && !pending.error && !vote.error;
  const decide = (verdict: "approve" | "reject") =>
    payment.approvalId && action.run({ type: "approval_vote", approvalId: payment.approvalId, verdict, correlationId: id });

  const what = payment.request ? exactPayment(payment.request, data.book) : `A payment${proposal ? ` approved by proposal #${proposal.id}` : ""}`;
  const signer = dao ?? "the owner";
  const verdict = paid ? "Paid" : failed ? `Provider reported ${s?.toLowerCase()}` : rejected ? "Rejection submitted" : approved ? "Approved, settling" : expired && isHeld ? "Window closed" : isHeld ? (dao ? "Waiting for the DAO" : "Waiting for the owner") : status.error ? "Status unavailable" : s ? "Outcome unresolved" : "Reading…";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-5">
        <div className="flex flex-col gap-1">
          <p className="font-heading text-xl font-semibold tracking-tight">{what}</p>
          <span className="text-sm text-muted-foreground">
            Requested {payment.at ? ago(payment.at) : "at an unknown time"}{isHeld && expiresAt && ` · approval deadline ${new Date(expiresAt).toLocaleString()}${status.data?.expiresAt ? "" : " (estimated)"}`}
          </span>
          {isHeld && payment.request && (agreements ? <TermsCheck request={payment.request} agreements={agreements} /> : <p>Agreement terms unavailable. Check again before deciding.</p>)}
        </div>
        <Badge tone={paid ? "success" : failed || rejected ? "destructive" : "warning"}>{verdict}</Badge>
      </div>
      {status.error && <QueryError error={status.error} retry={() => status.refetch()} />}
      {pending.error && <QueryError error={pending.error} retry={() => pending.refetch()} />}
      {vote.error && <QueryError error={vote.error} retry={() => vote.refetch()} />}
      {proposals.error && <QueryError error={proposals.error} retry={() => proposals.refetch()} />}
      {status.data?.detailError && <><ErrorBox error={status.data.detailError} /><Button variant="outline" onClick={() => status.refetch()}>Check payment details again</Button></>}
      {failed && <p className="text-sm">This provider status alone does not establish that a replacement payment is safe. Ask an operator to review the existing operation.</p>}
      {!payment.request && <p className="text-sm">Payment details are unavailable on this instance. The status below identifies this operation; it is not a complete payment receipt.</p>}
      {ownerActions.error && <QueryError error={ownerActions.error} retry={() => ownerActions.refetch()} />}
      {recovering && !final && <p role="status" className="text-sm">{recovering.stage === "submitted" ? "Submission attempted—checking the existing owner action’s outcome. Do not sign again." : "An owner action is already prepared. Review it or wait for its signing window to close before starting another."} <Link to="/activity" hash={`owner-${recovering.correlationId}`} className="underline">Review the existing owner action</Link></p>}
      {rejected && <p className="text-sm">Rejection submitted. The payment outcome is reported separately.</p>}
      {!heldEvidence && <p className="text-sm">Approval history is unverified. This payment status does not establish that it was held or approved here.</p>}
      {s && !isHeld && !final && <p role="status" className="text-sm">Outcome unresolved; <Link to="/activity" className="underline">review the existing operation in Activity</Link>. Do not create a replacement.</p>}
      {isHeld && (
          <div className="flex flex-col gap-2 text-sm ">
            {dao && (proposal || approval) && <a className="underline" target="_blank" rel="noopener noreferrer" href={`https://trezu.app/${dao}/requests${proposal ? `/${proposal.id}` : ""}`}>Review and vote in Trezu</a>}
            {windowLeft !== null && !expired && (
              <span className="font-mono text-brand-strong tabular-nums">Signing window {minutesSeconds(windowLeft)} left</span>
            )}
            {action.busy && action.label && <span className="text-muted-foreground">{action.label}</span>}
            {expired && !action.busy && <span className="text-warning-muted-foreground">The last approval's signing window closed before it was used. File it again.</span>}
            {approvable && payment.approvalId && (
              <div className="flex flex-wrap items-center gap-2 ">
                {!canSign && <span className="text-muted-foreground">Only an account that can sign for the owner can approve or reject.</span>}
                <p>Approval releases this held payout for processing. It does not prove payment completed. A held payout does not block new sends.</p>
                <p>{dao ? "The payout deadline and the shorter owner-signature window are separate. A proposal and your vote do not prove the DAO threshold passed." : "Your wallet signs the approval directly."}</p>
                <ConfirmButton ownerAction disabled={!canSign} label={dao ? "Propose rejection" : "Sign rejection"} title="Reject this held payout?" description={`Reject ${what}. Rejection releases no payment.`} confirm={dao ? "Continue to DAO rejection" : "Continue to wallet"} onConfirm={() => decide("reject")} />
                <ConfirmButton ownerAction disabled={!canSign || !payment.request || Boolean(status.data?.detailError) || !agreements}
                  label={dao ? viewer?.canPropose && viewer.canVote ? "File proposal and vote" : "File approval proposal" : "Sign approval"}
                  title="Approve this held payout?" description={`${what}. This approval releases the payout for processing; follow its payment status separately.`}
                  confirm={dao ? "Continue to proposal" : "Continue to wallet"} onConfirm={() => decide("approve")} />
              </div>
            )}
            <ErrorBox error={action.error} />
          </div>
      )}
      <Details summary="Payment history and public visibility" open={historyOpen}>
      <div className="hidden grid-cols-[1fr_2.5rem_1fr] gap-x-2 text-sm text-muted-foreground md:grid">
        <p className="text-right"><span className="block font-heading text-base font-medium text-foreground">What members see</span>Signed in to this dashboard</p>
        <span />
        <p><span className="block font-heading text-base font-medium text-foreground">What anyone on chain sees</span>No amount, payee or invoice, in what we've checked</p>
      </div>
      <ol>
        <Moment status={payment.at ? "complete" : "unverified"} when={time(payment.at)} title="Payment requested"
          detail={payment.request ? `${what}${payment.at ? `, recorded ${new Date(payment.at).toLocaleString()}` : ""}.` : "Original request details are unavailable on this instance."}
          outsider={{ text: "This view does not establish whether the original request has a public record." }} />
        <Moment status={step(1)} when={time(status.data?.createdAt)} title="Held for the owner's approval"
          detail={heldEvidence ? "An approval is recorded for this payout. Follow its current payment outcome separately." : "No held-payout evidence was recovered."}
          outsider={{ text: "No transaction: the provider holds the payment until it's approved." }}>
          {status.isPending && <Spinner />}
        </Moment>
        <Moment status={step(2)} when={time(proposal?.submittedAt)}
          title={dao ? "Proposal filed and voted" : rejected ? "Rejected by the owner's wallet" : approved ? "Approved by the owner's wallet" : "Owner wallet decision"}
          detail={proposal
            ? `Proposal #${proposal.id}: ${VOTE_WORDS[proposal.status] ?? proposal.status}, ${Object.keys(proposal.votes).length} vote${Object.keys(proposal.votes).length === 1 ? "" : "s"} so far.`
            : approved || rejected ? `The owner’s ${rejected ? "rejection" : "approval"} succeeded. The payment outcome is shown separately.`
              : approval && !expired ? "Prepared; waiting for a recorded vote." : "No proposal or wallet decision evidence was recovered."}
          outsider={dao
            ? proposal
              ? { text: `Proposal #${proposal.id} on ${dao}, worded "Approve the pending confidential request", naming the agent and this hash.`, value: approval?.hash }
              : { text: "No proposal was recovered by this view." }
            : { text: "No proposal: the owner's wallet signs a message, off chain." }}>

        </Moment>
        <Moment status={step(3)} when={null}
          title={rejected ? `Rejected by ${signer}` : "Approval signed and submitted"}
          detail={approved ? "The signature was checked against this approval's hash and sent to the provider." : rejected ? "The rejection was signed and submitted. Follow the payment outcome separately." : undefined}
          outsider={dao ? { text: "The MPC signature for that hash, returned by v1.signer." } : { text: "Unverified: whether anything public records the wallet's signature isn't checked here." }}>
          <span className="text-sm text-muted-foreground">Following the existing submission; do not sign again.</span>
        </Moment>
        <Moment status={step(4)} when={time(status.data?.updatedAt)} last
          title={failed ? `Provider reported ${s?.toLowerCase()}` : paid ? "Payment completed" : "Payment outcome"}
          detail={paid ? "The provider reports that this payment completed." : failed ? `The provider ended it as ${s?.toLowerCase()}${status.data?.failureCode && status.data.failureCode.toLowerCase() !== s?.toLowerCase() ? `: ${refusalText(status.data.failureCode)}` : ""}.` : undefined}
          outsider={{ text: "No public transfer was observed on the payout account in the documented 2026-10-11 run. This view does not independently verify public visibility for this payment." }}>
          <span className="text-sm text-muted-foreground">Waiting for a confirmed payment outcome. Review Activity before creating a replacement.</span>
        </Moment>
      </ol>
      </Details>
      <PaymentEvidence evidence={status.data?.evidence} loading={status.isPending} readFailed={status.isError} />
      <p className="text-xs text-muted-foreground">
        Operation <span className="font-mono break-all">{id}</span> · <Link to="/follow/payment" search={{ payment: id }} className="underline">Link to this payment</Link>
        {approval && <> · approval hash <span className="font-mono">{approval.hash.slice(0, 16)}…</span></>}
      </p>
    </Card>
  );
}

/**
 * The payout agent's payments: each one held shows its timeline, approved or rejected in place; the
 * newest settled one stays open beside them, and earlier ones open on demand.
 */
export function Payments({ title = "Payments", historyOpen = false }: { title?: string; historyOpen?: boolean }) {
  const { list, held, pending, activity, history, ownerActions } = usePayments(5_000);
  const [reviewed, setReviewed] = useState<string[]>([]);
  const selected = useSearch({ strict: false }).payment;
  if (selected && !list.some(([id]) => id === selected)) list.unshift([selected, { at: "" }]);
  const agreementQuery = useQuery(queries.agreements);
  const agreements = agreementQuery.isSuccess ? [...agreementQuery.data].reverse() : undefined;
  const heldIds = new Set((held.data ?? []).map((h) => h.correlationId));
  const open = list.filter(([id]) => heldIds.has(id) || reviewed.includes(id));
  const rest = list.filter(([id]) => !heldIds.has(id) && !reviewed.includes(id));
  // Shown open: every held payment, or else the newest one, so a payment just approved stays in view to Paid.
  const shown = selected ? list.filter(([id]) => id === selected) : open.length ? open : rest.slice(0, 1);
  const earlier = selected ? [] : open.length ? rest : rest.slice(1);
  return (
    <Section
      title={title}
      description="Review held payouts and retained payment outcomes. Owner approval and payment completion are shown separately; missing evidence is marked unverified."
    >
      {history.error && <QueryError error={history.error} retry={() => history.refetch()} />}
      {ownerActions.error && <QueryError error={ownerActions.error} retry={() => ownerActions.refetch()} />}
      {history.data && !history.data.complete && <p className="text-sm">Recent payment history is incomplete. Use a saved payment link or ask an operator to review older records.</p>}
      {held.error && <QueryError error={held.error} retry={() => held.refetch()} />}
      {pending.error && <QueryError error={pending.error} retry={() => pending.refetch()} />}
      {activity.error && <QueryError error={activity.error} retry={() => activity.refetch()} />}
      {agreementQuery.error && <QueryError error={agreementQuery.error} retry={() => agreementQuery.refetch()} />}
      {held.isPending || pending.isPending || history.isPending || ownerActions.isPending ? <Loading label="Checking payments and owner actions…" /> : !held.error && !pending.error && !history.error && history.data?.complete && !ownerActions.error && list.length === 0 && (
        <Card><p className="text-sm text-muted-foreground">Nothing waits for a vote. A payment appears here when a payee files an invoice. <Link to="/payees" className="underline">Review Agreements</Link>.</p></Card>
      )}
      {shown.map(([id, payment]) => <div key={id} onFocusCapture={() => setReviewed(ids => ids.includes(id) ? ids : [...ids, id])}><PaymentCard id={id} payment={payment} agreements={agreements} historyOpen={historyOpen} /></div>)}
      {earlier.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Earlier payments</h3>
          {earlier.map(([id, payment]) => (
            <Details key={id} summary={`${payment.request ? "A payment" : "A payment approved here"}, requested ${payment.at ? ago(payment.at) : "at an unknown time"}`}>
              <PaymentCard id={id} payment={payment} agreements={agreements} />
            </Details>
          ))}
        </div>
      )}
    </Section>
  );
}

/** "Follow this payment": the same list, full page, to link to. */
export function PaymentTimeline() {
  return <Payments title="Follow this payment" historyOpen />;
}
