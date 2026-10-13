import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import type { Decoded } from "../../src/gateway/proposals.js";
import { ago, client, describeRequest, gw, minutesSeconds, queries, useCountdown } from "./lib";
import { useNameOf, useSiblings } from "./names";
import { useOwnerAction, useSigner } from "./owner";
import { APPROVAL_WINDOW_MS } from "./held";
import { useAgent } from "./shell";
import { Button, Card, ErrorBox, input as inputClass, Section, Spinner } from "./ui";
import { refusalText } from "./words";

/**
 * "Follow this payment": one held payout as a timeline that doubles as its receipt. Each step reads its
 * own record: the held payout, the owner action that approves or rejects it (owner/pending names the
 * payment and the verdict), the DAO proposal with that action's hash, the action's outcome, and the
 * provider's status for the payment (`paymentStatus`, which works on an approve-only copy). Only payouts
 * that were held for the DAO are offered: a direct transfer has no vote to show. Members only.
 *
 * Each moment also says what anyone watching the chain could learn from it, as far as it has been
 * observed: the proposal and the MPC signature are public; the payout shows no public transfer.
 */

const TERMINAL = new Set(["SUCCESS", "FAILED", "REFUNDED"]);
type Status = "complete" | "current" | "upcoming" | "stopped";

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
    current: "border-brand bg-background ring-4 ring-brand-muted",
    upcoming: "border-border-strong bg-background",
    stopped: "border-destructive-muted-foreground bg-destructive-muted-foreground",
  }[status];
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-x-4 md:grid-cols-[1fr_2.5rem_1fr] md:gap-x-2">
      <div className="flex flex-col gap-1 pb-3 md:col-start-1 md:row-start-1 md:items-end md:pb-8 md:text-right col-start-2">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{reached ? (when ?? "") : "not yet"}</span>
        <h3 className={`font-heading text-base font-medium text-balance ${reached ? "" : "text-muted-foreground"}`}>{title}</h3>
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
        <p className="text-muted-foreground"><span className="md:hidden">On chain: </span>{reached ? outsider.text : "Nothing yet."}</p>
        {reached && outsider.value && <p className="mt-1 font-mono text-xs break-all">{outsider.value}</p>}
      </div>
    </li>
  );
}

export function PaymentTimeline() {
  const { data, setup } = useAgent();
  const nameOf = useNameOf();
  const { self } = useSiblings();
  const [picked, setPicked] = useState<string>();
  const [settled, setSettled] = useState(false);
  const poll = settled ? false : 5_000;
  const held = useQuery(queries.held);
  const pending = useQuery({ queryKey: ["owner", "pending"], queryFn: () => client.owner.pending(), refetchInterval: poll });
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => client.activity() });
  // The proposals of the DAO that owns this agent, when one does: an owner account files none.
  const dao = self?.dao ? self.owner : undefined;
  const proposals = useQuery({ queryKey: ["gw", "proposals", dao], queryFn: () => gw<Decoded[]>(`/gw/proposals?dao=${encodeURIComponent(dao!)}`),
    enabled: Boolean(dao), refetchInterval: settled ? false : 10_000 });
  const action = useOwnerAction(setup);
  const { canSign } = useSigner(setup);

  // Payouts held for the DAO, newest first: still waiting (held), or named by an approval this server filed.
  const known = new Map<string, { at: string; request: Record<string, unknown>; approvalId?: string }>();
  const sent = new Map((activity.data ?? []).filter((op) => op.correlationId).map((op) => [op.correlationId!, op]));
  for (const p of pending.data ?? []) {
    const op = p.payment && sent.get(p.payment.correlationId);
    if (op) known.set(op.correlationId!, { at: op.at, request: op.request });
  }
  for (const h of held.data ?? []) known.set(h.correlationId, { at: h.at, request: h.request, approvalId: h.approvalId });
  const choices = [...known].sort(([, a], [, b]) => b.at.localeCompare(a.at));
  const id = picked ?? choices[0]?.[0];
  const payment = id ? known.get(id) : undefined;

  // The first read answers at once; each later one waits at the provider until the payment moves (up to
  // 25 s) and is asked again as soon as it answers: news arrives at once, in about 2 calls a minute. The
  // provider holds at most 10 waits per API key and answers the rest at once, so a wait that came back
  // quickly without the payment finishing is followed by a 4 s pause instead of an immediate retry.
  const seen = useRef<string | undefined>(undefined);
  const quick = useRef(false);
  const status = useQuery({
    queryKey: ["paymentStatus", id],
    queryFn: async () => {
      const waited = seen.current === id;
      const started = Date.now();
      const result = await client.paymentStatus({ correlationId: id!, ...(waited && { waitMs: 25_000 }) });
      quick.current = waited && Date.now() - started < 5_000;
      seen.current = id;
      return result;
    },
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.status) ? false : quick.current ? 4_000 : 500),
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

  if (held.error || activity.error) return <ErrorBox error={(held.error ?? activity.error)!.message} />;
  if (!held.data || !activity.data) return <Spinner />;
  if (!id || !payment)
    return <Section title="Follow this payment" description="No payment held for the DAO yet. One appears here when a payee files an invoice."><span /></Section>;

  const s = status.data?.status;
  const paid = s === "SUCCESS";
  const failed = s === "FAILED" || s === "REFUNDED";
  const isHeld = s === "PENDING_APPROVAL";
  const voted = vote.data?.stage === "submitted" ? vote.data : null;
  const outcome = voted && "status" in voted ? voted.status : undefined;
  const approved = outcome === "SUCCESS" && approval?.payment?.verdict === "approve";
  const rejected = outcome === "SUCCESS" && approval?.payment?.verdict === "reject";
  const expired = outcome === "EXPIRED" || approval?.state === "expired";
  const final = paid || failed || rejected;
  if (final !== settled) setSettled(final);
  // Where the payment is, as one moment: reading its status, the vote (asked or not), settling after the
  // approval, or done. Earlier moments are complete, later ones upcoming; a rejection or failure stops it.
  const at = !s ? 1 : final ? 5 : approved ? 4 : 2;
  const stoppedAt = rejected ? 3 : failed ? 4 : -1;
  const step = (index: number): Status => (index === stoppedAt ? "stopped" : stoppedAt >= 0 && index > stoppedAt ? "upcoming" : index < at ? "complete" : index === at ? "current" : "upcoming");
  const VOTE_WORDS: Record<string, string> = { InProgress: "voting", Approved: "approved", Rejected: "rejected", Removed: "removed", Expired: "expired" };
  const approvable = isHeld && !approved && !rejected && (!approval || expired) && Date.now() < Date.parse(payment.at) + APPROVAL_WINDOW_MS;
  const approve = () =>
    payment.approvalId && action.run({ type: "approval_vote", approvalId: payment.approvalId, verdict: "approve", correlationId: id });

  const signer = dao ?? "the owner";
  const verdict = paid ? "Paid" : failed ? "Not paid" : rejected ? "Rejected, not paid" : approved ? "Approved, settling" : expired && isHeld ? "Window closed" : isHeld ? "Waiting for the DAO" : "Reading…";

  return (
    <Section
      title="Follow this payment"
      description="One held payment from invoice to paid. Each moment is read from its own record, beside what anyone watching the chain could learn from it."
      action={
        choices.length > 1 && (
          <select className={`${inputClass} pr-8`} value={id} onChange={(e) => { setPicked(e.target.value); setSettled(false); }} aria-label="Payment to follow">
            {choices.map(([cid, p]) => (
              <option key={cid} value={cid}>
                {describeRequest(p.request, data.book, nameOf)} · {ago(p.at)}
              </option>
            ))}
          </select>
        )
      }
    >
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b pb-5">
          <p className="font-heading text-2xl font-semibold tracking-tight">{describeRequest(payment.request, data.book, nameOf)}</p>
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${
            paid ? "bg-success-muted text-success-muted-foreground"
              : failed || rejected ? "bg-destructive-muted text-destructive-muted-foreground"
                : expired && isHeld ? "bg-warning-muted text-warning-muted-foreground"
                  : "bg-brand-muted text-brand-strong"}`}>{verdict}</span>
        </div>
        <div className="hidden grid-cols-[1fr_2.5rem_1fr] gap-x-2 text-sm text-muted-foreground md:grid">
          <p className="text-right"><span className="block font-heading text-base font-medium text-foreground">What members see</span>Signed in to this dashboard</p>
          <span />
          <p><span className="block font-heading text-base font-medium text-foreground">What anyone on chain sees</span>No amount, payee or invoice, in what we've checked</p>
        </div>
        <ol>
          <Moment status="complete" when={time(payment.at)} title="Invoice filed"
            detail={`${describeRequest(payment.request, data.book, nameOf)}, filed ${new Date(payment.at).toLocaleString()}.`}
            outsider={{ text: "Nothing: the invoice stays with the invoice host." }} />
          <Moment status={step(1)} when={time(status.data?.createdAt)} title="Held for the owner's approval"
            detail={s ? "The payout agent sent it and the provider holds it until the owner approves. The executor alerts the owner on Telegram." : "Reading the payment's status…"}
            outsider={{ text: "No transaction: the provider holds the payment until it's approved." }}>
            {!s && <Spinner />}
          </Moment>
          <Moment status={step(2)} when={time(proposal?.submittedAt)}
            title={dao ? "Proposal filed and voted" : "Approved by the owner's wallet"}
            detail={proposal
              ? `Proposal #${proposal.id}: ${VOTE_WORDS[proposal.status] ?? proposal.status}, ${Object.keys(proposal.votes).length} vote${Object.keys(proposal.votes).length === 1 ? "" : "s"} so far.`
              : approval && !expired ? "Filed; waiting for the vote." : `Nobody has asked ${dao ? "the DAO" : "the owner"} to approve it yet.`}
            outsider={dao
              ? proposal
                ? { text: `Proposal #${proposal.id} on ${dao}, worded "Approve the pending confidential request", naming the agent and this hash.`, value: approval?.hash }
                : { text: "Nothing yet: no proposal is filed." }
              : { text: "No proposal: the owner's wallet signs a message, off chain." }}>
            <div className="flex flex-col gap-2 text-sm md:items-end">
              {windowLeft !== null && !expired && (
                <span className="font-mono text-brand-strong tabular-nums">Signing window {minutesSeconds(windowLeft)} left</span>
              )}
              {expired && <span className="text-warning-muted-foreground">The last approval's signing window closed before it was used. File it again.</span>}
              {approvable && payment.approvalId && (
                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  <span className="text-muted-foreground">
                    {!canSign
                      ? "Only an account that can sign for the owner can approve."
                      : (action.label ?? (dao ? "Files the approval as a proposal; the DAO then has 5 to 10 minutes to vote." : "Your wallet signs the approval."))}
                  </span>
                  <Button size="sm" disabled={action.busy || !canSign} onClick={approve}>
                    {action.busy ? <Spinner /> : expired ? "File the approval again" : "Approve payment"}
                  </Button>
                </div>
              )}
              <ErrorBox error={action.error} />
            </div>
          </Moment>
          <Moment status={step(3)} when={null}
            title={rejected ? `Rejected by ${signer}` : "Approval signed and submitted"}
            detail={approved ? "The signature was checked against this approval's hash and sent to the provider." : rejected ? "The rejection was signed and submitted; nothing is paid." : undefined}
            outsider={dao ? { text: "The MPC signature for that hash, returned by v1.signer." } : { text: "Unverified: whether anything public records the wallet's signature isn't checked here." }}>
            <span className="text-sm text-muted-foreground">The server picks up the signature once the vote passes…</span>
          </Moment>
          <Moment status={step(4)} when={time(status.data?.updatedAt)} last
            title={failed ? "Not paid" : rejected ? "Not paid" : "Paid, privately"}
            detail={paid ? "Settled from the confidential balance." : failed ? `The provider ended it as ${s?.toLowerCase()}${status.data?.failureCode && status.data.failureCode.toLowerCase() !== s?.toLowerCase() ? `: ${refusalText(status.data.failureCode)}` : ""}.` : undefined}
            outsider={{ text: "No public transfer on the payout account (observed 2026-10-11). Unverified: what the confidential ledger records, which nothing public indexes." }}>
            <span className="text-sm text-muted-foreground">Releasing and settling, usually a minute or two…</span>
          </Moment>
        </ol>
      </Card>
      <p className="text-xs text-muted-foreground">
        Operation <span className="font-mono">{id}</span>
        {approval && <> · approval hash <span className="font-mono">{approval.hash.slice(0, 16)}…</span></>}
      </p>
    </Section>
  );
}
